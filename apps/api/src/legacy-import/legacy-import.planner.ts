import { createHmac } from 'node:crypto';
import {
  LEGACY_IMPORT_MAX_ROWS, LEGACY_IMPORT_PROJECTION_VERSION,
  type CurrentLegacyCredentialVersion, type LegacyAppBinding, type LegacyAssetKind,
  type LegacyCredentialDisposition, type LegacyEnvironment, type LegacyExpiryObservation,
  type LegacyImportContext, type LegacyImportItemState, type LegacyImportPlan,
  type LegacyImportPlanItem, type LegacyImportReasonCode, type LegacyInventorySnapshot,
  type LegacyNumberRow, type LegacyPageRow, type LegacyTenantMapping, type LegacyCredentialVersionFence,
} from './legacy-import.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CATALOG = /^[a-z][a-z0-9_-]{0,63}$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

type SourceTable = LegacyImportPlanItem['sourceTable'];

interface SourceDraft {
  readonly sourceTable: SourceTable;
  readonly legacyRowId: string;
  readonly legacyDatabaseId: string;
  readonly legacyCompanyId: string;
  readonly sourceIdentityCanonical: string;
  readonly sourceCanonical: string;
  readonly sourceType?: string;
  readonly externalId: string;
  readonly legacyWabaRowId?: string;
  readonly userCredentialPresent?: boolean;
  readonly pageCredentialPresent?: boolean;
  readonly userExpiresAt?: string | null;
  readonly pageExpiresAt?: string | null;
}

