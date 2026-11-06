import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { MetaEnvironment } from '../meta-assets/meta-assets.types.js';
import type { MetaAuthenticationVariant, MetaFlowVariant } from '../credentials/credential-resolver.types.js';
import type { MetaSubscriptionCatalog, MetaSubscriptionTargetContext } from './meta-subscriptions.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,128}$/;

interface AssetContextRow {
  readonly authorization_id: string;
  readonly authorization_state: string;
  readonly flow_variant: string | null;
  readonly auth_variant: string | null;
  readonly asset_id: string;
  readonly asset_kind: string;
  readonly external_id: string;
  readonly asset_state: string;
  readonly verification_state: string;
  readonly credential_id: string | null;
  readonly asset_version: string | number;
  readonly authorization_version: string | number;
}

function isFlow(value: string | null): value is MetaFlowVariant {
  return value === 'WHATSAPP_EXCLUSIVE' || value === 'WHATSAPP_COEXISTENCE';
}

function isAuth(value: string | null, flow: MetaFlowVariant): value is MetaAuthenticationVariant {
  return flow === 'WHATSAPP_EXCLUSIVE' ? value === 'WHATSAPP_EMBEDDED_SIGNUP' : value === 'WHATSAPP_BUSINESS_APP_ONBOARDING';
}

function oneEligible(rows: readonly AssetContextRow[]): AssetContextRow | undefined {
  const eligible = rows.filter((row) => row.authorization_state === 'ACTIVE' && row.asset_state === 'ACTIVE' &&
    row.verification_state === 'VERIFIED' && row.credential_id !== null && isFlow(row.flow_variant) &&
    isAuth(row.auth_variant, row.flow_variant));
  return eligible.length === 1 ? eligible[0] : undefined;
}

/** Resolve Graph IDs only from the tenant/app/environment scoped catalog. */
export class MysqlMetaSubscriptionCatalog implements MetaSubscriptionCatalog {
  constructor(private readonly database: DurableWorkDatabase) {}

  async resolveByAsset(input: { readonly tenantId: string; readonly appConfigurationId: string;
    readonly environment: MetaEnvironment; readonly assetId: string }): Promise<MetaSubscriptionTargetContext | undefined> {
    if (!UUID.test(input.tenantId) || !UUID.test(input.appConfigurationId) || !UUID.test(input.assetId) || !this.validEnvironment(input.environment)) return undefined;
    const sourceRows = await this.queryAsset(input.tenantId, input.appConfigurationId, input.environment, input.assetId);
    const source = oneEligible(sourceRows);
    if (!source || !isFlow(source.flow_variant) || !isAuth(source.auth_variant, source.flow_variant)) return undefined;

    let targetId = source.asset_id;
    if (source.asset_kind === 'WHATSAPP_PHONE_NUMBER') {
      const dataSource = await this.database.getDataSource();
      const relationRows = await dataSource.query(
        `SELECT target_asset_id FROM ca_meta_asset_relations
         WHERE tenant_id = ? AND app_configuration_id = ? AND provider = 'META' AND environment = ?
           AND source_asset_id = ? AND relation_type = 'PHONE_TO_ACCOUNT'
         ORDER BY target_asset_id`,
        [input.tenantId, input.appConfigurationId, input.environment, input.assetId],
      ) as Array<{ readonly target_asset_id: string }>;
      if (relationRows.length !== 1 || !UUID.test(relationRows[0]?.target_asset_id ?? '')) return undefined;
      targetId = relationRows[0]!.target_asset_id;
    } else if (source.asset_kind !== 'WHATSAPP_BUSINESS_ACCOUNT') {
      return undefined;
    }

    const targetRows = await this.queryAsset(input.tenantId, input.appConfigurationId, input.environment, targetId, source.authorization_id);
    const target = oneEligible(targetRows);
    if (!target || target.asset_kind !== 'WHATSAPP_BUSINESS_ACCOUNT' || target.authorization_id !== source.authorization_id ||
        target.flow_variant !== source.flow_variant || target.auth_variant !== source.auth_variant || !PROVIDER_ID.test(target.external_id)) return undefined;
    return this.context(input, source, target);
  }

  async resolveTarget(input: { readonly tenantId: string; readonly appConfigurationId: string;
    readonly environment: MetaEnvironment; readonly targetAssetId: string }): Promise<MetaSubscriptionTargetContext | undefined> {
    if (!UUID.test(input.tenantId) || !UUID.test(input.appConfigurationId) || !UUID.test(input.targetAssetId) || !this.validEnvironment(input.environment)) return undefined;
    const rows = await this.queryAsset(input.tenantId, input.appConfigurationId, input.environment, input.targetAssetId);
    const target = oneEligible(rows);
    if (!target || target.asset_kind !== 'WHATSAPP_BUSINESS_ACCOUNT' || !isFlow(target.flow_variant) ||
        !isAuth(target.auth_variant, target.flow_variant) || !PROVIDER_ID.test(target.external_id)) return undefined;
    return this.context(input, target, target);
  }

  private async queryAsset(tenantId: string, appConfigurationId: string, environment: MetaEnvironment,
    assetId: string, authorizationId?: string): Promise<AssetContextRow[]> {
    const dataSource = await this.database.getDataSource();
    return await dataSource.query(
      `SELECT auth.id AS authorization_id, auth.authorization_state, auth.flow_variant, auth.auth_variant,
              a.id AS asset_id, a.asset_kind, a.external_id, aa.state AS asset_state,
              aa.verification_state, aa.credential_id, aa.version AS asset_version, auth.version AS authorization_version
       FROM ca_meta_asset_authorizations aa
       INNER JOIN ca_meta_assets a ON a.tenant_id = aa.tenant_id AND a.id = aa.asset_id
         AND a.app_configuration_id = aa.app_configuration_id AND a.provider = aa.provider AND a.environment = aa.environment
       INNER JOIN ca_meta_authorizations auth ON auth.tenant_id = aa.tenant_id AND auth.id = aa.authorization_id
         AND auth.app_configuration_id = aa.app_configuration_id AND auth.provider = aa.provider AND auth.environment = aa.environment
       WHERE aa.tenant_id = ? AND aa.app_configuration_id = ? AND aa.provider = 'META' AND aa.environment = ?
         AND aa.asset_id = ? AND (? IS NULL OR auth.id = ?)
       ORDER BY auth.id`,
      [tenantId, appConfigurationId, environment, assetId, authorizationId ?? null, authorizationId ?? null],
    ) as AssetContextRow[];
  }

  private context(input: { readonly tenantId: string; readonly appConfigurationId: string; readonly environment: MetaEnvironment },
    source: AssetContextRow, target: AssetContextRow): MetaSubscriptionTargetContext {
    const flowVariant = source.flow_variant as MetaFlowVariant;
    return Object.freeze({ tenantId: input.tenantId, appConfigurationId: input.appConfigurationId, environment: input.environment,
      authorizationId: source.authorization_id, targetAssetId: target.asset_id, sourceAssetId: source.asset_id,
      providerObjectId: target.external_id, flowVariant, authVariant: source.auth_variant as MetaAuthenticationVariant,
      kind: 'WHATSAPP_BUSINESS_ACCOUNT', authorizationVersion: Number(source.authorization_version),
      targetAssetVersion: Number(target.asset_version), sourceAssetVersion: Number(source.asset_version) });
  }

  private validEnvironment(value: string): value is MetaEnvironment {
    return value === 'development' || value === 'test' || value === 'staging' || value === 'production';
  }
}
