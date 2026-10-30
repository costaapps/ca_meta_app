import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EntityManager } from 'typeorm';
import { META_ASSETS_MIGRATION } from '../src/database/migrations/meta-assets.js';
import { MysqlMetaAssetsRepository } from '../src/meta-assets/mysql-meta-assets.repository.js';
import {
  assetIdentityHash,
  issueVerifiedMetaEvidence,
  MetaAssetsConflictError,
  MetaAssetsInputError,
  serializeAuthorizationReadModel,
  validateAuthorizationUpsert,
  type AuthorizationUpsertCommand,
} from '../src/meta-assets/meta-assets.types.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const appConfigurationId = '00000000-0000-4000-8000-000000000002';
const authorizationId = '00000000-0000-4000-8000-000000000003';
const observedAt = '2026-10-30T12:00:00.000Z';
const evidence = () => issueVerifiedMetaEvidence({
  source: 'META_API',
  observedAt,
  observationRef: 'provider-observation-synthetic-001',
});

function command(overrides: Partial<AuthorizationUpsertCommand> = {}): AuthorizationUpsertCommand {
  return {
    tenantId, authorizationId, appConfigurationId, provider: 'META', environment: 'test',
    state: 'ACTIVE', grantedScopes: [], assets: [],
    actor: { kind: 'SERVICE', ref: 'service-synthetic-001' },
    correlationId: 'correlation-synthetic-001', observedAt,
    ...overrides,
  };
}

test('verified provider evidence is a runtime capability and stores only a digest reference', () => {
  const proof = evidence();
  assert.equal(proof.source, 'META_API');
  assert.match(proof.observationRefHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(proof).includes('provider-observation-synthetic-001'), false);
  assert.throws(
    () => validateAuthorizationUpsert(command({ evidence: { source: 'META_API', observedAt, observationRefHash: '0'.repeat(64) } })),
    MetaAssetsInputError,
  );
});

test('verified authorization and asset evidence timestamps must match the command observation', () => {
  assert.doesNotThrow(() => validateAuthorizationUpsert(command({
    evidence: evidence(), observedAt: '2026-10-30T12:00:00.000000Z',
  })));
  assert.throws(() => validateAuthorizationUpsert(command({
    evidence: evidence(), observedAt: '2026-10-30T12:00:01.000Z',
  })), MetaAssetsInputError);
  const authorizationProof = evidence();
  const staleAssetProof = issueVerifiedMetaEvidence({
    source: 'META_API', observedAt: '2026-10-30T11:59:59.999999Z',
    observationRef: 'stale-asset-observation-synthetic-001',
  });
  assert.throws(() => validateAuthorizationUpsert(command({
    evidence: authorizationProof,
    assets: [{ kind: 'FACEBOOK_PAGE', externalId: 'page-0001', evidence: staleAssetProof }],
  })), MetaAssetsInputError);
});

test('browser claims cannot become granted scopes or confirmed authorization/asset data', () => {
  assert.throws(() => validateAuthorizationUpsert(command({ grantedScopes: ['whatsapp_business_messaging'] })), MetaAssetsInputError);
  assert.throws(() => validateAuthorizationUpsert(command({
    assets: [{ kind: 'WHATSAPP_PHONE_NUMBER', externalId: '000123', evidence: evidence() }],
  })), MetaAssetsInputError);
  assert.throws(() => validateAuthorizationUpsert(command({
    assets: [{ kind: 'FACEBOOK_PAGE', externalId: 'page-0001', grants: [] }],
  })), MetaAssetsInputError);
  assert.throws(() => validateAuthorizationUpsert(command({
    providerAuthorizationId: 'provider-auth-ref',
  })), MetaAssetsInputError);
});

test('asset kinds must come from the supported Meta domain allowlist', () => {
  assert.throws(() => validateAuthorizationUpsert(command({
    assets: [{ kind: 'UNSUPPORTED_PROVIDER_OBJECT' as never, externalId: 'opaque-object-01' }],
  })), MetaAssetsInputError);
});

test('large and leading-zero external identifiers remain opaque strings', () => {
  const prefix = { provider: 'META', appExternalId: '001-app', environment: 'test', kind: 'WHATSAPP_PHONE_NUMBER' };
  const largeId = '90071992547409931234567890';
  const largeHash = assetIdentityHash({ ...prefix, externalId: largeId });
  assert.notDeepEqual(largeHash, assetIdentityHash({ ...prefix, externalId: String(Number(largeId)) }));
  assert.notDeepEqual(assetIdentityHash({ ...prefix, externalId: '000123' }), assetIdentityHash({ ...prefix, externalId: '123' }));
  assert.equal(typeof largeId, 'string');
});