export class LegacyImportInputError extends Error {
  constructor() {
    super('Legacy import input is invalid or contains fields outside the sanitized contract.');
    this.name = 'LegacyImportInputError';
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new LegacyImportInputError();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  if (Object.keys(value).some((key) => !expected.has(key)) || keys.some((key) => !(key in value))) {
    throw new LegacyImportInputError();
  }
}

function stringValue(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

function boundedRawString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4_096;
}

function isEnvironment(value: unknown): value is LegacyEnvironment {
  return value === 'development' || value === 'test' || value === 'staging' || value === 'production';
}

function parseTenantMapping(value: unknown): LegacyTenantMapping {
  const item = record(value);
  exactKeys(item, ['tenantId', 'legacyDatabaseId', 'legacyCompanyId', 'environment']);
  if (typeof item.tenantId !== 'string' || !UUID.test(item.tenantId) ||
      !stringValue(item.legacyDatabaseId, 128) || !/^[\x20-\x7e]+$/.test(item.legacyDatabaseId) ||
      !stringValue(item.legacyCompanyId, 191) || !isEnvironment(item.environment)) throw new LegacyImportInputError();
  return item as unknown as LegacyTenantMapping;
}

function parseAppBinding(value: unknown): LegacyAppBinding {
  const item = record(value);
  exactKeys(item, ['tenantId', 'appConfigurationId', 'environment']);
  if (typeof item.tenantId !== 'string' || !UUID.test(item.tenantId) ||
      typeof item.appConfigurationId !== 'string' || !UUID.test(item.appConfigurationId) || !isEnvironment(item.environment)) {
    throw new LegacyImportInputError();
  }
  return item as unknown as LegacyAppBinding;
}

function parsePage(value: unknown): LegacyPageRow {
  const item = record(value);
  exactKeys(item, ['legacyRowId', 'legacyDatabaseId', 'legacyCompanyId', 'sourceType', 'externalId',
    'userCredentialPresent', 'pageCredentialPresent', 'userExpiresAt', 'pageExpiresAt', 'parentChannelId']);
  if (!boundedRawString(item.legacyRowId) || !boundedRawString(item.legacyDatabaseId) ||
      !boundedRawString(item.legacyCompanyId) || !boundedRawString(item.sourceType) || !boundedRawString(item.externalId) ||
      typeof item.userCredentialPresent !== 'boolean' || typeof item.pageCredentialPresent !== 'boolean' ||
      !(item.userExpiresAt === null || boundedRawString(item.userExpiresAt)) ||
      !(item.pageExpiresAt === null || boundedRawString(item.pageExpiresAt)) ||
      !(item.parentChannelId === null || boundedRawString(item.parentChannelId))) throw new LegacyImportInputError();
  return item as unknown as LegacyPageRow;
}

function parseNumber(value: unknown): LegacyNumberRow {
  const item = record(value);
  exactKeys(item, ['legacyRowId', 'legacyDatabaseId', 'legacyCompanyId', 'legacyWabaRowId', 'externalId']);
  if (!boundedRawString(item.legacyRowId) || !boundedRawString(item.legacyDatabaseId) ||
      !boundedRawString(item.legacyCompanyId) || !boundedRawString(item.legacyWabaRowId) ||
      !boundedRawString(item.externalId)) throw new LegacyImportInputError();
  return item as unknown as LegacyNumberRow;
}

/** Runtime parser rejects unrecognized fields (including raw credentials) before planning. */
export function parseLegacyInventorySnapshot(value: unknown): LegacyInventorySnapshot {
  const snapshot = record(value);
  exactKeys(snapshot, ['catalogRef', 'environment', 'sourceVersion', 'tenantMappings', 'appBindings', 'pages', 'numbers']);
  if (!stringValue(snapshot.catalogRef, 64) || !SAFE_CATALOG.test(snapshot.catalogRef) ||
      !isEnvironment(snapshot.environment) || !stringValue(snapshot.sourceVersion, 128) || !SAFE_REF.test(snapshot.sourceVersion) ||
      !Array.isArray(snapshot.tenantMappings) || !Array.isArray(snapshot.appBindings) ||
      !Array.isArray(snapshot.pages) || !Array.isArray(snapshot.numbers) ||
      snapshot.tenantMappings.length > LEGACY_IMPORT_MAX_ROWS || snapshot.appBindings.length > LEGACY_IMPORT_MAX_ROWS ||
      snapshot.pages.length + snapshot.numbers.length > LEGACY_IMPORT_MAX_ROWS) throw new LegacyImportInputError();
  return {
    catalogRef: snapshot.catalogRef,
    environment: snapshot.environment,
    sourceVersion: snapshot.sourceVersion,
    tenantMappings: snapshot.tenantMappings.map(parseTenantMapping),
    appBindings: snapshot.appBindings.map(parseAppBinding),
    pages: snapshot.pages.map(parsePage),
    numbers: snapshot.numbers.map(parseNumber),
  };
}

function validDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function deterministicUuid(digest: string): string {
  if (!validDigest(digest)) throw new LegacyImportInputError();
  const bytes = Buffer.from(digest, 'hex').subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function pairKey(databaseId: string, companyId: string, environment: string): string {
  return `${databaseId}\u0000${companyId}\u0000${environment}`;
}

function targetKey(tenantId: string, appConfigurationId: string, environment: string, kind: LegacyAssetKind, externalId: string): string {
  return `${tenantId}\u0000${appConfigurationId}\u0000${environment}\u0000META\u0000${kind}\u0000${externalId}`;
}

function mapKind(sourceType: string): LegacyAssetKind | null {
  if (sourceType === 'FACEBOOK') return 'FACEBOOK_PAGE';
  if (sourceType === 'WHATSAPP') return 'WHATSAPP_BUSINESS_ACCOUNT';
  // The source literal INSTAGRAM does not distinguish business from creator accounts.
  return null;
}

function expiryObservation(value: string | null): LegacyExpiryObservation {
  if (value === null || value.trim().toLowerCase() === 'never') return 'UNKNOWN';
  if (!ISO_WITH_ZONE.test(value)) return 'INVALID';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? 'OBSERVED_DATE' : 'INVALID';
}

function pageExpiry(row: LegacyPageRow): LegacyExpiryObservation {
  const observations = [
    ...(row.userCredentialPresent ? [expiryObservation(row.userExpiresAt)] : []),
    ...(row.pageCredentialPresent ? [expiryObservation(row.pageExpiresAt)] : []),
  ];
  if (observations.includes('INVALID')) return 'INVALID';
  if (observations.includes('OBSERVED_DATE')) return 'OBSERVED_DATE';
  return 'UNKNOWN';
}

function makeDrafts(snapshot: LegacyInventorySnapshot): SourceDraft[] {
  const drafts: SourceDraft[] = [];
  for (const row of snapshot.pages) {
    drafts.push({
      sourceTable: 'MetaConnectedPages', legacyRowId: row.legacyRowId,
      legacyDatabaseId: row.legacyDatabaseId, legacyCompanyId: row.legacyCompanyId,
      sourceType: row.sourceType, externalId: row.externalId,
      userCredentialPresent: row.userCredentialPresent, pageCredentialPresent: row.pageCredentialPresent,
      userExpiresAt: row.userExpiresAt, pageExpiresAt: row.pageExpiresAt,
      sourceIdentityCanonical: JSON.stringify(['MetaConnectedPages', row.legacyDatabaseId, row.legacyCompanyId, row.legacyRowId]),
      sourceCanonical: JSON.stringify(['MetaConnectedPages', row.legacyRowId, row.legacyDatabaseId, row.legacyCompanyId,
        row.sourceType, row.externalId, row.userCredentialPresent, row.pageCredentialPresent,
        row.userExpiresAt, row.pageExpiresAt, row.parentChannelId]),
    });
  }
  for (const row of snapshot.numbers) {
    drafts.push({
      sourceTable: 'MetaConnectedNumbers', legacyRowId: row.legacyRowId,
      legacyDatabaseId: row.legacyDatabaseId, legacyCompanyId: row.legacyCompanyId,
      externalId: row.externalId, legacyWabaRowId: row.legacyWabaRowId,
      sourceIdentityCanonical: JSON.stringify(['MetaConnectedNumbers', row.legacyDatabaseId, row.legacyCompanyId, row.legacyRowId]),
      sourceCanonical: JSON.stringify(['MetaConnectedNumbers', row.legacyRowId, row.legacyDatabaseId,
        row.legacyCompanyId, row.legacyWabaRowId, row.externalId]),
    });
  }
  return drafts;
}

function rowReason(draft: SourceDraft, snapshot: LegacyInventorySnapshot,
  tenantMappings: Map<string, LegacyTenantMapping[]>, appBindings: Map<string, LegacyAppBinding[]>): LegacyImportReasonCode | null {
  if (!stringValue(draft.legacyRowId, 512)) return 'INVALID_SOURCE_ROW_ID';
  const mappings = tenantMappings.get(pairKey(draft.legacyDatabaseId, draft.legacyCompanyId, snapshot.environment)) ?? [];
  if (mappings.length === 0) return 'TENANT_MAPPING_MISSING';
  if (mappings.length !== 1) return 'TENANT_MAPPING_AMBIGUOUS';
  const apps = appBindings.get(`${mappings[0]!.tenantId}\u0000${snapshot.environment}`) ?? [];
  if (apps.length === 0) return 'APP_CONFIGURATION_MISSING';
  if (apps.length !== 1) return 'APP_CONFIGURATION_AMBIGUOUS';
  if (!stringValue(draft.externalId, 512)) return 'INVALID_EXTERNAL_ID';
  if (draft.sourceTable === 'MetaConnectedPages' && !mapKind(draft.sourceType ?? '')) return 'UNSUPPORTED_SOURCE_KIND';
  return null;
}

function normalizeReasonForNumber(draft: SourceDraft, snapshot: LegacyInventorySnapshot,
  pagesByLegacyRow: Map<string, LegacyPageRow[]>, tenantMappings: Map<string, LegacyTenantMapping[]>): LegacyImportReasonCode | null {
  if (draft.sourceTable !== 'MetaConnectedNumbers') return null;
  const mapping = tenantMappings.get(pairKey(draft.legacyDatabaseId, draft.legacyCompanyId, snapshot.environment))?.[0];
  const pageCandidates = snapshot.pages.filter((page) => page.legacyRowId === draft.legacyWabaRowId);
  if (pageCandidates.length === 0) return 'WHATSAPP_PARENT_MISSING';
  const exactTenantParents = pageCandidates.filter((page) => page.legacyDatabaseId === draft.legacyDatabaseId &&
    page.legacyCompanyId === draft.legacyCompanyId && page.sourceType === 'WHATSAPP');
  if (exactTenantParents.length > 1) return 'WHATSAPP_PARENT_AMBIGUOUS';
  if (exactTenantParents.length === 0) {
    const crossTenant = pageCandidates.some((page) => page.legacyDatabaseId !== draft.legacyDatabaseId ||
      page.legacyCompanyId !== draft.legacyCompanyId ||
      tenantMappings.get(pairKey(page.legacyDatabaseId, page.legacyCompanyId, snapshot.environment))?.[0]?.tenantId !== mapping?.tenantId);
    return crossTenant ? 'WHATSAPP_PARENT_CROSS_TENANT' : 'WHATSAPP_PARENT_MISSING';
  }
  const parent = exactTenantParents[0]!;
  if (!stringValue(parent.externalId, 512)) return 'WHATSAPP_PARENT_MISSING';
  const duplicateParentIdentity = snapshot.pages.filter((page) => page.legacyDatabaseId === parent.legacyDatabaseId &&
    page.legacyCompanyId === parent.legacyCompanyId && page.sourceType === 'WHATSAPP' && page.externalId === parent.externalId).length > 1;
  if (duplicateParentIdentity) return 'WHATSAPP_PARENT_AMBIGUOUS';
  const parentMapping = tenantMappings.get(pairKey(parent.legacyDatabaseId, parent.legacyCompanyId, snapshot.environment)) ?? [];
  if (parentMapping.length !== 1) return parentMapping.length === 0 ? 'TENANT_MAPPING_MISSING' : 'TENANT_MAPPING_AMBIGUOUS';
  if (!mapping || mapping.tenantId !== parentMapping[0]!.tenantId) return 'WHATSAPP_PARENT_CROSS_TENANT';
  if (!pagesByLegacyRow.has(`${draft.legacyDatabaseId}\u0000${draft.legacyCompanyId}\u0000${draft.legacyWabaRowId}`)) {
    return 'WHATSAPP_PARENT_MISSING';
  }
  return null;
}

/** Builds a synthetic/read-only plan. No source adapter or target storage is invoked here. */
export function planLegacyImport(input: unknown, context: LegacyImportContext): LegacyImportPlan {
  const snapshot = parseLegacyInventorySnapshot(input);
  if (!context.allowedCatalogRefs.has(snapshot.catalogRef) || !context.hasher ||
      (context.projectionVersion !== undefined &&
        (!stringValue(context.projectionVersion, 64) || !SAFE_REF.test(context.projectionVersion)))) {
    throw new LegacyImportInputError();
  }
  const projectionVersion = context.projectionVersion ?? LEGACY_IMPORT_PROJECTION_VERSION;
  const digest = (value: string): string => {
    const result = context.hasher.digest(value);
    if (!validDigest(result)) throw new LegacyImportInputError();
    return result;
  };

  const snapshotHash = digest(JSON.stringify([snapshot.catalogRef, snapshot.environment, snapshot.sourceVersion,
    snapshot.tenantMappings.map((row) => [row.tenantId, row.legacyDatabaseId, row.legacyCompanyId, row.environment]).sort(),
    snapshot.appBindings.map((row) => [row.tenantId, row.appConfigurationId, row.environment]).sort(),
    makeDrafts(snapshot).map((row) => row.sourceCanonical).sort()]));
  const batchId = deterministicUuid(digest(`legacy-import-batch\u0000${snapshotHash}\u0000${projectionVersion}`));

  const tenantMappings = new Map<string, LegacyTenantMapping[]>();
  for (const mapping of snapshot.tenantMappings) {
    const key = pairKey(mapping.legacyDatabaseId, mapping.legacyCompanyId, mapping.environment);
    const entries = tenantMappings.get(key) ?? [];
    entries.push(mapping);
    tenantMappings.set(key, entries);
  }
  const appBindings = new Map<string, LegacyAppBinding[]>();
  for (const binding of snapshot.appBindings) {
    const key = `${binding.tenantId}\u0000${binding.environment}`;
    const entries = appBindings.get(key) ?? [];
    entries.push(binding);
    appBindings.set(key, entries);
  }

  const drafts = makeDrafts(snapshot).sort((left, right) => left.sourceIdentityCanonical.localeCompare(right.sourceIdentityCanonical) ||
    left.sourceCanonical.localeCompare(right.sourceCanonical));
  const repeated = new Map<string, number>();
  const sourceIdentityCounts = new Map<string, number>();
  for (const draft of drafts) {
    sourceIdentityCounts.set(draft.sourceIdentityCanonical, (sourceIdentityCounts.get(draft.sourceIdentityCanonical) ?? 0) + 1);
  }
  const pageRowsByKey = new Map<string, LegacyPageRow[]>();
  for (const page of snapshot.pages) {
    const key = `${page.legacyDatabaseId}\u0000${page.legacyCompanyId}\u0000${page.legacyRowId}`;
    const rows = pageRowsByKey.get(key) ?? [];
    rows.push(page);
    pageRowsByKey.set(key, rows);
  }
  const sourceRowCounts = new Map<string, number>();
  for (const draft of drafts) {
    const key = `${draft.sourceTable}\u0000${draft.legacyDatabaseId}\u0000${draft.legacyCompanyId}\u0000${draft.legacyRowId}`;
    sourceRowCounts.set(key, (sourceRowCounts.get(key) ?? 0) + 1);
  }

  const preliminary: Array<Omit<LegacyImportPlanItem, 'sequence'>> = drafts.map((draft) => {
    const occurrence = repeated.get(draft.sourceIdentityCanonical) ?? 0;
    repeated.set(draft.sourceIdentityCanonical, occurrence + 1);
    const sourceRecordHash = digest((sourceIdentityCounts.get(draft.sourceIdentityCanonical) ?? 0) > 1
      ? `${draft.sourceIdentityCanonical}\u0000${occurrence}` : draft.sourceIdentityCanonical);
    const sourcePayloadHash = digest(draft.sourceCanonical);
    const mappingEntries = tenantMappings.get(pairKey(draft.legacyDatabaseId, draft.legacyCompanyId, snapshot.environment)) ?? [];
    const tenantId = mappingEntries.length === 1 ? mappingEntries[0]!.tenantId : null;
    const appEntries = tenantId === null ? [] : appBindings.get(`${tenantId}\u0000${snapshot.environment}`) ?? [];
    const appConfigurationId = appEntries.length === 1 ? appEntries[0]!.appConfigurationId : null;
    const assetKind = draft.sourceTable === 'MetaConnectedPages'
      ? mapKind(draft.sourceType ?? '')
      : 'WHATSAPP_PHONE_NUMBER';
    const pageReason = rowReason(draft, snapshot, tenantMappings, appBindings);
    const parentReason = normalizeReasonForNumber(draft, snapshot, pageRowsByKey, tenantMappings);
    const duplicateKey = `${draft.sourceTable}\u0000${draft.legacyDatabaseId}\u0000${draft.legacyCompanyId}\u0000${draft.legacyRowId}`;
    const duplicateSource = (sourceRowCounts.get(duplicateKey) ?? 0) > 1;
    const baseReason = duplicateSource ? 'DUPLICATE_SOURCE_ROW' : (pageReason ?? parentReason);
    const state: LegacyImportItemState = baseReason === null ? 'METADATA_ONLY_CANDIDATE' : 'QUARANTINED';
    const credential: LegacyCredentialDisposition = draft.sourceTable === 'MetaConnectedPages' &&
      (draft.userCredentialPresent === true || draft.pageCredentialPresent === true) ? 'REQUIRES_REAUTH' : 'ABSENT';
    const expiry = draft.sourceTable === 'MetaConnectedPages'
      ? pageExpiry({
        legacyRowId: draft.legacyRowId, legacyDatabaseId: draft.legacyDatabaseId, legacyCompanyId: draft.legacyCompanyId,
        sourceType: draft.sourceType ?? '', externalId: draft.externalId,
        userCredentialPresent: draft.userCredentialPresent ?? false, pageCredentialPresent: draft.pageCredentialPresent ?? false,
        userExpiresAt: draft.userExpiresAt ?? null, pageExpiresAt: draft.pageExpiresAt ?? null, parentChannelId: null,
      })
      : 'UNKNOWN';
    const targetAssetId = state === 'METADATA_ONLY_CANDIDATE' && tenantId !== null && appConfigurationId !== null && assetKind !== null
      ? deterministicUuid(digest(`legacy-asset\u0000${sourceRecordHash}\u0000${tenantId}\u0000${appConfigurationId}\u0000${assetKind}`))
      : null;
    return {
      batchId, sourceRecordHash, sourcePayloadHash, sourceTable: draft.sourceTable, legacyRowId: draft.legacyRowId,
      legacyDatabaseId: draft.legacyDatabaseId, legacyCompanyId: draft.legacyCompanyId,
      tenantId, appConfigurationId, environment: snapshot.environment,
      assetKind, externalId: draft.externalId, deterministicAssetId: targetAssetId,
      state, reasonCode: baseReason ?? (credential === 'REQUIRES_REAUTH' ? 'CREDENTIAL_REQUIRES_REAUTH' : null),
      credentialDisposition: credential, expiryObservation: expiry,
    };
  });

  // Quarantine all duplicate target identities; never pick a winner by row order or latest login.
  const targetGroups = new Map<string, number[]>();
  preliminary.forEach((item, index) => {
    if (item.state !== 'METADATA_ONLY_CANDIDATE' || !item.tenantId || !item.appConfigurationId || !item.assetKind || !item.externalId) return;
    const key = targetKey(item.tenantId, item.appConfigurationId, item.environment, item.assetKind, item.externalId);
    const indices = targetGroups.get(key) ?? [];
    indices.push(index);
    targetGroups.set(key, indices);
  });
  for (const indices of targetGroups.values()) {
    if (indices.length < 2) continue;
    for (const index of indices) {
      const item = preliminary[index]!;
      preliminary[index] = { ...item, state: 'QUARANTINED', reasonCode: 'DUPLICATE_TARGET_ASSET', deterministicAssetId: null };
    }
  }

  const items: LegacyImportPlanItem[] = preliminary.map((item, index) => ({ ...item, sequence: index + 1 }));
  const report = {
    mode: 'DRY_RUN' as const,
    batchId,
    sourceSnapshotHash: snapshotHash,
    sourceVersion: snapshot.sourceVersion,
    projectionVersion,
    totalRows: items.length,
    candidateCount: items.filter((item) => item.state === 'METADATA_ONLY_CANDIDATE').length,
    quarantinedCount: items.filter((item) => item.state === 'QUARANTINED').length,
    credentialReauthCount: items.filter((item) => item.credentialDisposition === 'REQUIRES_REAUTH').length,
    generalSettingsDisposition: 'NOT_READ_SCHEMA_NOT_CONFIRMED' as const,
    items: items.map((item) => ({
      sequence: item.sequence,
      sourceRecordHash: item.sourceRecordHash,
      state: item.state,
      reasonCode: item.reasonCode,
      tenantRef: item.tenantId,
      targetAssetRef: item.deterministicAssetId,
      credentialDisposition: item.credentialDisposition,
      expiryObservation: item.expiryObservation,
    })),
  };
  return { batchId, sourceVersion: snapshot.sourceVersion, projectionVersion, checkpointSequence: 0, items, report };
}

/** Every target write must compare all versions under the same transaction as the ledger checkpoint. */
export function credentialImportFenceMatches(expected: LegacyCredentialVersionFence, current: CurrentLegacyCredentialVersion): boolean {
  return Number.isSafeInteger(expected.expectedCredentialVersion) && expected.expectedCredentialVersion >= 0 &&
    Number.isSafeInteger(expected.expectedSecretVersion) && expected.expectedSecretVersion >= 0 &&
    Number.isSafeInteger(expected.expectedReauthorizationGeneration) && expected.expectedReauthorizationGeneration >= 0 &&
    current.credentialVersion === expected.expectedCredentialVersion &&
    current.secretVersion === expected.expectedSecretVersion &&
    current.reauthorizationGeneration === expected.expectedReauthorizationGeneration;
}

/** A metadata-only dry-run never has a credential capability to pass to the vault. */
export function legacyCredentialImportAllowed(input: {
  readonly credentialPresent: boolean;
  readonly grantEvidenceConfirmed: boolean;
  readonly authorizedBatch: boolean;
  readonly versionsMatch: boolean;
}): boolean {
  return input.credentialPresent && input.grantEvidenceConfirmed && input.authorizedBatch && input.versionsMatch;
}

/** Helper for synthetic tests and local fixture CLI; production supplies the HMAC key externally. */
export function createLegacyImportReferenceHasher(key: Buffer): { digest(value: string): string } {
  if (key.length < 32) throw new LegacyImportInputError();
  const secret = Buffer.from(key);
  return {
    digest(value: string): string {
      return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
    },
  };
}
