import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import { isMetaAssetKind } from '../meta-assets/meta-assets.types.js';
import type {
  CredentialLineageStep,
  CredentialOperationPolicy,
  CredentialResolutionCandidate,
  CredentialResolutionContext,
  CredentialResolutionRepository,
  CredentialResolutionSnapshot,
} from './credential-resolver.types.js';

const MAX_ANCESTRY_DEPTH = 4;
const MAX_CANDIDATES = 1000;

interface AssetRow { id: string; kind: string; version: string | number }
interface RelationRow {
  child_asset_id: string;
  child_kind: string;
  relation_type: string;
  parent_asset_id: string;
  parent_kind: string;
}
interface CandidateRow {
  tenant_id: string;
  credential_id: string;
  authorization_id: string;
  app_configuration_id: string;
  provider: string;
  environment: string;
  family: string;
  authorization_state: string;
  authorization_version: string | number;
  credential_status: string;
  credential_version: string | number;
  asset_auth_state: string;
  verification_state: string;
  asset_auth_version: string | number;
  grant_asset_id: string;
  grant_asset_kind: string;
  secret_version: string | number;
}
interface GrantRow { authorization_id: string; asset_id: string; grant_name: string; status: string }
interface ScopeRow { authorization_id: string; scope_name: string; status: string }
interface AncestryPath {
  readonly assetId: string;
  readonly kind: string;
  readonly lineage: readonly CredentialLineageStep[];
}

function placeholders(count: number): string {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('invalid-resolver-query-size');
  return new Array(count).fill('?').join(', ');
}

function version(value: string | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error('invalid-resolver-version');
  return result;
}

function knownAuthorizationState(value: string): CredentialResolutionCandidate['authorizationState'] {
  return ['ACTIVE', 'PARTIAL', 'REAUTH_REQUIRED', 'UNKNOWN', 'REVOKED', 'DISCONNECTED'].includes(value)
    ? value as CredentialResolutionCandidate['authorizationState']
    : 'UNKNOWN';
}

function knownCredentialStatus(value: string): CredentialResolutionCandidate['credentialStatus'] {
  return ['ACTIVE', 'REVOKED', 'REAUTH_REQUIRED', 'UNKNOWN'].includes(value)
    ? value as CredentialResolutionCandidate['credentialStatus']
    : 'UNKNOWN';
}

function knownAssetAuthorizationState(value: string): CredentialResolutionCandidate['assetAuthorizationState'] {
  return ['ACTIVE', 'REVOKED', 'QUARANTINED'].includes(value)
    ? value as CredentialResolutionCandidate['assetAuthorizationState']
    : 'QUARANTINED';
}

/**
 * Reads only metadata. Ciphertext, nonce, authentication tags and provider credentials are never
 * selected into this resolver query. Expiry/health remain UNKNOWN until M3.09 persists evidence.
 */
export class MysqlCredentialResolutionRepository implements CredentialResolutionRepository {
  constructor(private readonly database: DurableWorkDatabase) {}