test('typed Instagram-to-Page relation does not require a Facebook link for every Instagram asset', () => {
  const proof = evidence();
  assert.doesNotThrow(() => validateAuthorizationUpsert(command({
    evidence: proof,
    assets: [{
      kind: 'INSTAGRAM_BUSINESS_ACCOUNT',
      externalId: 'ig-00001',
      evidence: proof,
      relations: [{ type: 'INSTAGRAM_TO_PAGE', targetExternalId: 'page-00002' }],
    }],
  })));
});

test('public authorization serialization has an allowlist and omits secret-bearing fields', () => {
  const value = {
    authorizationRef: authorizationId, provider: 'META' as const, environment: 'test' as const, state: 'ACTIVE' as const,
    grantedScopes: ['pages_show_list'], version: 2, observedAt, assets: [],
    accessToken: 'must-not-escape', ciphertext: 'must-not-escape',
  };
  const serialized = serializeAuthorizationReadModel(value);
  assert.deepEqual(Object.keys(serialized).sort(), [
    'assets', 'authorizationRef', 'environment', 'grantedScopes', 'observedAt', 'provider', 'state', 'version',
  ]);
  assert.equal(JSON.stringify(serialized).includes('must-not-escape'), false);
});

test('legacy asset references remain opaque, tenant-mapped strings and are service-owned', () => {
  const reference = { legacyDatabaseId: 'old-db-01', legacyCompanyId: 'company-0004', legacyAssetRef: '00000000000000000000042' };
  const asset = { kind: 'FACEBOOK_PAGE', externalId: 'page-ref', legacyReferences: [reference] };
  assert.throws(() => validateAuthorizationUpsert(command({ actor: { kind: 'USER', ref: 'human-synthetic-001' }, assets: [asset] })), MetaAssetsInputError);
  assert.doesNotThrow(() => validateAuthorizationUpsert(command({
    actor: { kind: 'SERVICE', ref: 'legacy-importer' },
    assets: [asset],
  })));
  assert.equal(typeof reference.legacyAssetRef, 'string');
});
test('M3.06 migration reserves schema version 6 and uses tenant-context foreign keys without global upsert reassignment', () => {
  assert.equal(META_ASSETS_MIGRATION.schemaVersion, 6);
  assert.equal(META_ASSETS_MIGRATION.id, '202610300003-meta-assets-grants-relations');
  assert.match(META_ASSETS_MIGRATION.checksum, /^[a-f0-9]{64}$/);
  const sql = META_ASSETS_MIGRATION.steps.filter((step) => 'sql' in step).map((step) => step.sql).join('\n');
  assert.match(sql, /FOREIGN KEY \(tenant_id, authorization_id, app_configuration_id, provider, environment\)/);
  assert.match(sql, /FOREIGN KEY \(tenant_id, asset_id, app_configuration_id, provider, environment\)/);
  assert.match(sql, /FOREIGN KEY \(tenant_id, credential_id, authorization_id, app_configuration_id, provider, environment\)/);
  assert.match(sql, /identity_hash BINARY\(32\)/);
  assert.match(sql, /external_id VARCHAR\(512\)/);
  assert.doesNotMatch(sql, /ON DUPLICATE KEY UPDATE/i);
});

test('outbox intent remains staged when the enclosing commit fails', async () => {
  const staged: unknown[][] = [];
  const committed: unknown[] = [];
  let active: unknown[] | undefined;
  const database = {
    async getDataSource() {
      return {
        async transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
          active = [];
          const pending = active;
          const manager = {
            async query(sql: string) {
              if (sql.startsWith('SELECT')) return [];
              return [{ affectedRows: 1 }];
            },
          } as unknown as EntityManager;
          const result = await work(manager);
          staged.push(pending);
          throw new Error('synthetic commit failure');
          // A real transaction publishes pending writes only after COMMIT succeeds.
          // Keep this explicit in the fake so a regression cannot append outside the transaction.
          void result;
        },
      };
    },
  };
  const outbox = {
    async appendWithin(_manager: EntityManager, event: unknown): Promise<void> {
      active?.push(event);
      return;
    },
  };
  const repository = new MysqlMetaAssetsRepository(database as never, outbox);
  await assert.rejects(repository.upsert(command({ evidence: evidence() })), /synthetic commit failure/);
  assert.equal(staged.length, 1);
  assert.equal(staged[0]?.length, 1);
  assert.equal(committed.length, 0);
  assert.equal(active?.length, 1);
});

