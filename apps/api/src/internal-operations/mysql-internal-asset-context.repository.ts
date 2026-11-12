import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { InternalAssetOperationAssetRepository, InternalAssetOperationAsset } from './internal-operations.types.js';

interface AssetContextRow {
  tenant_id: string;
  asset_id: string;
  app_configuration_id: string;
  environment: string;
  flow_variant: string | null;
  auth_variant: string | null;
  provider_object_id: string;
}

const FLOW_VARIANTS = new Set(['FACEBOOK', 'INSTAGRAM', 'WHATSAPP_EXCLUSIVE', 'WHATSAPP_COEXISTENCE']);
const AUTH_VARIANTS = new Set([
  'FACEBOOK_LOGIN_FOR_BUSINESS', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN',
  'WHATSAPP_EMBEDDED_SIGNUP', 'WHATSAPP_BUSINESS_APP_ONBOARDING',
]);
const ENVIRONMENTS = new Set(['development', 'test', 'staging', 'production']);

/** Resolves only an active, verified asset authorization inside a tenant derived from service proof. */
export class MysqlInternalAssetContextRepository implements InternalAssetOperationAssetRepository {
  constructor(private readonly database: DurableWorkDatabase) {}

  async findAuthorizedAsset(input: Parameters<InternalAssetOperationAssetRepository['findAuthorizedAsset']>[0]): Promise<InternalAssetOperationAsset | undefined> {
    const source = await this.database.getDataSource();
    const rows = await source.query(
      `SELECT DISTINCT a.tenant_id, a.id AS asset_id, a.app_configuration_id, a.environment,
              auth.flow_variant, auth.auth_variant, a.external_id AS provider_object_id
       FROM ca_meta_assets a
       JOIN ca_meta_asset_authorizations aa ON aa.tenant_id = a.tenant_id AND aa.asset_id = a.id
         AND aa.app_configuration_id = a.app_configuration_id AND aa.provider = a.provider AND aa.environment = a.environment
       JOIN ca_meta_authorizations auth ON auth.tenant_id = aa.tenant_id AND auth.id = aa.authorization_id
         AND auth.app_configuration_id = aa.app_configuration_id AND auth.provider = aa.provider AND auth.environment = aa.environment
       WHERE a.tenant_id = ? AND a.id = ? AND a.provider = 'META' AND a.environment = ?
         AND aa.state = 'ACTIVE' AND aa.verification_state = 'VERIFIED'
         AND auth.authorization_state IN ('ACTIVE', 'PARTIAL')
       LIMIT 2`,
      [input.tenantId, input.assetId, input.environment],
    ) as AssetContextRow[];
    // An asset with multiple active authorization contexts is ambiguous and fails closed.
    if (rows.length !== 1) return undefined;
    const row = rows[0]!;
    if (!FLOW_VARIANTS.has(String(row.flow_variant)) || !AUTH_VARIANTS.has(String(row.auth_variant)) ||
        !ENVIRONMENTS.has(row.environment) || row.environment !== input.environment ||
        row.provider_object_id.length < 1 || row.provider_object_id.length > 512 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.tenant_id) ||
        row.tenant_id !== input.tenantId || row.asset_id !== input.assetId) return undefined;
    const validPair = (row.flow_variant === 'FACEBOOK' && row.auth_variant === 'FACEBOOK_LOGIN_FOR_BUSINESS') ||
      (row.flow_variant === 'INSTAGRAM' && ['INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN'].includes(row.auth_variant!)) ||
      (row.flow_variant === 'WHATSAPP_EXCLUSIVE' && row.auth_variant === 'WHATSAPP_EMBEDDED_SIGNUP') ||
      (row.flow_variant === 'WHATSAPP_COEXISTENCE' && row.auth_variant === 'WHATSAPP_BUSINESS_APP_ONBOARDING');
    if (!validPair) return undefined;
    return Object.freeze({
      tenantId: row.tenant_id,
      assetId: row.asset_id,
      appConfigurationId: row.app_configuration_id,
      environment: row.environment as InternalAssetOperationAsset['environment'],
      flowVariant: row.flow_variant as InternalAssetOperationAsset['flowVariant'],
      authVariant: row.auth_variant as InternalAssetOperationAsset['authVariant'],
      providerObjectId: row.provider_object_id,
    });
  }
}
