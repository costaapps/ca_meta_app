import { isMetaAssetKind, type EvidenceSource, type MetaAssetKind, type ProjectionState, type SubscriptionState } from './meta-assets.types.js';

export const ASSET_OBSERVATION_SCHEMA_VERSION = 1;
export const ASSET_OBSERVATION_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export type ObservedAssetStatus = 'ACTIVE' | 'INACTIVE' | 'UNKNOWN' | 'UNAVAILABLE';
export type ObservationAvailability = 'OBSERVED' | 'MISSING' | 'UNKNOWN' | 'UNAVAILABLE';
export type PermissionAvailability = 'OBSERVED' | 'UNKNOWN' | 'UNAVAILABLE';
export type AssetDriftCode = 'ASSET_STATUS_CHANGED' | 'PERMISSIONS_CHANGED' | 'SUBSCRIPTION_CHANGED' | 'PROJECTION_STALE';

/** Only dimensions represented by the current normalized catalog and subscription contracts are admitted. */
export interface AssetObservationInput {
  readonly kind: MetaAssetKind;
  readonly source: EvidenceSource;
  /** Provider event/observation time. Null is used only when a request could not observe provider state. */
  readonly observedAt: string | null;
  readonly status: {
    readonly value: ObservedAssetStatus;
    readonly availability: ObservationAvailability;
    /** A bounded enum token only; never a provider payload or error message. */
    readonly providerCode?: string;
  };
  readonly permissions: {
    readonly availability: PermissionAvailability;
    readonly grantNames?: readonly string[];
  };
  readonly subscriptionState?: SubscriptionState;
  readonly projectionState?: ProjectionState;
}

export interface AssetObservationSnapshot {
  readonly schemaVersion: 1;
  readonly version: number;
  readonly authorizationRef: string;
  readonly kind: MetaAssetKind;
  readonly source: EvidenceSource;
  readonly observedAt: string | null;
  readonly fetchedAt: string;
  readonly staleAfter: string;
  readonly status: {
    readonly value: Exclude<ObservedAssetStatus, 'UNAVAILABLE'>;
    readonly availability: ObservationAvailability;
    readonly observedAt: string | null;
    readonly providerCode: string | null;
  };
  readonly permissions: {
    readonly availability: PermissionAvailability;
    readonly grantNames: readonly string[] | null;
    readonly observedAt: string | null;
  };
  readonly subscriptionState: SubscriptionState;
  readonly projectionState: ProjectionState;
  readonly driftCodes: readonly AssetDriftCode[];
}

