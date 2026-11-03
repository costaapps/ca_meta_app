import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import type { MetaAuthVariant, MetaFlowVariant } from '../credentials/credential-resolver.types.js';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { OutboxEventEnvelope } from '../jobs/event-validation.js';
import type { OutboxService } from '../outbox/outbox-service.js';
import { privacyRefHash, type AuditEventWriter } from '../privacy/audit.service.js';
import { isSafeOpaqueReference } from '../privacy/redaction.js';
import {
  assetIdentityHash,
  isMetaAssetKind,
  isVerifiedMetaEvidence,
  MetaAssetsConflictError,
  validateAuthorizationUpsert,
  type AssetClaimInput,
  type AssetReadModel,
  type AssetAuthorizationState,
  type AssetCatalogPage,
  type AssetCatalogPageQuery,
  type AssetCatalogReadModel,
  type AssetCapabilityEvidence,
  type ConnectionCatalogPage,
  type ConnectionCatalogPageQuery,
  type ConnectionCatalogReadModel,
  type AssetRelationType,
  type AssetVerificationState,
  type AuthorizationState,
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
  listAssetCatalog(input: AssetCatalogPageQuery): Promise<AssetCatalogPage>;
  findAssetCatalog(input: { readonly tenantId: string; readonly environment: MetaEnvironment; readonly assetRef: string }): Promise<AssetCatalogReadModel | undefined>;
  listConnectionCatalog(input: ConnectionCatalogPageQuery): Promise<ConnectionCatalogPage>;
  findConnectionCatalog(input: { readonly tenantId: string; readonly environment: MetaEnvironment; readonly connectionRef: string }): Promise<ConnectionCatalogReadModel | undefined>;
}

interface AuthorizationRow {
  id: string; tenant_id: string; app_configuration_id: string; provider: string; environment: string;
  provider_authorization_id: string | null; authorization_state: AuthorizationUpsertCommand['state'];
  flow_variant: AuthorizationUpsertCommand['flowVariant'] | null; auth_variant: AuthorizationUpsertCommand['authVariant'] | null;
  version: string | number; observed_at: string | Date;
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
  credential_id: string | null; authorization_state: AssetAuthorizationState;
  verification_state: AssetVerificationState; subscription_state: SubscriptionState; projection_state: ProjectionState;
  version: string | number; updated_at: string | Date;
}
interface AssetCatalogRow {
  id: string;
  app_configuration_id: string;
  asset_kind: string;
  status: AssetCatalogReadModel['status'];
  authorization_status: AssetCatalogReadModel['authorizationStatus'];
  observed_at: string | Date;
  reauthorization_required: number | string;
}
interface ConnectionCatalogRow {
  id: string;
  flow_variant: string | null;
  auth_variant: string | null;
  authorization_state: AuthorizationState;
  observed_at: string | Date;
  asset_count: string | number;
  verified_asset_count: string | number;
  stale: number | string;
}

function isMetaFlowVariant(value: string | null): value is MetaFlowVariant {
  return value === 'FACEBOOK' || value === 'INSTAGRAM' || value === 'WHATSAPP_EXCLUSIVE' || value === 'WHATSAPP_COEXISTENCE';
}

function isMetaAuthVariant(value: string | null): value is MetaAuthVariant {
  return value === 'FACEBOOK_LOGIN_FOR_BUSINESS' || value === 'INSTAGRAM_LOGIN' ||
    value === 'WHATSAPP_EMBEDDED_SIGNUP' || value === 'WHATSAPP_BUSINESS_APP_ONBOARDING';
}

