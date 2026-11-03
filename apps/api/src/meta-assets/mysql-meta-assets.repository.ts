import { createHash, randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { OutboxEventEnvelope } from '../jobs/event-validation.js';
import type { OutboxService } from '../outbox/outbox-service.js';
import type { AuditEventWriter } from '../privacy/audit.service.js';
import {
  assetIdentityHash,
  isVerifiedMetaEvidence,
  MetaAssetsConflictError,
  validateAuthorizationUpsert,
  type AssetClaimInput,
  type AssetReadModel,
  type AssetRelationType,
  type AssetVerificationState,
  type AuthorizationReadModel,
  type AuthorizationUpsertCommand,
  type AuthorizationUpsertResult,
  type EvidenceSource,
  type LegacyAssetReference,
  type MetaEnvironment,
  type ProjectionState,
  type SubscriptionState,
} from './meta-assets.types.js';

export const META_ASSETS_REPOSITORY = Symbol('META_ASSETS_REPOSITORY');

export interface MetaAssetsRepository {
  upsert(command: AuthorizationUpsertCommand): Promise<AuthorizationUpsertResult>;
  listReadModels(input: { readonly tenantId: string; readonly appConfigurationId: string; readonly environment: MetaEnvironment }): Promise<readonly AuthorizationReadModel[]>;
}

interface AuthorizationRow {
  id: string; tenant_id: string; app_configuration_id: string; provider: string; environment: string;
  provider_authorization_id: string | null; authorization_state: AuthorizationUpsertCommand['state']; version: string | number; observed_at: string | Date;
}
interface AssetRow {
  id: string; display_name: string | null; external_name: string | null; version: string | number; updated_at: string | Date;
}
interface IdentityClaimRow {
  provider: string; app_external_id: string; environment: string; asset_kind: string; external_id: string;
  tenant_id: string; asset_id: string | null; app_configuration_id: string; verification_ref_hash: string;
}
interface RelationRow { relation_type: string; target_asset_id: string }
interface ScopeRow { scope_name: string; status: string }
interface AssetAuthorizationRow {
  authorization_id: string;
  asset_id: string; external_id: string; external_name: string | null; asset_kind: string;
  verification_state: AssetVerificationState; subscription_state: SubscriptionState; projection_state: ProjectionState;
  version: string | number; updated_at: string | Date;
}
interface OutboxAppender { appendWithin(manager: EntityManager, event: unknown): Promise<unknown> }

const GRANTABLE_RELATIONS: Readonly<Record<AssetRelationType, { source: readonly string[]; target: readonly string[] }>> = {
  PHONE_TO_ACCOUNT: { source: ['WHATSAPP_PHONE_NUMBER'], target: ['WHATSAPP_BUSINESS_ACCOUNT'] },
  INSTAGRAM_TO_PAGE: { source: ['INSTAGRAM_BUSINESS_ACCOUNT', 'INSTAGRAM_CREATOR_ACCOUNT'], target: ['FACEBOOK_PAGE'] },
};

function mysqlDate(value: string): string {
  const iso = new Date(value).toISOString();
  const fraction = value.match(/\.(\d{1,6})Z$/)?.[1] ?? '';
  return iso.slice(0, 19).replace('T', ' ') + '.' + fraction.padEnd(6, '0');
}
function normalizedMysqlDate(value: string | Date): string {
  if (value instanceof Date) return mysqlDate(value.toISOString());
  if (value.includes('T')) return mysqlDate(value.endsWith('Z') ? value : value + 'Z');
  return value.includes('.') ? value : value + '.000000';
}
function dateString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value.replace(' ', 'T') + (value.includes('Z') ? '' : 'Z')).toISOString();
}
function rowAffected(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  if (typeof header === 'object' && header !== null && 'affectedRows' in header) return Number((header as { affectedRows?: number }).affectedRows ?? 0);
  return 0;
}
function asVersion(value: string | number): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('Stored Meta domain version is invalid.');
  return version;
}
function sourceOf(evidence: { readonly source: EvidenceSource } | undefined): EvidenceSource | 'BROWSER_CLAIM' {
  return evidence?.source ?? 'BROWSER_CLAIM';
}
function safeScopeSnapshot(scopes: readonly string[]): readonly string[] {
  return [...new Set(scopes)].sort((left, right) => left.localeCompare(right));
}
function json(value: unknown): string { return JSON.stringify(value); }
function transientWriteConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'ER_DUP_ENTRY' || error.code === 'ER_LOCK_DEADLOCK' || error.code === 'ER_LOCK_WAIT_TIMEOUT';
}
function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_DUP_ENTRY';
}

/** All commands run in one database transaction. OutboxService receives that same EntityManager. */
export class MysqlMetaAssetsRepository implements MetaAssetsRepository {
  constructor(
    private readonly database: DurableWorkDatabase,
    private readonly outbox: OutboxAppender,
    private readonly audit: AuditEventWriter,
  ) {}

