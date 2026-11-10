import { createHash, randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';

const timestamp = '2026-11-10 12:00:00.000000';

export interface MariaDbFourPhoneWabaFixture {
  readonly tenantId: string;
  readonly appConfigurationId: string;
  readonly authorizationId: string;
  readonly credentialId: string;
  readonly targetAssetId: string;
  readonly sourceAssetIds: readonly string[];
}

/** Seed only synthetic catalog metadata; no credential secret or provider request is created. */
export async function seedMariaDbFourPhoneWabaFixture(dataSource: DataSource): Promise<MariaDbFourPhoneWabaFixture> {
  const tenantId = randomUUID();
  const appConfigurationId = randomUUID();
  const authorizationId = randomUUID();
  const credentialId = randomUUID();
  const targetAssetId = randomUUID();
  const sourceAssetIds = Object.freeze(Array.from({ length: 4 }, () => randomUUID()));
  const evidenceHash = createHash('sha256').update(`m4-11-synthetic:${tenantId}`, 'utf8').digest('hex');

  await dataSource.query(
    `INSERT INTO ca_meta_tenants (id, status, version, created_at, updated_at)
     VALUES (?, 'ACTIVE', 1, ?, ?)`,
    [tenantId, timestamp, timestamp],
  );
  await dataSource.query(
    `INSERT INTO ca_meta_app_configurations
     (id, tenant_id, provider, app_external_id, environment, created_at, updated_at)
     VALUES (?, ?, 'META', ?, 'test', ?, ?)`,
    [appConfigurationId, tenantId, `synthetic-app-${randomUUID()}`, timestamp, timestamp],
  );
  await dataSource.query(
    `INSERT INTO ca_meta_authorizations
     (id, tenant_id, app_configuration_id, provider, environment, flow_variant, auth_variant,
      provider_authorization_id, authorization_state, version, observed_at, created_at, updated_at)
     VALUES (?, ?, ?, 'META', 'test', 'WHATSAPP_EXCLUSIVE', 'WHATSAPP_EMBEDDED_SIGNUP',
      ?, 'ACTIVE', 1, ?, ?, ?)`,
    [authorizationId, tenantId, appConfigurationId, `synthetic-auth-${randomUUID()}`, timestamp, timestamp, timestamp],
  );
  await dataSource.query(
    `INSERT INTO ca_meta_credentials
     (id, tenant_id, authorization_id, app_configuration_id, provider, environment, family, status,
      version, created_at, updated_at, revoked_at)
     VALUES (?, ?, ?, ?, 'META', 'test', 'SYNTHETIC_FIXTURE_ONLY', 'ACTIVE', 1, ?, ?, NULL)`,
    [credentialId, tenantId, authorizationId, appConfigurationId, timestamp, timestamp],
  );

  const assets = [
    { id: targetAssetId, kind: 'WHATSAPP_BUSINESS_ACCOUNT', externalId: `synthetic-waba-${randomUUID()}`, name: 'Synthetic WABA' },
    ...sourceAssetIds.map((id, index) => ({
      id,
      kind: 'WHATSAPP_PHONE_NUMBER',
      externalId: `synthetic-phone-${index + 1}-${randomUUID()}`,
      name: `Synthetic phone ${index + 1}`,
    })),
  ];
  for (const asset of assets) {
    await dataSource.query(
      `INSERT INTO ca_meta_assets
       (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id, display_name,
        version, created_at, updated_at)
       VALUES (?, ?, ?, 'META', 'test', ?, ?, ?, 1, ?, ?)`,
      [asset.id, tenantId, appConfigurationId, asset.kind, asset.externalId, asset.name, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_asset_authorizations
       (tenant_id, authorization_id, asset_id, app_configuration_id, provider, environment, credential_id,
        state, verification_state, verification_source, verification_ref_hash, verified_at,
        subscription_state, projection_state, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'META', 'test', ?, 'ACTIVE', 'VERIFIED', 'META_API', ?, ?,
        'UNKNOWN', 'UNKNOWN', 1, ?, ?)`,
      [tenantId, authorizationId, asset.id, appConfigurationId, credentialId, evidenceHash,
        timestamp, timestamp, timestamp],
    );
  }

  for (const sourceAssetId of sourceAssetIds) {
    await dataSource.query(
      `INSERT INTO ca_meta_asset_relations
       (tenant_id, source_asset_id, target_asset_id, app_configuration_id, provider, environment,
        relation_type, verification_source, verification_ref_hash, verified_at, version)
       VALUES (?, ?, ?, ?, 'META', 'test', 'PHONE_TO_ACCOUNT', 'META_API', ?, ?, 1)`,
      [tenantId, sourceAssetId, targetAssetId, appConfigurationId, evidenceHash, timestamp],
    );
  }

  return Object.freeze({ tenantId, appConfigurationId, authorizationId, credentialId, targetAssetId, sourceAssetIds });
}