function publicFlowVariant(flow: string | null, auth: string | null): ConnectionCatalogReadModel['flowVariant'] | undefined {
  if (flow === 'FACEBOOK' && auth === 'FACEBOOK_LOGIN_FOR_BUSINESS') return 'FACEBOOK_LOGIN';
  if (flow === 'INSTAGRAM' && auth === 'INSTAGRAM_LOGIN') return 'INSTAGRAM_LOGIN';
  if (flow === 'INSTAGRAM' && auth === 'FACEBOOK_LOGIN_FOR_BUSINESS') return 'INSTAGRAM_VIA_FACEBOOK_LOGIN';
  if (flow === 'WHATSAPP_EXCLUSIVE' && auth === 'WHATSAPP_EMBEDDED_SIGNUP') return 'WHATSAPP_CLOUD_API';
  if (flow === 'WHATSAPP_COEXISTENCE' && auth === 'WHATSAPP_BUSINESS_APP_ONBOARDING') return 'WHATSAPP_COEXISTENCE';
  return undefined;
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
function auditOpaqueReference(value: string): string {
  return isSafeOpaqueReference(value) ? value : privacyRefHash(value);
}
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
      `SELECT id, tenant_id, app_configuration_id, provider, environment, provider_authorization_id, authorization_state,
       flow_variant, auth_variant, version,
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
    if (currentAuth && command.flowVariant !== undefined && command.authVariant !== undefined &&
        ((currentAuth.flow_variant !== null && currentAuth.flow_variant !== undefined && currentAuth.flow_variant !== command.flowVariant) ||
         (currentAuth.auth_variant !== null && currentAuth.auth_variant !== undefined && currentAuth.auth_variant !== command.authVariant))) {
      throw new MetaAssetsConflictError('Verified authorization flow/auth context cannot change.');
    }
    const authorizationState = authEvidence ? command.state : currentAuth?.authorization_state ?? 'UNKNOWN';
    const authVersion = currentAuth ? asVersion(currentAuth.version) + 1 : 1;
    if (currentAuth && command.expectedVersion !== undefined && asVersion(currentAuth.version) !== command.expectedVersion) {
      throw new MetaAssetsConflictError('Authorization version changed before the update.');
    }
    const flowVariant = authEvidence ? command.flowVariant ?? currentAuth?.flow_variant ?? null : currentAuth?.flow_variant ?? null;
    const authVariant = authEvidence ? command.authVariant ?? currentAuth?.auth_variant ?? null : currentAuth?.auth_variant ?? null;
    if (!currentAuth) {
      await manager.query(
        'INSERT INTO ca_meta_authorizations (id, tenant_id, app_configuration_id, provider, environment, flow_variant, auth_variant, provider_authorization_id, authorization_state, version, observed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
        [command.authorizationId, command.tenantId, command.appConfigurationId, command.provider, command.environment,
          flowVariant, authVariant,
          providerAuthorizationId, authorizationState, timestamp, timestamp, timestamp],
      );
    } else {
      const updateResult = await manager.query(
        'UPDATE ca_meta_authorizations SET flow_variant = COALESCE(?, flow_variant), auth_variant = COALESCE(?, auth_variant), provider_authorization_id = COALESCE(?, provider_authorization_id), authorization_state = ?, version = ?, observed_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND version = ?',
        [flowVariant, authVariant,
          providerAuthorizationId, authorizationState, authVersion, timestamp, timestamp,
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
      flowVariant,
      authVariant,
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
      actorRef: auditOpaqueReference(command.actor.ref),
      action: auditAction,
      targetRef: command.authorizationId,
      correlationId: auditOpaqueReference(command.correlationId),
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
        'SELECT aa.authorization_id, aa.asset_id, aa.credential_id, aa.state AS authorization_state, a.asset_kind, a.external_id, a.external_name, aa.verification_state, aa.subscription_state, aa.projection_state, aa.version, aa.updated_at FROM ca_meta_asset_authorizations aa INNER JOIN ca_meta_assets a ON a.tenant_id = aa.tenant_id AND a.id = aa.asset_id WHERE aa.tenant_id = ? AND aa.app_configuration_id = ? AND aa.environment = ? AND aa.authorization_id IN (' + placeholders + ') AND aa.state <> \'REVOKED\' ORDER BY aa.authorization_id, a.external_id',
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

  async listAssetCatalog(input: AssetCatalogPageQuery): Promise<AssetCatalogPage> {
    const maximumPage = input.authorizationRef ? 500 : 50;
    if (!isUuid(input.tenantId) || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > maximumPage ||
        (input.authorizationRef !== undefined && !isUuid(input.authorizationRef))) {
      throw new MetaAssetsConflictError('Asset catalog query is invalid.');
    }
    const dataSource = await this.database.getDataSource();
    const activeVerified = `MAX(CASE WHEN aa.state = 'ACTIVE' AND aa.verification_state = 'VERIFIED' AND auth.authorization_state = 'ACTIVE' THEN 1 ELSE 0 END)`;
    const revoked = `MAX(CASE WHEN aa.state = 'REVOKED' OR auth.authorization_state IN ('REVOKED', 'DISCONNECTED') THEN 1 ELSE 0 END)`;
    const statusExpression = `CASE
      WHEN MAX(auth.observed_at) < DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 24 HOUR) THEN 'STALE'
      WHEN ${activeVerified} = 1 THEN 'ACTIVE'
      WHEN ${revoked} = 1 THEN 'INACTIVE'
      ELSE 'UNKNOWN' END`;
    const authorizationStatusExpression = `CASE
      WHEN ${activeVerified} = 1 THEN 'VERIFIED'
      WHEN ${revoked} = 1 THEN 'REVOKED'
      ELSE 'UNKNOWN' END`;
    const clauses = [
      'a.tenant_id = ?',
      'a.environment = ?',
      "app.provider = 'META'",
    ];
    const values: Array<string | number> = [input.tenantId, input.environment];
    if (input.assetRef) { clauses.push('a.id = ?'); values.push(input.assetRef); }
    if (input.authorizationRef) { clauses.push('auth.id = ?'); values.push(input.authorizationRef); }
    if (input.cursor) { clauses.push('a.id > ?'); values.push(input.cursor); }
    if (input.channel === 'FACEBOOK') { clauses.push("auth.flow_variant = 'FACEBOOK'"); }
    if (input.channel === 'INSTAGRAM') { clauses.push("auth.flow_variant = 'INSTAGRAM'"); }
    if (input.channel === 'WHATSAPP') { clauses.push("auth.flow_variant IN ('WHATSAPP_EXCLUSIVE', 'WHATSAPP_COEXISTENCE')"); }
    if (input.number !== undefined) {
      clauses.push("a.asset_kind = 'WHATSAPP_PHONE_NUMBER' AND a.external_id = ?");
      values.push(input.number);
    }
    values.push(input.limit + 1);
    const rows = await dataSource.query(
      `SELECT a.id, a.app_configuration_id, a.asset_kind,
              ${statusExpression} AS status,
              ${authorizationStatusExpression} AS authorization_status,
              MAX(auth.observed_at) AS observed_at,
              MAX(CASE WHEN auth.authorization_state = 'REAUTH_REQUIRED' THEN 1 ELSE 0 END) AS reauthorization_required
       FROM ca_meta_assets a
       INNER JOIN ca_meta_app_configurations app
         ON app.tenant_id = a.tenant_id AND app.id = a.app_configuration_id
        AND app.provider = 'META' AND app.environment = a.environment
       INNER JOIN ca_meta_asset_authorizations aa
         ON aa.tenant_id = a.tenant_id AND aa.asset_id = a.id
        AND aa.app_configuration_id = a.app_configuration_id AND aa.environment = a.environment
       INNER JOIN ca_meta_authorizations auth
         ON auth.tenant_id = aa.tenant_id AND auth.id = aa.authorization_id
        AND auth.app_configuration_id = aa.app_configuration_id AND auth.environment = aa.environment
       WHERE ${clauses.join(' AND ')}
       GROUP BY a.id, a.asset_kind
       ${input.status ? `HAVING ${statusExpression} = ?` : ''}
       ORDER BY a.id ASC LIMIT ?`,
      input.status ? [...values.slice(0, -1), input.status, input.limit + 1] : values,
    ) as AssetCatalogRow[];
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const assetIds = pageRows.map((row) => row.id);
    const appConfigurationIds = [...new Set(pageRows.map((row) => row.app_configuration_id))];
    const capabilityRows = assetIds.length === 0 ? [] : await dataSource.query(
      `SELECT aa.asset_id, aa.authorization_id, aa.state AS asset_authorization_state,
              aa.verification_state, auth.flow_variant, auth.auth_variant, auth.authorization_state,
              g.grant_name
       FROM ca_meta_asset_authorizations aa
       INNER JOIN ca_meta_authorizations auth
         ON auth.tenant_id = aa.tenant_id AND auth.id = aa.authorization_id
        AND auth.app_configuration_id = aa.app_configuration_id AND auth.environment = aa.environment
       INNER JOIN ca_meta_app_configurations app
         ON app.tenant_id = aa.tenant_id AND app.id = aa.app_configuration_id
        AND app.provider = 'META' AND app.environment = aa.environment
       LEFT JOIN ca_meta_asset_grants g
         ON g.tenant_id = aa.tenant_id AND g.authorization_id = aa.authorization_id
        AND g.asset_id = aa.asset_id AND g.app_configuration_id = aa.app_configuration_id
        AND g.environment = aa.environment AND g.status = 'GRANTED'
       WHERE aa.tenant_id = ? AND aa.environment = ?
         AND aa.app_configuration_id IN (${appConfigurationIds.map(() => '?').join(', ')})
         AND aa.asset_id IN (${assetIds.map(() => '?').join(', ')})
       ORDER BY aa.asset_id, aa.authorization_id, g.grant_name`,
      [input.tenantId, input.environment, ...appConfigurationIds, ...assetIds],
    ) as Array<{
      asset_id: string; authorization_id: string; asset_authorization_state: AssetAuthorizationState;
      verification_state: AssetVerificationState; flow_variant: string | null; auth_variant: string | null;
      authorization_state: AuthorizationState; grant_name: string | null;
    }>;
    const evidenceByAsset = new Map<string, Map<string, { evidence: Omit<AssetCapabilityEvidence, 'grantNames'>; grants: Set<string> }>>();
    for (const row of capabilityRows) {
      let byAuthorization = evidenceByAsset.get(row.asset_id);
      if (!byAuthorization) { byAuthorization = new Map(); evidenceByAsset.set(row.asset_id, byAuthorization); }
      let entry = byAuthorization.get(row.authorization_id);
      if (!entry) {
        entry = {
          evidence: {
            flowVariant: isMetaFlowVariant(row.flow_variant) ? row.flow_variant : null,
            authVariant: isMetaAuthVariant(row.auth_variant) ? row.auth_variant : null,
            authorizationState: row.authorization_state,
            assetAuthorizationState: row.asset_authorization_state,
            verificationState: row.verification_state,
          },
          grants: new Set(),
        };
        byAuthorization.set(row.authorization_id, entry);
      }
      if (row.grant_name) entry.grants.add(row.grant_name);
    }
    const items = pageRows.flatMap((row) => {
      if (!isMetaAssetKind(row.asset_kind)) return [];
      const evidence = [...(evidenceByAsset.get(row.id)?.values() ?? [])].map((entry) => Object.freeze({
        ...entry.evidence, grantNames: Object.freeze([...entry.grants].sort()),
      }));
      return [Object.freeze({
        assetRef: row.id,
        appConfigurationId: row.app_configuration_id,
        kind: row.asset_kind,
        status: row.status,
        authorizationStatus: row.authorization_status,
        observedAt: formatDate(row.observed_at),
        stale: row.status === 'STALE',
        capabilityEvidence: Object.freeze(evidence),
        reauthorizationRequired: Number(row.reauthorization_required) === 1,
      })];
    });
    return Object.freeze({
      items: Object.freeze(items),
      nextCursor: hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1]!.id : null,
    });
  }

  async findAssetCatalog(input: { readonly tenantId: string; readonly environment: MetaEnvironment; readonly assetRef: string }): Promise<AssetCatalogReadModel | undefined> {
    if (!isUuid(input.tenantId) || !isUuid(input.assetRef)) return undefined;
    const page = await this.listAssetCatalog({
      tenantId: input.tenantId, environment: input.environment, assetRef: input.assetRef, limit: 1,
    });
    return page.items[0];
  }

  async listConnectionCatalog(input: ConnectionCatalogPageQuery): Promise<ConnectionCatalogPage> {
    if (!isUuid(input.tenantId) || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50 ||
        (input.connectionRef !== undefined && !isUuid(input.connectionRef))) {
      throw new MetaAssetsConflictError('Connection catalog query is invalid.');
    }
    const dataSource = await this.database.getDataSource();
    const connectionStatus = `CASE WHEN auth.authorization_state IN ('REVOKED', 'DISCONNECTED') THEN 'DISCONNECTED'
      WHEN auth.authorization_state IN ('ACTIVE', 'PARTIAL', 'REAUTH_REQUIRED', 'UNKNOWN') THEN auth.authorization_state ELSE 'UNKNOWN' END`;
    const verifiedCount = `COUNT(DISTINCT CASE WHEN aa.state = 'ACTIVE' AND aa.verification_state = 'VERIFIED' THEN aa.asset_id END)`;
    const clauses = [
      'auth.tenant_id = ?', 'auth.environment = ?', "app.provider = 'META'",
      `((auth.flow_variant = 'FACEBOOK' AND auth.auth_variant = 'FACEBOOK_LOGIN_FOR_BUSINESS') OR
        (auth.flow_variant = 'INSTAGRAM' AND auth.auth_variant IN ('FACEBOOK_LOGIN_FOR_BUSINESS', 'INSTAGRAM_LOGIN')) OR
        (auth.flow_variant = 'WHATSAPP_EXCLUSIVE' AND auth.auth_variant = 'WHATSAPP_EMBEDDED_SIGNUP') OR
        (auth.flow_variant = 'WHATSAPP_COEXISTENCE' AND auth.auth_variant = 'WHATSAPP_BUSINESS_APP_ONBOARDING'))`,
    ];
    const values: Array<string | number> = [input.tenantId, input.environment];
    if (input.connectionRef) { clauses.push('auth.id = ?'); values.push(input.connectionRef); }
    if (input.cursor) { clauses.push('auth.id > ?'); values.push(input.cursor); }
    if (input.channel === 'FACEBOOK') clauses.push("auth.flow_variant = 'FACEBOOK'");
    if (input.channel === 'INSTAGRAM') clauses.push("auth.flow_variant = 'INSTAGRAM'");
    if (input.channel === 'WHATSAPP') clauses.push("auth.flow_variant IN ('WHATSAPP_EXCLUSIVE', 'WHATSAPP_COEXISTENCE')");
    if (input.number !== undefined) {
      clauses.push(`EXISTS (SELECT 1 FROM ca_meta_asset_authorizations naa
        INNER JOIN ca_meta_assets na ON na.tenant_id = naa.tenant_id AND na.id = naa.asset_id
         AND na.app_configuration_id = naa.app_configuration_id AND na.environment = naa.environment
        WHERE naa.tenant_id = auth.tenant_id AND naa.authorization_id = auth.id
          AND naa.app_configuration_id = auth.app_configuration_id AND naa.environment = auth.environment
          AND na.asset_kind = 'WHATSAPP_PHONE_NUMBER' AND na.external_id = ?)`);
      values.push(input.number);
    }
    values.push(input.limit + 1);
    const rows = await dataSource.query(
      `SELECT auth.id, auth.flow_variant, auth.auth_variant, auth.authorization_state, auth.observed_at,
              COUNT(DISTINCT aa.asset_id) AS asset_count, ${verifiedCount} AS verified_asset_count,
              CASE WHEN auth.observed_at < DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 24 HOUR) THEN 1 ELSE 0 END AS stale
       FROM ca_meta_authorizations auth
       INNER JOIN ca_meta_app_configurations app
         ON app.tenant_id = auth.tenant_id AND app.id = auth.app_configuration_id
        AND app.provider = 'META' AND app.environment = auth.environment
       LEFT JOIN ca_meta_asset_authorizations aa
         ON aa.tenant_id = auth.tenant_id AND aa.authorization_id = auth.id
        AND aa.app_configuration_id = auth.app_configuration_id AND aa.environment = auth.environment
       WHERE ${clauses.join(' AND ')}
       GROUP BY auth.id, auth.flow_variant, auth.auth_variant, auth.authorization_state, auth.observed_at
       ${input.status ? `HAVING ${connectionStatus} = ?` : ''}
       ORDER BY auth.id ASC LIMIT ?`,
      input.status ? [...values.slice(0, -1), input.status, input.limit + 1] : values,
    ) as ConnectionCatalogRow[];
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const items = pageRows.flatMap((row): ConnectionCatalogReadModel[] => {
      const flowVariant = publicFlowVariant(row.flow_variant, row.auth_variant);
      if (!flowVariant) return [];
      const state: ConnectionCatalogReadModel['status'] = row.authorization_state === 'REVOKED' || row.authorization_state === 'DISCONNECTED'
        ? 'DISCONNECTED'
        : row.authorization_state === 'ACTIVE' || row.authorization_state === 'PARTIAL' || row.authorization_state === 'REAUTH_REQUIRED'
          ? row.authorization_state : 'UNKNOWN';
      const stale = Number(row.stale) === 1;
      const verifiedAssets = Number(row.verified_asset_count);
      const readiness: ConnectionCatalogReadModel['readiness'] = stale ? 'UNKNOWN'
        : state === 'ACTIVE' && verifiedAssets > 0 ? 'READY'
          : state === 'ACTIVE' || state === 'PARTIAL' || state === 'REAUTH_REQUIRED' ? 'PARTIAL' : 'UNKNOWN';
      return [Object.freeze({ connectionRef: row.id, flowVariant, status: state, readiness,
        observedAt: formatDate(row.observed_at), stale, assetCount: Number(row.asset_count) })];
    });
    return Object.freeze({ items: Object.freeze(items), nextCursor: hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1]!.id : null });
  }

  async findConnectionCatalog(input: { readonly tenantId: string; readonly environment: MetaEnvironment; readonly connectionRef: string }): Promise<ConnectionCatalogReadModel | undefined> {
    if (!isUuid(input.tenantId) || !isUuid(input.connectionRef)) return undefined;
    const page = await this.listConnectionCatalog({ ...input, limit: 1 });
    const connection = page.items[0];
    if (!connection) return undefined;
    const assets = await this.listAssetCatalog({ tenantId: input.tenantId, environment: input.environment,
      authorizationRef: connection.connectionRef, limit: 500 });
    return Object.freeze({ ...connection, assets: assets.items });
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
    if (input.credentialId !== undefined) {
      const credentialRows = await manager.query(
        `SELECT id FROM ca_meta_credentials WHERE tenant_id = ? AND id = ? AND authorization_id = ?
           AND app_configuration_id = ? AND provider = ? AND environment = ? AND status = 'ACTIVE' FOR UPDATE`,
        [command.tenantId, input.credentialId, command.authorizationId, command.appConfigurationId, command.provider, command.environment],
      ) as Array<{ id: string }>;
      if (credentialRows.length !== 1) throw new MetaAssetsConflictError('Credential binding is not active in the exact authorization context.');
    }
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
      'SELECT credential_id, state, verification_state, verification_source, version FROM ca_meta_asset_authorizations WHERE tenant_id = ? AND authorization_id = ? AND asset_id = ? FOR UPDATE',
      [command.tenantId, command.authorizationId, asset.id],
    ) as Array<{ credential_id: string | null; state: AssetAuthorizationState; verification_state: AssetVerificationState; verification_source: string; version: number | string }>;
    const existingLink = linkRows[0];
    const newCredentialReauthorization = existingLink?.state === 'REVOKED' && input.credentialId !== undefined &&
      input.credentialId !== existingLink.credential_id && evidence !== undefined;
    if (existingLink?.state === 'REVOKED' && input.credentialId !== undefined && !newCredentialReauthorization) {
      throw new MetaAssetsConflictError('A revoked asset authorization can only bind a different credential with trusted provider evidence.');
    }
    if (existingLink?.credential_id && input.credentialId && existingLink.credential_id !== input.credentialId &&
        existingLink.state !== 'REVOKED') {
      throw new MetaAssetsConflictError('An existing asset authorization cannot be rebound to another credential.');
    }
    const credentialId = input.credentialId ?? existingLink?.credential_id ?? null;
    const authorizationState: AssetAuthorizationState = existingLink?.state === 'REVOKED'
      ? newCredentialReauthorization ? 'ACTIVE' : 'REVOKED'
      : credentialId ? 'ACTIVE' : 'QUARANTINED';
    const verificationState: AssetVerificationState = evidence || existingLink?.verification_state === 'VERIFIED' ? 'VERIFIED' : 'CLAIMED';
    const verificationSource = evidence?.source ?? existingLink?.verification_source ?? 'BROWSER_CLAIM';
    const verificationRefHash = evidence?.observationRefHash ?? null;
    const verifiedAt = evidence ? timestamp : null;
    if (!existingLink) {
      await manager.query(
        'INSERT INTO ca_meta_asset_authorizations (tenant_id, authorization_id, asset_id, app_configuration_id, provider, environment, credential_id, state, verification_state, verification_source, verification_ref_hash, verified_at, subscription_state, projection_state, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'UNKNOWN\', \'UNKNOWN\', 1, ?, ?)',
        [command.tenantId, command.authorizationId, asset.id, command.appConfigurationId, command.provider, command.environment,
          credentialId, authorizationState, verificationState, verificationSource, verificationRefHash, verifiedAt, timestamp, timestamp],
      );
    } else {
      await manager.query(
        'UPDATE ca_meta_asset_authorizations SET credential_id = COALESCE(?, credential_id), state = ?, verification_state = ?, verification_source = ?, verification_ref_hash = COALESCE(?, verification_ref_hash), verified_at = COALESCE(?, verified_at), version = version + 1, updated_at = ? WHERE tenant_id = ? AND authorization_id = ? AND asset_id = ? AND version = ?',
        [credentialId, authorizationState, verificationState, verificationSource, verificationRefHash, verifiedAt, timestamp, command.tenantId, command.authorizationId, asset.id, existingLink.version],
      );
    }

    const currentGrants = authorizationState === 'REVOKED' ? [] :
      await this.persistAssetGrants(manager, command, input, asset.id, timestamp, evidence?.source);
    const assetVersion = nextVersion;
    const snapshot = {
      assetRef: asset.id, kind: input.kind, externalId: input.externalId,
      externalName: evidence ? input.externalName ?? asset.external_name : asset.external_name,
      authorizationState, credentialBindingState: credentialId ? 'BOUND' : 'UNKNOWN',
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
        authorizationState: asset.authorization_state,
        credentialBindingState: asset.credential_id ? 'BOUND' : 'UNKNOWN',
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