export interface PublicAssetStatusObservation {
  readonly status: 'ACTIVE' | 'INACTIVE' | 'UNKNOWN' | 'STALE';
  readonly availability: ObservationAvailability;
  readonly observedAt: string | null;
  readonly fetchedAt: string;
  readonly staleAfter: string;
  readonly source: EvidenceSource;
  readonly version: number;
  readonly permissionAvailability: PermissionAvailability;
  readonly subscriptionState: SubscriptionState;
  readonly projectionState: ProjectionState;
  readonly driftCodes: readonly AssetDriftCode[];
  readonly actionableReason: 'REAUTHORIZE' | 'CHECK_STATUS' | 'RECONCILE' | 'NONE';
  readonly providerCode: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const SAFE_PROVIDER_CODE = /^[A-Z0-9_.-]{1,64}$/;
const MAX_GRANTS = 256;
const MAX_GRANT_NAME = 128;
const SUBSCRIPTIONS = new Set<SubscriptionState>(['UNKNOWN', 'PENDING', 'ACTIVE', 'FAILED', 'REMOVED']);
const PROJECTIONS = new Set<ProjectionState>(['UNKNOWN', 'PENDING', 'SYNCED', 'STALE', 'FAILED']);

export function validateAssetObservationInput(input: AssetObservationInput): void {
  if (!isMetaAssetKind(input.kind) || !['META_API', 'SIGNED_WEBHOOK'].includes(input.source)) {
    throw new AssetObservationInputError();
  }
  if (input.observedAt !== null && !isIsoUtc(input.observedAt)) throw new AssetObservationInputError();
  if (!['ACTIVE', 'INACTIVE', 'UNKNOWN', 'UNAVAILABLE'].includes(input.status.value) ||
      !['OBSERVED', 'MISSING', 'UNKNOWN', 'UNAVAILABLE'].includes(input.status.availability) ||
      !['OBSERVED', 'UNKNOWN', 'UNAVAILABLE'].includes(input.permissions.availability)) {
    throw new AssetObservationInputError();
  }
  if ((input.status.providerCode !== undefined && !SAFE_PROVIDER_CODE.test(input.status.providerCode)) ||
      (input.permissions.grantNames !== undefined && (!Array.isArray(input.permissions.grantNames) ||
        input.permissions.grantNames.length > MAX_GRANTS || input.permissions.grantNames.some((grant) =>
          typeof grant !== 'string' || grant.trim().length === 0 || grant.length > MAX_GRANT_NAME)))) {
    throw new AssetObservationInputError();
  }
  if (input.permissions.availability === 'OBSERVED' && input.permissions.grantNames === undefined) {
    throw new AssetObservationInputError();
  }
  if (input.permissions.availability !== 'OBSERVED' && input.permissions.grantNames !== undefined) {
    throw new AssetObservationInputError();
  }
  if (input.status.value === 'UNAVAILABLE' && input.status.availability !== 'UNAVAILABLE') throw new AssetObservationInputError();
  if (input.status.availability === 'UNAVAILABLE' && input.status.value !== 'UNAVAILABLE') throw new AssetObservationInputError();
  if (input.subscriptionState !== undefined && !SUBSCRIPTIONS.has(input.subscriptionState)) throw new AssetObservationInputError();
  if (input.projectionState !== undefined && !PROJECTIONS.has(input.projectionState)) throw new AssetObservationInputError();
  if (input.observedAt === null && input.status.value !== 'UNAVAILABLE') throw new AssetObservationInputError();
}

/** Merge a partial observation without treating missing fields or a failed request as negative provider state. */
export function reduceAssetObservation(input: {
  readonly previous: AssetObservationSnapshot | null;
  readonly authorizationRef: string;
  readonly incoming: AssetObservationInput;
  readonly fetchedAt: string;
  readonly nextVersion: number;
}): AssetObservationSnapshot | null {
  validateAssetObservationInput(input.incoming);
  if (!UUID.test(input.authorizationRef) || !isIsoUtc(input.fetchedAt) || !Number.isSafeInteger(input.nextVersion) || input.nextVersion < 1 ||
      (input.previous !== null && input.previous.authorizationRef !== input.authorizationRef)) {
    throw new AssetObservationInputError();
  }
  const previous = input.previous;
  const { incoming } = input;
  if (previous && incoming.observedAt !== null && previous.observedAt !== null &&
      Date.parse(incoming.observedAt) <= Date.parse(previous.observedAt)) return null;

  const fetchedAt = canonicalUtc(input.fetchedAt);
  const validStatus = incoming.status.value !== 'UNAVAILABLE' && incoming.status.availability === 'OBSERVED';
  const statusValue = validStatus ? incoming.status.value : previous?.status.value ?? 'UNKNOWN';
  const statusAvailability = incoming.status.value === 'UNAVAILABLE' ? 'UNAVAILABLE'
    : incoming.status.availability === 'MISSING' ? 'MISSING'
      : incoming.status.availability === 'UNKNOWN' ? 'UNKNOWN'
        : validStatus ? 'OBSERVED' : previous?.status.availability ?? 'UNKNOWN';
  const statusObservedAt = validStatus && incoming.observedAt ? canonicalUtc(incoming.observedAt)
    : previous?.status.observedAt ?? null;
  const statusCode = incoming.status.providerCode ?? (incoming.status.value === 'UNAVAILABLE' ? 'DEPENDENCY_UNAVAILABLE'
    : incoming.status.availability === 'MISSING' ? 'FIELD_UNAVAILABLE' : null);

  const permissionsObserved = incoming.permissions.availability === 'OBSERVED';
  const grantNames = permissionsObserved ? [...new Set(incoming.permissions.grantNames ?? [])].sort()
    : previous?.permissions.grantNames ?? null;
  const permissionAvailability = incoming.permissions.availability === 'UNAVAILABLE' ? 'UNAVAILABLE'
    : incoming.permissions.availability === 'UNKNOWN' ? 'UNKNOWN'
      : permissionsObserved ? 'OBSERVED' : previous?.permissions.availability ?? 'UNKNOWN';
  const permissionsObservedAt = permissionsObserved && incoming.observedAt ? canonicalUtc(incoming.observedAt)
    : previous?.permissions.observedAt ?? null;
  const subscriptionState = incoming.subscriptionState ?? previous?.subscriptionState ?? 'UNKNOWN';
  const projectionState = incoming.projectionState ?? previous?.projectionState ?? 'UNKNOWN';
  const driftCodes = new Set<AssetDriftCode>();
  if (previous && validStatus && previous.status.value !== statusValue) driftCodes.add('ASSET_STATUS_CHANGED');
  if (previous && permissionsObserved && previous.permissions.grantNames !== null &&
      !sameStrings(previous.permissions.grantNames, grantNames ?? [])) driftCodes.add('PERMISSIONS_CHANGED');
  if (previous && incoming.subscriptionState !== undefined && previous.subscriptionState !== subscriptionState) {
    driftCodes.add('SUBSCRIPTION_CHANGED');
  }
  if (projectionState === 'STALE' || projectionState === 'FAILED') driftCodes.add('PROJECTION_STALE');

  return Object.freeze({
    schemaVersion: ASSET_OBSERVATION_SCHEMA_VERSION,
    version: input.nextVersion,
    authorizationRef: input.authorizationRef,
    kind: incoming.kind,
    source: incoming.source,
    observedAt: incoming.observedAt ? canonicalUtc(incoming.observedAt) : previous?.observedAt ?? null,
    fetchedAt,
    staleAfter: new Date(Date.parse(statusObservedAt ?? fetchedAt) + ASSET_OBSERVATION_STALE_AFTER_MS).toISOString(),
    status: Object.freeze({ value: statusValue, availability: statusAvailability,
      observedAt: statusObservedAt, providerCode: statusCode }),
    permissions: Object.freeze({ availability: permissionAvailability,
      grantNames: grantNames === null ? null : Object.freeze(grantNames), observedAt: permissionsObservedAt }),
    subscriptionState,
    projectionState,
    driftCodes: Object.freeze([...driftCodes].sort()),
  });
}

export function isAssetObservationStale(snapshot: AssetObservationSnapshot, now: string): boolean {
  if (!isIsoUtc(now)) throw new AssetObservationInputError();
  const lastStatusObservation = snapshot.status.observedAt;
  return snapshot.status.availability !== 'OBSERVED' || !lastStatusObservation || Date.parse(now) > Date.parse(snapshot.staleAfter);
}

export function toPublicAssetStatusObservation(snapshot: AssetObservationSnapshot,
  authorizationStatus: 'VERIFIED' | 'REVOKED' | 'UNKNOWN', now: string): PublicAssetStatusObservation {
  const stale = isAssetObservationStale(snapshot, now);
  const status = stale ? 'STALE' : snapshot.status.availability === 'OBSERVED' ? snapshot.status.value : 'UNKNOWN';
  const actionableReason = authorizationStatus === 'REVOKED' ? 'REAUTHORIZE'
    : stale || status === 'UNKNOWN' || snapshot.permissions.availability !== 'OBSERVED' ? 'CHECK_STATUS'
      : status === 'INACTIVE' || snapshot.driftCodes.length > 0 ? 'RECONCILE' : 'NONE';
  return Object.freeze({
    status,
    availability: snapshot.status.availability,
    observedAt: snapshot.status.observedAt,
    fetchedAt: snapshot.fetchedAt,
    staleAfter: snapshot.staleAfter,
    source: snapshot.source,
    version: snapshot.version,
    permissionAvailability: snapshot.permissions.availability,
    subscriptionState: snapshot.subscriptionState,
    projectionState: snapshot.projectionState,
    driftCodes: snapshot.driftCodes,
    actionableReason,
    providerCode: snapshot.status.providerCode,
  });
}

export class AssetObservationInputError extends Error {
  constructor() { super('Asset observation is invalid.'); this.name = 'AssetObservationInputError'; }
}

export class AssetObservationNotFoundError extends Error {
  constructor() { super('Asset not found in the tenant scope.'); this.name = 'AssetObservationNotFoundError'; }
}

function isIsoUtc(value: unknown): value is string {
  return typeof value === 'string' && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function canonicalUtc(value: string): string {
  return new Date(value).toISOString();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function isAssetObservationTenantAssetRef(tenantId: string, assetId: string): boolean {
  return UUID.test(tenantId) && UUID.test(assetId);
}

export function parseAssetObservationSnapshot(value: unknown): AssetObservationSnapshot | undefined {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) as unknown; } catch { return undefined; }
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== ASSET_OBSERVATION_SCHEMA_VERSION ||
      !Number.isSafeInteger(parsed.version) || Number(parsed.version) < 1 || !isUuid(parsed.authorizationRef) ||
      !isMetaAssetKind(parsed.kind) ||
      !['META_API', 'SIGNED_WEBHOOK'].includes(String(parsed.source)) ||
      !isNullableIsoUtc(parsed.observedAt) || !isIsoUtc(parsed.fetchedAt) || !isIsoUtc(parsed.staleAfter) ||
      !isRecord(parsed.status) || !['ACTIVE', 'INACTIVE', 'UNKNOWN'].includes(String(parsed.status.value)) ||
      !['OBSERVED', 'MISSING', 'UNKNOWN', 'UNAVAILABLE'].includes(String(parsed.status.availability)) ||
      !isNullableIsoUtc(parsed.status.observedAt) || !isNullableProviderCode(parsed.status.providerCode) ||
      !isRecord(parsed.permissions) || !['OBSERVED', 'UNKNOWN', 'UNAVAILABLE'].includes(String(parsed.permissions.availability)) ||
      !isNullableIsoUtc(parsed.permissions.observedAt) || !isNullableGrantNames(parsed.permissions.grantNames) ||
      (parsed.subscriptionState !== undefined && !SUBSCRIPTIONS.has(parsed.subscriptionState as SubscriptionState)) ||
      (parsed.projectionState !== undefined && !PROJECTIONS.has(parsed.projectionState as ProjectionState)) ||
      !Array.isArray(parsed.driftCodes) || parsed.driftCodes.some((code) =>
        !['ASSET_STATUS_CHANGED', 'PERMISSIONS_CHANGED', 'SUBSCRIPTION_CHANGED', 'PROJECTION_STALE'].includes(String(code)))) {
    return undefined;
  }
  return parsed as unknown as AssetObservationSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableIsoUtc(value: unknown): boolean { return value === null || (typeof value === 'string' && isIsoUtc(value)); }

function isNullableProviderCode(value: unknown): boolean {
  return value === null || (typeof value === 'string' && SAFE_PROVIDER_CODE.test(value));
}

function isNullableGrantNames(value: unknown): boolean {
  return value === null || (Array.isArray(value) && value.length <= MAX_GRANTS && value.every((grant) =>
    typeof grant === 'string' && grant.trim().length > 0 && grant.length <= MAX_GRANT_NAME));
}