  async inspect(context: CredentialResolutionContext, policy: CredentialOperationPolicy): Promise<CredentialResolutionSnapshot> {
    const dataSource = await this.database.getDataSource();
    const assetRows = await dataSource.query(
      `SELECT a.id, a.asset_kind AS kind, a.version
       FROM ca_meta_assets a
       WHERE a.tenant_id = ? AND a.id = ? AND a.app_configuration_id = ? AND a.provider = ? AND a.environment = ?
         AND EXISTS (
           SELECT 1
           FROM ca_meta_asset_authorizations aa
           JOIN ca_meta_authorizations auth ON auth.tenant_id = aa.tenant_id
             AND auth.id = aa.authorization_id AND auth.app_configuration_id = aa.app_configuration_id
             AND auth.provider = aa.provider AND auth.environment = aa.environment
           WHERE aa.tenant_id = a.tenant_id AND aa.asset_id = a.id
             AND aa.app_configuration_id = a.app_configuration_id AND aa.provider = a.provider
             AND aa.environment = a.environment AND aa.state = 'ACTIVE'
             AND aa.verification_state = 'VERIFIED' AND auth.authorization_state IN ('ACTIVE', 'PARTIAL')
         )
       LIMIT 1`,
      [context.tenantId, context.assetId, context.appConfigurationId, context.provider, context.environment],
    ) as AssetRow[];
    const assetRow = assetRows[0];
    if (!assetRow || !isMetaAssetKind(assetRow.kind)) return Object.freeze({ candidates: Object.freeze([]) });
    const asset = Object.freeze({ assetId: assetRow.id, kind: assetRow.kind, verified: true, version: version(assetRow.version) });
    const ancestry = await this.loadAncestry(context, policy, asset.assetId, asset.kind, dataSource);
    const assetIds = [...ancestry.keys()];
    if (assetIds.length === 0 || policy.allowedFamilies.length === 0) return Object.freeze({ asset, candidates: Object.freeze([]) });

    const candidateRows = await dataSource.query(
      `SELECT c.tenant_id, c.id AS credential_id, c.authorization_id, c.app_configuration_id,
              c.provider, c.environment, c.family, c.status AS credential_status, c.version AS credential_version,
              auth.authorization_state, auth.version AS authorization_version,
              aa.state AS asset_auth_state, aa.verification_state, aa.version AS asset_auth_version,
              aa.asset_id AS grant_asset_id, grant_asset.asset_kind AS grant_asset_kind,
              secret.version AS secret_version
       FROM ca_meta_asset_authorizations aa
       JOIN ca_meta_assets grant_asset ON grant_asset.tenant_id = aa.tenant_id
         AND grant_asset.id = aa.asset_id AND grant_asset.app_configuration_id = aa.app_configuration_id
         AND grant_asset.provider = aa.provider AND grant_asset.environment = aa.environment
       JOIN ca_meta_authorizations auth ON auth.tenant_id = aa.tenant_id
         AND auth.id = aa.authorization_id AND auth.app_configuration_id = aa.app_configuration_id
         AND auth.provider = aa.provider AND auth.environment = aa.environment
       JOIN ca_meta_credentials c ON c.tenant_id = auth.tenant_id AND c.authorization_id = auth.id
         AND c.app_configuration_id = auth.app_configuration_id AND c.provider = auth.provider
         AND c.environment = auth.environment
       JOIN ca_meta_credential_secrets secret ON secret.tenant_id = c.tenant_id
         AND secret.credential_id = c.id AND secret.authorization_id = c.authorization_id
         AND secret.app_configuration_id = c.app_configuration_id AND secret.provider = c.provider
         AND secret.environment = c.environment
       WHERE aa.tenant_id = ? AND aa.app_configuration_id = ? AND aa.provider = ? AND aa.environment = ?
         AND aa.asset_id IN (${placeholders(assetIds.length)}) AND c.family IN (${placeholders(policy.allowedFamilies.length)})
       ORDER BY c.id, auth.id, aa.asset_id LIMIT ${MAX_CANDIDATES + 1}`,
      [context.tenantId, context.appConfigurationId, context.provider, context.environment, ...assetIds, ...policy.allowedFamilies],
    ) as CandidateRow[];
    if (candidateRows.length > MAX_CANDIDATES) throw new Error('resolver-candidate-limit-exceeded');
    if (candidateRows.length === 0) return Object.freeze({ asset, candidates: Object.freeze([]) });

    const authorizationIds = [...new Set(candidateRows.map((row) => row.authorization_id))];
    const [grantRows, scopeRows] = await Promise.all([
      dataSource.query(
        `SELECT authorization_id, asset_id, grant_name, status
         FROM ca_meta_asset_grants
         WHERE tenant_id = ? AND app_configuration_id = ? AND provider = ? AND environment = ?
           AND authorization_id IN (${placeholders(authorizationIds.length)})
           AND asset_id IN (${placeholders(assetIds.length)})`,
        [context.tenantId, context.appConfigurationId, context.provider, context.environment, ...authorizationIds, ...assetIds],
      ) as Promise<GrantRow[]>,
      dataSource.query(
        `SELECT authorization_id, scope_name, status
         FROM ca_meta_authorization_scopes
         WHERE tenant_id = ? AND app_configuration_id = ? AND provider = ? AND environment = ?
           AND authorization_id IN (${placeholders(authorizationIds.length)})`,
        [context.tenantId, context.appConfigurationId, context.provider, context.environment, ...authorizationIds],
      ) as Promise<ScopeRow[]>,
    ]);
    const grants = new Map<string, string[]>();
    for (const row of grantRows) {
      if (row.status !== 'GRANTED') continue;
      const key = row.authorization_id + '\0' + row.asset_id;
      const values = grants.get(key) ?? [];
      values.push(row.grant_name);
      grants.set(key, values);
    }
    const scopes = new Map<string, string[]>();
    for (const row of scopeRows) {
      if (row.status !== 'GRANTED') continue;
      const values = scopes.get(row.authorization_id) ?? [];
      values.push(row.scope_name);
      scopes.set(row.authorization_id, values);
    }
    const candidates = candidateRows.flatMap((row) => {
      const path = ancestry.get(row.grant_asset_id);
      if (!path || !isMetaAssetKind(row.grant_asset_kind)) return [];
      return [Object.freeze({
        binding: Object.freeze({
          tenantId: row.tenant_id,
          credentialId: row.credential_id,
          authorizationId: row.authorization_id,
          appConfigurationId: row.app_configuration_id,
          provider: 'META' as const,
          environment: row.environment,
          family: row.family,
        }),
        authorizationState: knownAuthorizationState(row.authorization_state),
        authorizationVersion: version(row.authorization_version),
        credentialStatus: knownCredentialStatus(row.credential_status),
        credentialVersion: version(row.credential_version),
        assetAuthorizationState: knownAssetAuthorizationState(row.asset_auth_state),
        assetVerificationState: row.verification_state === 'VERIFIED' ? 'VERIFIED' as const : 'CLAIMED' as const,
        assetAuthorizationVersion: version(row.asset_auth_version),
        grantAssetId: row.grant_asset_id,
        grantAssetKind: row.grant_asset_kind,
        lineage: path.lineage,
        grantedAssetGrants: Object.freeze(grants.get(row.authorization_id + '\0' + row.grant_asset_id) ?? []),
        grantedAuthorizationScopes: Object.freeze(scopes.get(row.authorization_id) ?? []),
        secretAvailable: true,
        secretVersion: version(row.secret_version),
        health: Object.freeze({ state: 'UNKNOWN' as const }),
        expiry: Object.freeze({ state: 'UNKNOWN' as const }),
      })];
    });
    return Object.freeze({ asset, candidates: Object.freeze(candidates) });
  }