test('an omitted asset grant snapshot preserves current grants and history', async () => {
  const assetId = '00000000-0000-4000-8000-000000000004';
  const proof = evidence();
  const queries: Array<{ sql: string; parameters: unknown[] }> = [];
  let historySnapshot: string | undefined;
  const existingAuthorization = {
    id: authorizationId, tenant_id: tenantId, app_configuration_id: appConfigurationId,
    provider: 'META', environment: 'test', provider_authorization_id: null,
    authorization_state: 'ACTIVE', version: '1', observed_at: '2026-10-30 12:00:00.000000',
  };
  const database = {
    async getDataSource() {
      return {
        async transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
          const manager = {
            async query(sql: string, parameters: unknown[] = []) {
              queries.push({ sql, parameters });
              if (sql.startsWith('SELECT')) {
                if (sql.includes('FROM ca_meta_authorizations')) return [existingAuthorization];
                if (sql.includes('FROM ca_meta_app_configurations')) return [{ app_external_id: '001-app' }];
                if (sql.includes('FROM ca_meta_asset_identity_claims')) return [{
                  provider: 'META', app_external_id: '001-app', environment: 'test', asset_kind: 'FACEBOOK_PAGE',
                  external_id: 'page-0001', tenant_id: tenantId, asset_id: assetId,
                  app_configuration_id: appConfigurationId, verification_ref_hash: 'a'.repeat(64),
                }];
                if (sql.includes('FROM ca_meta_assets')) return [{
                  id: assetId, display_name: 'Local name', external_name: 'Provider name', version: '4', updated_at: '2026-10-30 12:00:00.000000',
                }];
                if (sql.includes('FROM ca_meta_asset_authorizations')) return [{
                  verification_state: 'VERIFIED', verification_source: 'META_API', version: '2',
                }];
                if (sql.includes('FROM ca_meta_asset_grants')) return [{
                  grant_name: 'pages_read_engagement', status: 'GRANTED', version: '3',
                }];
                if (sql.includes('FROM ca_meta_authorization_scopes')) return [];
                throw new Error('Unexpected SELECT in omitted-grants test: ' + sql);
              }
              if (sql.includes('INSERT INTO ca_meta_asset_history')) historySnapshot = String(parameters[5]);
              return [{ affectedRows: 1 }];
            },
          } as unknown as EntityManager;
          return work(manager);
        },
      };
    },
  };
  const repository = new MysqlMetaAssetsRepository(database as never, {
    async appendWithin() { return; },
  });

  await repository.upsert(command({
    evidence: proof,
    assets: [{ kind: 'FACEBOOK_PAGE', externalId: 'page-0001', evidence: proof }],
  }));

  assert.equal(queries.some(({ sql }) => sql.startsWith('UPDATE ca_meta_asset_grants')), false);
  assert.deepEqual(JSON.parse(historySnapshot ?? '{}').grants, ['pages_read_engagement']);
});

test('older verified authorization observations cannot overwrite newer state', async () => {
  const queries: string[] = [];
  const database = {
    async getDataSource() {
      return {
        async transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
          const manager = {
            async query(sql: string) {
              queries.push(sql);
              return [{
                id: authorizationId, tenant_id: tenantId, app_configuration_id: appConfigurationId,
                provider: 'META', environment: 'test', provider_authorization_id: null,
                authorization_state: 'ACTIVE', version: '2', observed_at: '2026-10-30 12:00:00.000001',
              }];
            },
          } as unknown as EntityManager;
          return work(manager);
        },
      };
    },
  };
  const repository = new MysqlMetaAssetsRepository(database as never, { async appendWithin() { return; } });
  await assert.rejects(repository.upsert(command({
    evidence: evidence(),
    observedAt: '2026-10-30T12:00:00.000000Z',
  })), MetaAssetsConflictError);
  assert.equal(queries.length, 1, 'a stale snapshot is rejected before any write');
});