  async upsert(command: AuthorizationUpsertCommand): Promise<AuthorizationUpsertResult> {
    validateAuthorizationUpsert(command);
    const dataSource = await this.database.getDataSource();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await dataSource.transaction((manager) => this.upsertWithin(manager, command));
      } catch (error) {
        if (!transientWriteConflict(error) || attempt === 2) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ER_DUP_ENTRY') {
            throw new MetaAssetsConflictError('Authorization or asset natural key is already assigned.');
          }
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
    throw new MetaAssetsConflictError();
  }
  private async upsertWithin(manager: EntityManager, command: AuthorizationUpsertCommand): Promise<AuthorizationUpsertResult> {
    const timestamp = mysqlDate(command.observedAt);
    const authEvidence = isVerifiedMetaEvidence(command.evidence) ? command.evidence : undefined;
    const source = sourceOf(authEvidence);
    const providerAuthorizationId = authEvidence ? command.providerAuthorizationId ?? null : null;
    const existingAuthRows = await manager.query(
      `SELECT id, tenant_id, app_configuration_id, provider, environment, provider_authorization_id, authorization_state, version,
       DATE_FORMAT(observed_at, '%Y-%m-%d %H:%i:%s.%f') AS observed_at
       FROM ca_meta_authorizations WHERE tenant_id = ? AND id = ? FOR UPDATE`,
      [command.tenantId, command.authorizationId],
    ) as AuthorizationRow[];
    const currentAuth = existingAuthRows[0];
    if (currentAuth && (currentAuth.app_configuration_id !== command.appConfigurationId ||
        currentAuth.provider !== command.provider || currentAuth.environment !== command.environment)) {
      throw new MetaAssetsConflictError('Authorization reference is already bound to a different tenant context.');
    }
    if (currentAuth && timestamp < normalizedMysqlDate(currentAuth.observed_at)) {
      throw new MetaAssetsConflictError('Stale authorization observation cannot replace newer state.');
    }
    const authorizationState = authEvidence ? command.state : currentAuth?.authorization_state ?? 'UNKNOWN';
    const authVersion = currentAuth ? asVersion(currentAuth.version) + 1 : 1;
    if (currentAuth && command.expectedVersion !== undefined && asVersion(currentAuth.version) !== command.expectedVersion) {
      throw new MetaAssetsConflictError('Authorization version changed before the update.');
    }
    if (!currentAuth) {
      await manager.query(
        'INSERT INTO ca_meta_authorizations (id, tenant_id, app_configuration_id, provider, environment, provider_authorization_id, authorization_state, version, observed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
        [command.authorizationId, command.tenantId, command.appConfigurationId, command.provider, command.environment,
          providerAuthorizationId, authorizationState, timestamp, timestamp, timestamp],
      );
    } else {
      const updateResult = await manager.query(
        'UPDATE ca_meta_authorizations SET provider_authorization_id = COALESCE(?, provider_authorization_id), authorization_state = ?, version = ?, observed_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND version = ?',
        [providerAuthorizationId, authorizationState, authVersion, timestamp, timestamp,
          command.tenantId, command.authorizationId, currentAuth.version],
      );
      if (rowAffected(updateResult) !== 1) throw new MetaAssetsConflictError('Authorization version changed while updating.');
    }

    let scopes = authEvidence ? safeScopeSnapshot(command.grantedScopes) : [];
    if (!authEvidence) {
      const currentScopes = await manager.query(
        'SELECT scope_name FROM ca_meta_authorization_scopes WHERE tenant_id = ? AND authorization_id = ? AND status = \'GRANTED\' ORDER BY scope_name',
        [command.tenantId, command.authorizationId],
      ) as Array<{ scope_name: string }>;
      scopes = currentScopes.map((row) => row.scope_name);
    }
    await this.persistScopes(manager, command, scopes, source, timestamp);
    const authSnapshot = {
      authorizationRef: command.authorizationId,
      state: authorizationState,
      grantedScopes: scopes,
      providerAuthorizationId: providerAuthorizationId ?? currentAuth?.provider_authorization_id ?? null,
    };
    await manager.query(
      'INSERT INTO ca_meta_authorization_history (id, tenant_id, authorization_id, version, source, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [randomUUID(), command.tenantId, command.authorizationId, authVersion, source, json(authSnapshot), timestamp],
    );
    const results: AuthorizationUpsertResult['assets'][number][] = [];
    const assetIds = new Map<string, { id: string; kind: string; verificationState: AssetVerificationState }>();
    let quarantinedCount = 0;
    for (const asset of command.assets) {
      const evidence = isVerifiedMetaEvidence(asset.evidence) ? asset.evidence : undefined;
      const assetResult = await this.upsertAsset(manager, command, asset, evidence, timestamp);
      results.push(assetResult.result);
      if (assetResult.result.verificationState === 'QUARANTINED') {
        quarantinedCount += 1;
      } else if (assetResult.result.assetRef) {
        assetIds.set(asset.kind + '\0' + asset.externalId, {
          id: assetResult.result.assetRef,
          kind: asset.kind,
          verificationState: assetResult.result.verificationState,
        });
        if (asset.legacyReferences?.length) await this.persistLegacyReferences(manager, command, assetResult.result.assetRef, asset.legacyReferences, timestamp);
      }
    }
    for (const asset of command.assets) {
      const sourceAsset = assetIds.get(asset.kind + '\0' + asset.externalId);
      const evidence = isVerifiedMetaEvidence(asset.evidence) ? asset.evidence : undefined;
      if (!sourceAsset || !evidence || sourceAsset.verificationState !== 'VERIFIED') continue;
      for (const relation of asset.relations ?? []) {
        await this.persistRelation(manager, command, asset, sourceAsset, relation.type, relation.targetExternalId, evidence, assetIds, timestamp);
      }
    }

    const aggregateState: AuthorizationUpsertCommand['state'] | 'PARTIAL' =
      quarantinedCount > 0 && authorizationState === 'ACTIVE' ? 'PARTIAL' : authorizationState;
    const event: OutboxEventEnvelope = {
      eventId: 'meta-authorization:' + command.authorizationId + ':' + authVersion,
      tenantRef: command.tenantId,
      schemaVersion: 1,
      eventType: 'connection.changed',
      aggregateRef: command.authorizationId,
      aggregateVersion: authVersion,
      actor: command.actor,
      correlationId: command.correlationId,
      causationId: command.causationId ?? null,
      createdAt: command.observedAt,
      enqueuedAt: command.observedAt,
      data: { kind: 'CONNECTION_CHANGED', connectionRef: command.authorizationId, status: this.outboxState(aggregateState), observedAt: command.observedAt },
    };
    await this.outbox.appendWithin(manager, event);
    const auditAction = authorizationState === 'DISCONNECTED' || authorizationState === 'REVOKED'
      ? 'AUTHORIZATION_DISCONNECTED'
      : authEvidence && currentAuth ? 'AUTHORIZATION_REAUTHORIZED'
        : authEvidence && !currentAuth && (authorizationState === 'ACTIVE' || authorizationState === 'PARTIAL')
          ? 'AUTHORIZATION_CONNECTED' : 'AUTHORIZATION_OBSERVED';
    await this.audit.record({
      tenantId: command.tenantId,
      actorRef: command.actor.ref,
      action: auditAction,
      targetRef: command.authorizationId,
      correlationId: command.correlationId,
      retentionClass: 'OPERATIONS',
      safeDiff: { before: currentAuth?.authorization_state ?? 'UNKNOWN', after: aggregateState, version: authVersion },
    }, manager);
    return Object.freeze({
      authorizationRef: command.authorizationId,
      version: authVersion,
      assets: Object.freeze(results),
      quarantinedCount,
    });
  }

  async listReadModels(input: { readonly tenantId: string; readonly appConfigurationId: string; readonly environment: MetaEnvironment }): Promise<readonly AuthorizationReadModel[]> {
    const dataSource = await this.database.getDataSource();
    const rows = await dataSource.query(
      'SELECT id, provider, environment, authorization_state, version, observed_at FROM ca_meta_authorizations WHERE tenant_id = ? AND app_configuration_id = ? AND environment = ? ORDER BY updated_at DESC, id',
      [input.tenantId, input.appConfigurationId, input.environment],
    ) as Array<{ id: string; provider: 'META'; environment: MetaEnvironment; authorization_state: AuthorizationReadModel['state']; version: string | number; observed_at: string | Date }>;
    if (rows.length === 0) return Object.freeze([]);
    const authIds = rows.map((row) => row.id);
    const placeholders = authIds.map(() => '?').join(', ');
    const [scopeRows, assetRows] = await Promise.all([
      dataSource.query(
        'SELECT authorization_id, scope_name FROM ca_meta_authorization_scopes WHERE tenant_id = ? AND authorization_id IN (' + placeholders + ') AND status = \'GRANTED\' ORDER BY authorization_id, scope_name',
        [input.tenantId, ...authIds],
      ) as Promise<Array<{ authorization_id: string; scope_name: string }>>,
      dataSource.query(
        'SELECT aa.authorization_id, aa.asset_id, a.asset_kind, a.external_id, a.external_name, aa.verification_state, aa.subscription_state, aa.projection_state, aa.version, aa.updated_at FROM ca_meta_asset_authorizations aa INNER JOIN ca_meta_assets a ON a.tenant_id = aa.tenant_id AND a.id = aa.asset_id WHERE aa.tenant_id = ? AND aa.app_configuration_id = ? AND aa.environment = ? AND aa.authorization_id IN (' + placeholders + ') AND aa.state <> \'REVOKED\' ORDER BY aa.authorization_id, a.external_id',
        [input.tenantId, input.appConfigurationId, input.environment, ...authIds],
      ) as Promise<AssetAuthorizationRow[]>,
    ]);
    const assetIds = assetRows.map((row) => row.asset_id);
    const assetPlaceholders = assetIds.map(() => '?').join(', ');
    const [grantRows, relationRows] = assetIds.length === 0 ? [new Array<{ authorization_id: string; asset_id: string; grant_name: string }>(), new Array<{ source_asset_id: string; relation_type: AssetRelationType; target_asset_id: string }>()] : await Promise.all([
      dataSource.query(
        'SELECT authorization_id, asset_id, grant_name FROM ca_meta_asset_grants WHERE tenant_id = ? AND authorization_id IN (' + placeholders + ') AND asset_id IN (' + assetPlaceholders + ') AND status = \'GRANTED\' ORDER BY authorization_id, asset_id, grant_name',
        [input.tenantId, ...authIds, ...assetIds],
      ) as Promise<Array<{ authorization_id: string; asset_id: string; grant_name: string }>>,
      dataSource.query(
        'SELECT source_asset_id, relation_type, target_asset_id FROM ca_meta_asset_relations WHERE tenant_id = ? AND source_asset_id IN (' + assetPlaceholders + ') ORDER BY source_asset_id, relation_type, target_asset_id',
        [input.tenantId, ...assetIds],
      ) as Promise<Array<{ source_asset_id: string; relation_type: AssetRelationType; target_asset_id: string }>>,
    ]);
    return this.mapReadModels(rows, scopeRows, assetRows, grantRows, relationRows);
  }
  private async persistScopes(manager: EntityManager, command: AuthorizationUpsertCommand,
    grantedScopes: readonly string[], source: EvidenceSource | 'BROWSER_CLAIM', timestamp: string): Promise<void> {
    if (source === 'BROWSER_CLAIM') return;
    const rows = await manager.query(
      'SELECT scope_name, status FROM ca_meta_authorization_scopes WHERE tenant_id = ? AND authorization_id = ? FOR UPDATE',
      [command.tenantId, command.authorizationId],
    ) as ScopeRow[];
    const active = new Set(grantedScopes);
    const stored = new Set(rows.map((row) => row.scope_name));
    for (const scope of grantedScopes) {
      const row = rows.find((candidate) => candidate.scope_name === scope);
      if (row?.status === 'GRANTED') continue;
      if (stored.has(scope)) {
        await manager.query(
          'UPDATE ca_meta_authorization_scopes SET status = \'GRANTED\', source = ?, observed_at = ?, version = version + 1 WHERE tenant_id = ? AND authorization_id = ? AND scope_name = ?',
          [source, timestamp, command.tenantId, command.authorizationId, scope],
        );
      } else {
        await manager.query(
          'INSERT INTO ca_meta_authorization_scopes (tenant_id, authorization_id, app_configuration_id, provider, environment, scope_name, status, source, observed_at, version) VALUES (?, ?, ?, ?, ?, ?, \'GRANTED\', ?, ?, 1)',
          [command.tenantId, command.authorizationId, command.appConfigurationId, command.provider, command.environment, scope, source, timestamp],
        );
      }
    }
    for (const row of rows) {
      if (row.status === 'GRANTED' && !active.has(row.scope_name)) {
        await manager.query(
          'UPDATE ca_meta_authorization_scopes SET status = \'REVOKED\', observed_at = ?, version = version + 1 WHERE tenant_id = ? AND authorization_id = ? AND scope_name = ?',
          [timestamp, command.tenantId, command.authorizationId, row.scope_name],
        );
      }
    }
  }

  private async upsertAsset(manager: EntityManager, command: AuthorizationUpsertCommand, input: AssetClaimInput,
    evidence: { readonly source: EvidenceSource; readonly observedAt: string; readonly observationRefHash: string } | undefined,
    timestamp: string): Promise<{ result: AuthorizationUpsertResult['assets'][number] }> {
    const appRows = await manager.query(
      'SELECT app_external_id FROM ca_meta_app_configurations WHERE tenant_id = ? AND id = ? AND provider = ? AND environment = ?',
      [command.tenantId, command.appConfigurationId, command.provider, command.environment],
    ) as Array<{ app_external_id: string }>;
    const appExternalId = appRows[0]?.app_external_id;
    if (!appExternalId) throw new MetaAssetsConflictError('App configuration does not match the tenant context.');
    const identityHash = assetIdentityHash({
      provider: command.provider, appExternalId, environment: command.environment,
      kind: input.kind, externalId: input.externalId,
    });
    const identityRows = await manager.query(
      'SELECT provider, app_external_id, environment, asset_kind, external_id, tenant_id, asset_id, app_configuration_id, verification_ref_hash FROM ca_meta_asset_identity_claims WHERE identity_hash = ? FOR UPDATE',
      [identityHash],
    ) as IdentityClaimRow[];
    let identity = identityRows[0];
    if (identity) {
      this.assertIdentityExact(identity, command, appExternalId, input);
      if (identity.tenant_id !== command.tenantId) {
        await this.recordQuarantine(manager, command, input, identityHash, sourceOf(evidence), timestamp);
        return { result: { externalId: input.externalId, verificationState: 'QUARANTINED' } };
      }
    } else if (evidence) {
      try {
        await manager.query(
          'INSERT INTO ca_meta_asset_identity_claims (identity_hash, provider, app_external_id, environment, asset_kind, external_id, tenant_id, asset_id, app_configuration_id, verification_source, verification_ref_hash, verified_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 1)',
          [identityHash, command.provider, appExternalId, command.environment, input.kind, input.externalId,
            command.tenantId, command.appConfigurationId, evidence.source, evidence.observationRefHash, timestamp],
        );
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
      const lockedRows = await manager.query(
        'SELECT provider, app_external_id, environment, asset_kind, external_id, tenant_id, asset_id, app_configuration_id, verification_ref_hash FROM ca_meta_asset_identity_claims WHERE identity_hash = ? FOR UPDATE',
        [identityHash],
      ) as IdentityClaimRow[];
      identity = lockedRows[0];
      if (!identity) throw new Error('Verified asset ownership claim could not be locked.');
      this.assertIdentityExact(identity, command, appExternalId, input);
      if (identity.tenant_id !== command.tenantId) {
        await this.recordQuarantine(manager, command, input, identityHash, evidence.source, timestamp);
        return { result: { externalId: input.externalId, verificationState: 'QUARANTINED' } };
      }
    }

    const foundRows = await manager.query(
      'SELECT id, display_name, external_name, version, updated_at FROM ca_meta_assets WHERE tenant_id = ? AND app_configuration_id = ? AND environment = ? AND provider = ? AND asset_kind = ? AND external_id = ? FOR UPDATE',
      [command.tenantId, command.appConfigurationId, command.environment, command.provider, input.kind, input.externalId],
    ) as AssetRow[];
    let asset = foundRows[0];
    let insertedNewAsset = false;
    if (!asset) {
      const id = randomUUID();
      insertedNewAsset = true;
      try {
        await manager.query(
          'INSERT INTO ca_meta_assets (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id, display_name, external_name, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)',
          [id, command.tenantId, command.appConfigurationId, command.provider, command.environment, input.kind, input.externalId,
            evidence ? input.externalName ?? null : null, timestamp, timestamp],
        );
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        insertedNewAsset = false;
      }
      const insertedRows = await manager.query(
        'SELECT id, display_name, external_name, version, updated_at FROM ca_meta_assets WHERE tenant_id = ? AND app_configuration_id = ? AND environment = ? AND provider = ? AND asset_kind = ? AND external_id = ? FOR UPDATE',
        [command.tenantId, command.appConfigurationId, command.environment, command.provider, input.kind, input.externalId],
      ) as AssetRow[];
      asset = insertedRows[0];
      if (!asset) throw new Error('Asset upsert did not produce a tenant-scoped row.');
    }
    const previousVersion = asVersion(asset.version);
    const nextVersion = previousVersion + (insertedNewAsset ? 0 : 1);
    if (!insertedNewAsset) {
      const updateAssetResult = evidence && input.externalName !== undefined
        ? await manager.query(
          'UPDATE ca_meta_assets SET external_name = ?, version = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND version = ?',
          [input.externalName, nextVersion, timestamp, command.tenantId, asset.id, previousVersion],
        )
        : await manager.query(
          'UPDATE ca_meta_assets SET version = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND version = ?',
          [nextVersion, timestamp, command.tenantId, asset.id, previousVersion],
        );
      if (rowAffected(updateAssetResult) !== 1) throw new MetaAssetsConflictError('Asset version changed while updating.');
    }
    if (identity && evidence && identity.asset_id === null) {
      const claimResult = await manager.query(
        'UPDATE ca_meta_asset_identity_claims SET asset_id = ?, verification_source = ?, verification_ref_hash = ?, verified_at = ?, version = version + 1 WHERE identity_hash = ? AND tenant_id = ? AND asset_id IS NULL',
        [asset.id, evidence.source, evidence.observationRefHash, timestamp, identityHash, command.tenantId],
      );
      if (rowAffected(claimResult) !== 1) {
        const claimRows = await manager.query(
          'SELECT tenant_id, asset_id FROM ca_meta_asset_identity_claims WHERE identity_hash = ? FOR UPDATE',
          [identityHash],
        ) as Array<{ tenant_id: string; asset_id: string | null }>;
        if (claimRows[0]?.tenant_id !== command.tenantId || claimRows[0]?.asset_id !== asset.id) {
          throw new MetaAssetsConflictError('Verified asset ownership changed during upsert.');
        }
      }
    } else if (identity && evidence && identity.asset_id !== null && identity.asset_id !== asset.id) {
      throw new MetaAssetsConflictError('Verified asset identity is bound to a different local asset.');
    }

    const linkRows = await manager.query(
      'SELECT verification_state, verification_source, version FROM ca_meta_asset_authorizations WHERE tenant_id = ? AND authorization_id = ? AND asset_id = ? FOR UPDATE',
      [command.tenantId, command.authorizationId, asset.id],
    ) as Array<{ verification_state: AssetVerificationState; verification_source: string; version: number | string }>;
    const existingLink = linkRows[0];
    const verificationState: AssetVerificationState = evidence || existingLink?.verification_state === 'VERIFIED' ? 'VERIFIED' : 'CLAIMED';
    const verificationSource = evidence?.source ?? existingLink?.verification_source ?? 'BROWSER_CLAIM';
    const verificationRefHash = evidence?.observationRefHash ?? null;
    const verifiedAt = evidence ? timestamp : null;
    if (!existingLink) {
      await manager.query(
        'INSERT INTO ca_meta_asset_authorizations (tenant_id, authorization_id, asset_id, app_configuration_id, provider, environment, credential_id, state, verification_state, verification_source, verification_ref_hash, verified_at, subscription_state, projection_state, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, \'ACTIVE\', ?, ?, ?, ?, \'UNKNOWN\', \'UNKNOWN\', 1, ?, ?)',
        [command.tenantId, command.authorizationId, asset.id, command.appConfigurationId, command.provider, command.environment,
          verificationState, verificationSource, verificationRefHash, verifiedAt, timestamp, timestamp],
      );
    } else {
      await manager.query(
        'UPDATE ca_meta_asset_authorizations SET verification_state = ?, verification_source = ?, verification_ref_hash = COALESCE(?, verification_ref_hash), verified_at = COALESCE(?, verified_at), version = version + 1, updated_at = ? WHERE tenant_id = ? AND authorization_id = ? AND asset_id = ? AND version = ?',
        [verificationState, verificationSource, verificationRefHash, verifiedAt, timestamp, command.tenantId, command.authorizationId, asset.id, existingLink.version],
      );
    }

    const currentGrants = await this.persistAssetGrants(manager, command, input, asset.id, timestamp, evidence?.source);
    const assetVersion = nextVersion;
    const snapshot = {
      assetRef: asset.id, kind: input.kind, externalId: input.externalId,
      externalName: evidence ? input.externalName ?? asset.external_name : asset.external_name,
      verificationState, verificationSource, grants: currentGrants,
    };
    await manager.query(
      'INSERT INTO ca_meta_asset_history (id, tenant_id, asset_id, version, source, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [randomUUID(), command.tenantId, asset.id, assetVersion, sourceOf(evidence), json(snapshot), timestamp],
    );
    return { result: { externalId: input.externalId, assetRef: asset.id, verificationState } };
  }

  private assertIdentityExact(identity: IdentityClaimRow, command: AuthorizationUpsertCommand, appExternalId: string, asset: AssetClaimInput): void {
    if (identity.provider !== command.provider || identity.app_external_id !== appExternalId ||
        identity.environment !== command.environment || identity.asset_kind !== asset.kind || identity.external_id !== asset.externalId) {
      throw new MetaAssetsConflictError('Asset identity hash collision or corrupted ownership record.');
    }
  }

  private async recordQuarantine(manager: EntityManager, command: AuthorizationUpsertCommand, asset: AssetClaimInput,
    identityHash: Buffer, source: EvidenceSource | 'BROWSER_CLAIM', timestamp: string): Promise<void> {
    try {
      await manager.query(
        'INSERT INTO ca_meta_asset_claim_quarantine (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id, identity_hash, reason_code, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'CROSS_TENANT_VERIFIED_OWNER\', ?, ?)',
        [randomUUID(), command.tenantId, command.appConfigurationId, command.provider, command.environment, asset.kind,
          asset.externalId, identityHash, source, timestamp],
      );
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }
  private async persistLegacyReferences(manager: EntityManager, command: AuthorizationUpsertCommand,
    assetId: string, references: readonly LegacyAssetReference[], timestamp: string): Promise<void> {
    for (const reference of references) {
      const existingRows = await manager.query(
        'SELECT asset_id FROM ca_meta_asset_legacy_refs WHERE tenant_id = ? AND legacy_database_id = ? AND legacy_company_id = ? AND environment = ? AND legacy_asset_ref = ? FOR UPDATE',
        [command.tenantId, reference.legacyDatabaseId, reference.legacyCompanyId, command.environment, reference.legacyAssetRef],
      ) as Array<{ asset_id: string }>;
      const existing = existingRows[0];
      if (existing) {
        if (existing.asset_id !== assetId) throw new MetaAssetsConflictError('Legacy asset reference is already assigned within this tenant.');
        continue;
      }
      try {
        await manager.query(
          'INSERT INTO ca_meta_asset_legacy_refs (id, tenant_id, asset_id, legacy_database_id, legacy_company_id, environment, legacy_asset_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [randomUUID(), command.tenantId, assetId, reference.legacyDatabaseId, reference.legacyCompanyId,
            command.environment, reference.legacyAssetRef, timestamp],
        );
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        const concurrentRows = await manager.query(
          'SELECT asset_id FROM ca_meta_asset_legacy_refs WHERE tenant_id = ? AND legacy_database_id = ? AND legacy_company_id = ? AND environment = ? AND legacy_asset_ref = ? FOR UPDATE',
          [command.tenantId, reference.legacyDatabaseId, reference.legacyCompanyId, command.environment, reference.legacyAssetRef],
        ) as Array<{ asset_id: string }>;
        if (concurrentRows[0]?.asset_id !== assetId) throw new MetaAssetsConflictError('Legacy asset reference is already assigned within this tenant.');
      }
    }
  }
  private async persistAssetGrants(manager: EntityManager, command: AuthorizationUpsertCommand, asset: AssetClaimInput,
    assetId: string, timestamp: string, source: EvidenceSource | undefined): Promise<readonly string[]> {
    const existing = await manager.query(
      'SELECT grant_name, status, version FROM ca_meta_asset_grants WHERE tenant_id = ? AND authorization_id = ? AND asset_id = ? FOR UPDATE',
      [command.tenantId, command.authorizationId, assetId],
    ) as Array<{ grant_name: string; status: string; version: string | number }>;
    const granted = existing.filter((row) => row.status === 'GRANTED').map((row) => row.grant_name);
    if (asset.grants === undefined) return safeScopeSnapshot(granted);
    if (source === undefined) throw new MetaAssetsConflictError('Asset grants require trusted provider evidence.');
    const grants = new Set(asset.grants);
    for (const grant of grants) {
      const row = existing.find((candidate) => candidate.grant_name === grant);
      if (!row) {
        await manager.query(
          'INSERT INTO ca_meta_asset_grants (tenant_id, authorization_id, asset_id, app_configuration_id, provider, environment, grant_name, status, source, observed_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, \'GRANTED\', ?, ?, 1)',
          [command.tenantId, command.authorizationId, assetId, command.appConfigurationId, command.provider,
            command.environment, grant, source, timestamp],
        );
      } else if (row.status !== 'GRANTED') {
        await manager.query(
          'UPDATE ca_meta_asset_grants SET status = \'GRANTED\', source = ?, observed_at = ?, version = version + 1 WHERE tenant_id = ? AND authorization_id = ? AND asset_id = ? AND grant_name = ? AND version = ?',
          [source, timestamp, command.tenantId, command.authorizationId, assetId, grant, row.version],
        );
      }
    }
    for (const row of existing) {
      if (row.status === 'GRANTED' && !grants.has(row.grant_name)) {
        await manager.query(
          'UPDATE ca_meta_asset_grants SET status = \'REVOKED\', observed_at = ?, version = version + 1 WHERE tenant_id = ? AND authorization_id = ? AND asset_id = ? AND grant_name = ? AND version = ?',
          [timestamp, command.tenantId, command.authorizationId, assetId, row.grant_name, row.version],
        );
      }
    }
    return safeScopeSnapshot([...grants]);
  }

  private async persistRelation(manager: EntityManager, command: AuthorizationUpsertCommand, sourceInput: AssetClaimInput,
    sourceAsset: { readonly id: string; readonly kind: string; readonly verificationState: AssetVerificationState },
    relationType: AssetRelationType, targetExternalId: string,
    evidence: { readonly source: EvidenceSource; readonly observedAt: string; readonly observationRefHash: string },
    assets: ReadonlyMap<string, { readonly id: string; readonly kind: string; readonly verificationState: AssetVerificationState }>,
    timestamp: string): Promise<void> {
    const allowed = GRANTABLE_RELATIONS[relationType];
    if (!allowed.source.includes(sourceAsset.kind)) throw new MetaAssetsConflictError('Typed asset relation has an invalid source kind.');
    let target = allowed.target.map((kind) => assets.get(kind + '\0' + targetExternalId))
      .find((candidate) => candidate?.verificationState === 'VERIFIED');
    if (!target) {
      const placeholders = allowed.target.map(() => '?').join(', ');
      const rows = await manager.query(
        'SELECT a.id, a.asset_kind AS kind FROM ca_meta_assets a WHERE a.tenant_id = ? AND a.app_configuration_id = ? AND a.environment = ? AND a.provider = ? AND a.external_id = ? AND a.asset_kind IN (' + placeholders + ') AND EXISTS (SELECT 1 FROM ca_meta_asset_authorizations aa WHERE aa.tenant_id = a.tenant_id AND aa.asset_id = a.id AND aa.verification_state = \'VERIFIED\') LIMIT 1',
        [command.tenantId, command.appConfigurationId, command.environment, command.provider, targetExternalId, ...allowed.target],
      ) as Array<{ id: string; kind: string }>;
      const row = rows[0];
      if (!row) throw new MetaAssetsConflictError('Typed asset relation target is missing or unverified.');
      target = { id: row.id, kind: row.kind, verificationState: 'VERIFIED' };
    }
    const targetAllowed = allowed.target.includes(target.kind);
    if (!targetAllowed || sourceAsset.id === target.id) throw new MetaAssetsConflictError('Typed asset relation endpoints are invalid.');
    const observed = mysqlDate(evidence.observedAt || timestamp);
    const existing = await manager.query(
      'SELECT version FROM ca_meta_asset_relations WHERE tenant_id = ? AND source_asset_id = ? AND target_asset_id = ? AND relation_type = ? FOR UPDATE',
      [command.tenantId, sourceAsset.id, target.id, relationType],
    ) as Array<{ version: number | string }>;
    if (existing[0]) {
      await manager.query(
        'UPDATE ca_meta_asset_relations SET verification_source = ?, verification_ref_hash = ?, verified_at = ?, version = version + 1 WHERE tenant_id = ? AND source_asset_id = ? AND target_asset_id = ? AND relation_type = ? AND version = ?',
        [evidence.source, evidence.observationRefHash, observed, command.tenantId, sourceAsset.id, target.id, relationType, existing[0].version],
      );
    } else {
      await manager.query(
        'INSERT INTO ca_meta_asset_relations (tenant_id, source_asset_id, target_asset_id, app_configuration_id, provider, environment, relation_type, verification_source, verification_ref_hash, verified_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
        [command.tenantId, sourceAsset.id, target.id, command.appConfigurationId, command.provider, command.environment,
          relationType, evidence.source, evidence.observationRefHash, observed],
      );
    }
    void sourceInput;
  }

  private async mapReadModels(
    authorizations: Array<{ id: string; provider: 'META'; environment: MetaEnvironment; authorization_state: AuthorizationReadModel['state']; version: string | number; observed_at: string | Date }>,
    scopes: Array<{ authorization_id: string; scope_name: string }>,
    assetRows: AssetAuthorizationRow[],
    grants: Array<{ authorization_id: string; asset_id: string; grant_name: string }>,
    relations: Array<{ source_asset_id: string; relation_type: AssetRelationType; target_asset_id: string }>,
  ): Promise<readonly AuthorizationReadModel[]> {
    const scopesByAuth = new Map<string, string[]>();
    for (const row of scopes) scopesByAuth.set(row.authorization_id, [...(scopesByAuth.get(row.authorization_id) ?? []), row.scope_name]);
    const grantsByAsset = new Map<string, string[]>();
    for (const row of grants) {
      const key = row.authorization_id + ':' + row.asset_id;
      grantsByAsset.set(key, [...(grantsByAsset.get(key) ?? []), row.grant_name]);
    }
    const relationsBySource = new Map<string, Array<{ type: AssetRelationType; targetAssetRef: string }>>();
    for (const row of relations) {
      relationsBySource.set(row.source_asset_id, [
        ...(relationsBySource.get(row.source_asset_id) ?? []),
        { type: row.relation_type, targetAssetRef: row.target_asset_id },
      ]);
    }
    return Object.freeze(authorizations.map((row) => {
      const assets: AssetReadModel[] = assetRows.filter((asset) => asset.authorization_id === row.id).map((asset) => ({
        assetRef: asset.asset_id,
        kind: asset.asset_kind,
        externalId: asset.external_id,
        externalName: asset.external_name,
        verificationState: asset.verification_state,
        grants: Object.freeze(grantsByAsset.get(row.id + ':' + asset.asset_id) ?? []),
        relations: Object.freeze(relationsBySource.get(asset.asset_id) ?? []),
        subscriptionState: asset.subscription_state,
        projectionState: asset.projection_state,
        version: asVersion(asset.version),
        updatedAt: dateString(asset.updated_at),
      }));
      return Object.freeze({
        authorizationRef: row.id,
        provider: row.provider,
        environment: row.environment,
        state: row.authorization_state,
        grantedScopes: Object.freeze(scopesByAuth.get(row.id) ?? []),
        version: asVersion(row.version),
        observedAt: dateString(row.observed_at),
        assets: Object.freeze(assets),
      });
    }));
  }

  private outboxState(state: AuthorizationUpsertCommand['state'] | 'PARTIAL'): 'ACTIVE' | 'PARTIAL' | 'REAUTH_REQUIRED' | 'UNKNOWN' | 'DISCONNECTED' {
    switch (state) {
      case 'ACTIVE': return 'ACTIVE';
      case 'PARTIAL': return 'PARTIAL';
      case 'REAUTH_REQUIRED': return 'REAUTH_REQUIRED';
      case 'REVOKED':
      case 'DISCONNECTED': return 'DISCONNECTED';
      default: return 'UNKNOWN';
    }
  }
}