  private async loadAncestry(context: CredentialResolutionContext, policy: CredentialOperationPolicy,
    assetId: string, assetKind: string, dataSource: Awaited<ReturnType<DurableWorkDatabase['getDataSource']>>): Promise<Map<string, AncestryPath>> {
    const result = new Map<string, AncestryPath>();
    const first: AncestryPath = Object.freeze({ assetId, kind: assetKind, lineage: Object.freeze([]) });
    result.set(assetId, first);
    let frontier = [first];
    const seenPerPath = new Set([assetId]);
    for (let depth = 0; depth < MAX_ANCESTRY_DEPTH && policy.ancestryRules.length > 0 && frontier.length > 0; depth += 1) {
      const childIds = [...new Set(frontier.map((item) => item.assetId))];
      const relationTypes = [...new Set(policy.ancestryRules.map((rule) => rule.relationType))];
      const rows = await dataSource.query(
        `SELECT ar.source_asset_id AS child_asset_id, child.asset_kind AS child_kind,
                ar.relation_type, ar.target_asset_id AS parent_asset_id,
                parent.asset_kind AS parent_kind
         FROM ca_meta_asset_relations ar
         JOIN ca_meta_assets child ON child.tenant_id = ar.tenant_id
           AND child.id = ar.source_asset_id AND child.app_configuration_id = ar.app_configuration_id
           AND child.provider = ar.provider AND child.environment = ar.environment
         JOIN ca_meta_assets parent ON parent.tenant_id = ar.tenant_id
           AND parent.id = ar.target_asset_id AND parent.app_configuration_id = ar.app_configuration_id
           AND parent.provider = ar.provider AND parent.environment = ar.environment
         WHERE ar.tenant_id = ? AND ar.app_configuration_id = ? AND ar.provider = ?
           AND ar.environment = ? AND ar.source_asset_id IN (${placeholders(childIds.length)})
           AND ar.relation_type IN (${placeholders(relationTypes.length)})
           AND ar.verification_source IN ('META_API', 'SIGNED_WEBHOOK')
           AND ar.verification_ref_hash IS NOT NULL AND ar.verified_at IS NOT NULL
         ORDER BY ar.source_asset_id, ar.relation_type, ar.target_asset_id`,
        [context.tenantId, context.appConfigurationId, context.provider, context.environment, ...childIds, ...relationTypes],
      ) as RelationRow[];
      const next: AncestryPath[] = [];
      for (const row of rows) {
        const parent = frontier.find((item) => item.assetId === row.child_asset_id);
        const rule = policy.ancestryRules.find((item) => item.relationType === row.relation_type &&
          item.childKind === row.child_kind && item.parentKind === row.parent_kind);
        if (!parent || !rule || !isMetaAssetKind(row.child_kind) || !isMetaAssetKind(row.parent_kind) ||
            parent.kind !== row.child_kind || parent.assetId === row.parent_asset_id) continue;
        const lineage = Object.freeze([...parent.lineage, Object.freeze({
          childAssetId: row.child_asset_id,
          childKind: row.child_kind,
          relationType: row.relation_type as CredentialLineageStep['relationType'],
          parentAssetId: row.parent_asset_id,
          parentKind: row.parent_kind,
          verified: true,
        })]);
        const path: AncestryPath = Object.freeze({ assetId: row.parent_asset_id, kind: row.parent_kind, lineage });
        const existing = result.get(path.assetId);
        const pathKey = path.lineage.map((step) => step.relationType + ':' + step.parentAssetId).join('|');
        if (!existing || path.lineage.length < existing.lineage.length ||
            path.lineage.length === existing.lineage.length && pathKey < existing.lineage.map((step) => step.relationType + ':' + step.parentAssetId).join('|')) {
          result.set(path.assetId, path);
        }
        if (!seenPerPath.has(path.assetId)) next.push(path);
        seenPerPath.add(path.assetId);
      }
      frontier = next;
    }
    return result;
  }
}
