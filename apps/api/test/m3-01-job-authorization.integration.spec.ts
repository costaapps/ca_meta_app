import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { validateEnvironment } from '../src/config/environment.js';
import { deployMigrations } from '../src/database/migrations/migration-runner.js';
import { readMigrationEnvironment } from '../src/database/migrations/migration-environment.js';
import { MysqlIdentityRepository } from '../src/identity/mysql-identity.repository.js';
import { ServiceTenantAuthorizationService } from '../src/identity/identity.service.js';
import { WorkerServiceIdentityVerifier } from '../src/identity/identity.trust.js';
import { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { MysqlJobExecutionAuthorizationPort, isVerifiedJobExecutionContext } from '../src/jobs/job-execution-authorization.js';
import { DurableJobStore, type ClaimedJob } from '../src/jobs/job-store.js';

const enabled = process.env.M2_DURABLE_WORK_TEST === '1';
const timestamp = '2026-10-30 12:00:00.000000';

test('M3.01 MariaDB authorizes a persisted asset job and denies forged claims, payloads, and revoked grants', {
  skip: enabled ? false : 'Run in the disposable M2.05/M3 MariaDB profile with M2_DURABLE_WORK_TEST=1.',
}, async () => {
  await deployMigrations(readMigrationEnvironment(process.env));
  const environment = validateEnvironment(process.env);
  const database = new DurableWorkDatabase(environment);
  const identityRepository = new MysqlIdentityRepository(environment.database);
  const tenantId = randomUUID();
  const servicePrincipalId = randomUUID();
  const appConfigurationId = randomUUID();
  const authorizationId = randomUUID();
  const assetId = randomUUID();
  const proof = `synthetic-m3-01-worker-proof-${randomUUID()}`;
  const identity = new WorkerServiceIdentityVerifier([{
    principalId: servicePrincipalId,
    credentialSha256: createHash('sha256').update(proof, 'utf8').digest('hex'),
  }]).verify(proof);

  try {
    assert.ok(identity);
    const dataSource = await database.getDataSource();
    await dataSource.query("SET time_zone = '+00:00'");
    await dataSource.query(
      'INSERT INTO ca_meta_tenants (id, created_at, updated_at) VALUES (?, ?, ?)',
      [tenantId, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_app_configurations
       (id, tenant_id, provider, app_external_id, environment, created_at, updated_at)
       VALUES (?, ?, 'META', ?, 'test', ?, ?)`,
      [appConfigurationId, tenantId, `synthetic-app-${randomUUID()}`, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_principals (id, kind, issuer, subject, status, version, created_at, updated_at)
       VALUES (?, 'SERVICE', 'urn:ca-meta:m3-01-test-worker', ?, 'ACTIVE', 1, ?, ?)`,
      [servicePrincipalId, randomUUID(), timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_service_identity_scopes
       (tenant_id, principal_id, principal_kind, scope, status, created_at, revoked_at)
       VALUES (?, ?, 'SERVICE', 'META_CONNECTION_EXECUTE', 'ACTIVE', ?, NULL)`,
      [tenantId, servicePrincipalId, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_authorizations
       (id, tenant_id, app_configuration_id, provider, environment, provider_authorization_id,
        authorization_state, version, observed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'META', 'test', ?, 'ACTIVE', 1, ?, ?, ?)`,
      [authorizationId, tenantId, appConfigurationId, `synthetic-auth-${randomUUID()}`, timestamp, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_assets
       (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id, display_name, created_at, updated_at)
       VALUES (?, ?, ?, 'META', 'test', 'PAGE', ?, 'synthetic asset', ?, ?)`,
      [assetId, tenantId, appConfigurationId, `synthetic-asset-${randomUUID()}`, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_asset_authorizations
       (tenant_id, authorization_id, asset_id, app_configuration_id, provider, environment, credential_id,
        state, verification_state, verification_source, verification_ref_hash, verified_at,
        subscription_state, projection_state, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'META', 'test', NULL, 'ACTIVE', 'VERIFIED', 'META_API', ?, ?,
         'UNKNOWN', 'UNKNOWN', 1, ?, ?)`,
      [tenantId, authorizationId, assetId, appConfigurationId,
        createHash('sha256').update(`synthetic-asset-evidence:${assetId}`).digest('hex'), timestamp, timestamp, timestamp],
    );

    const jobs = new DurableJobStore(database, () => 0);
    const enqueued = await jobs.enqueue({
      tenantId,
      type: 'ASSET_REFRESH',
      idempotencyKey: `m301auth:${randomUUID()}`,
      correlationId: `m301-auth-${randomUUID()}`,
      resourceScopeRef: `asset:${assetId}`,
      payload: { kind: 'ASSET_REFRESH', assetId, appConfigurationId, environment: 'test' },
    });
    const workerRef = `m301auth:${randomUUID()}`;
    const claimed = await jobs.claimNext(workerRef, 30_000, ['ASSET_REFRESH']);
    assert.equal(claimed?.id, enqueued.id);
    assert.ok(claimed);
    if (claimed.payload.kind !== 'ASSET_REFRESH') throw new Error('The synthetic asset job was claimed with an unexpected payload type.');

    const authorization = new MysqlJobExecutionAuthorizationPort(
      database,
      new ServiceTenantAuthorizationService(identityRepository),
      identity,
    );
    const accepted = await authorization.authorize(claimed);
    assert.ok(accepted);
    assert.equal(isVerifiedJobExecutionContext(accepted), true);
    assert.equal(accepted.tenantId, tenantId);
    assert.equal(accepted.principalId, servicePrincipalId);
    assert.equal(accepted.resourceRef, assetId);

    const forgedClaim: ClaimedJob = { ...claimed, claimToken: randomUUID() };
    assert.equal(await authorization.authorize(forgedClaim), undefined);

    const forgedPayload: ClaimedJob = {
      ...claimed,
      payload: { ...claimed.payload, assetId: randomUUID() },
    };
    assert.equal(await authorization.authorize(forgedPayload), undefined);

    await dataSource.query(
      `UPDATE ca_meta_service_identity_scopes SET status = 'REVOKED', revoked_at = UTC_TIMESTAMP(6)
       WHERE tenant_id = ? AND principal_id = ? AND scope = 'META_CONNECTION_EXECUTE'`,
      [tenantId, servicePrincipalId],
    );
    assert.equal(await authorization.authorize(claimed), undefined);
    assert.equal(await jobs.finish(claimed, { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' }), true);
  } finally {
    await identityRepository.onApplicationShutdown();
    await database.close();
  }
});
