import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CredentialKeyRingConfiguration, validateEnvironment } from '../src/config/environment.js';
import { ConfiguredCredentialKeyProvider } from '../src/credentials/credential-key-provider.js';
import { CredentialInspectionWorker, CredentialLifecycleScheduler } from '../src/credentials/credential-lifecycle.service.js';
import type { CredentialInspectionPort, CredentialInspectionBinding, CredentialLifecyclePolicyPort,
  CredentialLifecycleSecretPort, CredentialRenewalPort } from '../src/credentials/credential-lifecycle.types.js';
import { CredentialVaultService } from '../src/credentials/credential-vault.service.js';
import type { CredentialVaultAuthorizationPort } from '../src/credentials/credential-vault.types.js';
import { deployMigrations } from '../src/database/migrations/migration-runner.js';
import { readMigrationEnvironment } from '../src/database/migrations/migration-environment.js';
import { MysqlCredentialVaultRepository } from '../src/credentials/mysql-credential-vault.repository.js';
import { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { DurableJobStore } from '../src/jobs/job-store.js';
import type { JobType } from '../src/jobs/event-validation.js';
import { AuditEventWriter } from '../src/privacy/audit.service.js';
import { DurableWorker, type JobFinalizer, type JobHandler } from '../src/worker/durable-worker.js';

const enabled = process.env.M3_09_TEST === '1';
const timestamp = '2026-11-03 12:00:00.000000';

class SyntheticVaultAuthorization implements CredentialVaultAuthorizationPort {
  async authorize(): Promise<void> {}
}

test('M3.09 MariaDB v13 schema, due lease/idempotent job, reauth impact dedupe, and stale-version fencing', {
  skip: enabled ? false : 'Run in the disposable M2.05 MariaDB profile with M3_09_TEST=1.',
}, async () => {
  await deployMigrations(readMigrationEnvironment(process.env));
  const environment = validateEnvironment(process.env);
  const database = new DurableWorkDatabase(environment);
  const dataSource = await database.getDataSource();
  const credentialKey = randomBytes(32);
  const keyVersion = `m3-09-${randomUUID().slice(0, 8)}`;
  const secretMarker = `m3-09-synthetic-${randomUUID()}`;
  const replacementMarker = `m3-09-replacement-${randomUUID()}`;
  const tenantId = randomUUID();
  const appConfigurationId = randomUUID();
  const authorizationId = randomUUID();
  const bindings = [randomUUID(), randomUUID()].map((credentialId) => ({
    tenantId, credentialId, authorizationId, appConfigurationId, provider: 'META' as const,
    environment: 'test', flowVariant: 'INSTAGRAM' as const, authVariant: 'INSTAGRAM_LOGIN' as const, family: 'SYNTHETIC_FAMILY',
  }));
  const actors = bindings.map(() => ({ actorRef: randomUUID(), correlationId: randomUUID() }));
  const vaultRepository = new MysqlCredentialVaultRepository(database, new AuditEventWriter(database));
  const keyProvider = new ConfiguredCredentialKeyProvider(new CredentialKeyRingConfiguration(keyVersion,
    [{ version: keyVersion, key: credentialKey }]));
  const vault = new CredentialVaultService(vaultRepository, keyProvider, new SyntheticVaultAuthorization());
  const jobs = new DurableJobStore(database, () => 0);
  const policy: CredentialLifecyclePolicyPort = {
    forCredential: (flowVariant, authVariant, family) => flowVariant === 'INSTAGRAM' && authVariant === 'INSTAGRAM_LOGIN' &&
      ['SYNTHETIC_FAMILY', 'SYNTHETIC_RENEWAL'].includes(family)
      ? { flowVariant, authVariant, family, inspectEnabled: true, refreshEnabled: family === 'SYNTHETIC_RENEWAL',
        createReauthIntent: family === 'SYNTHETIC_FAMILY',
        reauthImpactKey: family === 'SYNTHETIC_FAMILY' ? 'SYNTHETIC_AUTHORIZATION_ACCESS' : null,
        checkIntervalSeconds: 3600, jitterPercent: 0 }
      : undefined,
  };
  let inspectorCalls = 0;
  let renewalCalls = 0;
  let concurrentRenewalCredentialId: string | undefined;
  const inspection: CredentialInspectionPort = {
    async inspect(binding, secret) {
      assert.equal(secret, secretMarker);
      inspectorCalls += 1;
      return { health: binding.family === 'SYNTHETIC_RENEWAL' ? 'EXPIRING' : 'REVOKED', issuedAt: '2026-11-03T12:00:00.000Z',
        expiryState: 'KNOWN', expiresAt: '2026-11-04T12:00:00.000Z', dataAccessExpiresAt: '2026-11-04T12:00:00.000Z',
        reasonCode: binding.family === 'SYNTHETIC_RENEWAL' ? 'NONE' : 'PERMISSION_REVOKED' };
    },
  };
  const renewal: CredentialRenewalPort = {
    async renew(binding, currentSecret) {
      assert.equal(currentSecret, secretMarker);
      renewalCalls += 1;
      if (binding.credentialId === concurrentRenewalCredentialId) {
        await dataSource.query(
          `UPDATE ca_meta_authorizations SET authorization_state = 'REVOKED', version = version + 1
           WHERE tenant_id = ? AND id = ?`, [tenantId, authorizationId],
        );
      }
      return { replacementSecret: replacementMarker, observation: {
        health: 'HEALTHY', issuedAt: '2026-11-03T12:00:00.000Z', expiryState: 'KNOWN',
        expiresAt: '2026-11-04T12:00:00.000Z', dataAccessExpiresAt: '2026-11-04T12:00:00.000Z', reasonCode: 'NONE',
      } };
    },
  };
  const secretAccess: CredentialLifecycleSecretPort = {
    async withCredential(binding, execute) {
      const actor = actors[bindings.findIndex((candidate) => candidate.credentialId === binding.credentialId)];
      assert.ok(actor);
      await vault.withCredential({ ...binding, ...actor, operation: 'CREDENTIAL_INSPECTION' }, execute);
    },
    async replaceCredentialWithin(manager, binding, fence: CredentialInspectionBinding, replacementSecret) {
      const actor = actors[bindings.findIndex((candidate) => candidate.credentialId === binding.credentialId)];
      assert.ok(actor);
      return vault.replaceIfCurrentWithin(manager, { ...binding, ...actor, operation: 'CREDENTIAL_RENEWAL', secret: replacementSecret }, {
        expectedAuthorizationVersion: fence.authorizationVersion,
        expectedCredentialVersion: fence.credentialVersion,
        expectedSecretVersion: fence.secretVersion,
      });
    },
  };

  try {
    await dataSource.query('SET time_zone = ?', ['+00:00']);
    await dataSource.query(
      `INSERT INTO ca_meta_tenants (id, status, version, created_at, updated_at)
       VALUES (?, 'ACTIVE', 1, ?, ?)`, [tenantId, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_app_configurations (id, tenant_id, provider, app_external_id, environment, created_at, updated_at)
       VALUES (?, ?, 'META', ?, 'test', ?, ?)`,
      [appConfigurationId, tenantId, `m3-09-app-${randomUUID()}`, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_authorizations (id, tenant_id, app_configuration_id, provider, environment, flow_variant, auth_variant,
        provider_authorization_id, authorization_state, observed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'META', 'test', 'INSTAGRAM', 'INSTAGRAM_LOGIN', ?, 'ACTIVE', ?, ?, ?)`,
      [authorizationId, tenantId, appConfigurationId, `m3-09-auth-${randomUUID()}`, timestamp, timestamp, timestamp],
    );
    for (const [index, binding] of bindings.entries()) {
      await dataSource.query(
        `INSERT INTO ca_meta_credentials
         (id, tenant_id, authorization_id, app_configuration_id, provider, environment, family, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'META', 'test', 'SYNTHETIC_FAMILY', 'ACTIVE', 1, ?, ?)`,
        [binding.credentialId, tenantId, authorizationId, appConfigurationId, timestamp, timestamp],
      );
      await vault.store({ ...binding, ...actors[index]!, secret: secretMarker });
    }

    const shape = await dataSource.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = DATABASE()
       AND table_name IN ('ca_meta_authorizations', 'ca_meta_credential_lifecycle', 'ca_meta_credential_reauth_intents') ORDER BY table_name, ordinal_position`,
    ) as Array<{ table_name: string; column_name: string }>;
    const lifecycleColumns = shape.filter((row) => row.table_name === 'ca_meta_credential_lifecycle').map((row) => row.column_name);
    assert.ok(lifecycleColumns.includes('issued_at') && lifecycleColumns.includes('expires_at') &&
      lifecycleColumns.includes('data_access_expires_at') && lifecycleColumns.includes('health_source') &&
      lifecycleColumns.includes('last_checked_at') && lifecycleColumns.includes('schedule_generation'));
    assert.ok(shape.some((row) => row.table_name === 'ca_meta_authorizations' && row.column_name === 'flow_variant'));
    assert.ok(shape.some((row) => row.table_name === 'ca_meta_authorizations' && row.column_name === 'auth_variant'));
    assert.ok(shape.some((row) => row.table_name === 'ca_meta_credential_reauth_intents' && row.column_name === 'dedupe_key'));

    const schedulerA = new CredentialLifecycleScheduler(database, jobs, `m3-09-scheduler-a:${randomUUID()}`);
    const schedulerB = new CredentialLifecycleScheduler(database, jobs, `m3-09-scheduler-b:${randomUUID()}`);
    const claims = await Promise.all([schedulerA.scheduleDue(1, 5_000), schedulerB.scheduleDue(1, 5_000)]);
    assert.equal(claims[0]! + claims[1]!, 1, 'one replica holds the per-credential schedule lease');
    const scheduled = await dataSource.query(
      `SELECT id, idempotency_key, correlation_id, payload_json, status FROM ca_meta_jobs
       WHERE tenant_id = ? AND job_type = 'CREDENTIAL_INSPECTION'`, [tenantId],
    ) as Array<{ id: string; idempotency_key: string; correlation_id: string; payload_json: string; status: string }>;
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]?.status, 'QUEUED');
    assert.ok(!scheduled[0]?.payload_json.includes(secretMarker));
    const payload = JSON.parse(scheduled[0]!.payload_json) as Record<string, unknown>;
    const duplicate = await jobs.enqueue({ tenantId, type: 'CREDENTIAL_INSPECTION',
      idempotencyKey: scheduled[0]!.idempotency_key, correlationId: scheduled[0]!.correlation_id,
      resourceScopeRef: String(payload.credentialId), payload });
    assert.equal(duplicate.duplicate, true, 'durable enqueue deduplicates the same authorized observation job');

    const processor = new CredentialInspectionWorker(database, policy, secretAccess, inspection, () => 0.5, renewal);
    const runWorker = async (): Promise<void> => {
      const controller = new AbortController();
      const finalizer: JobFinalizer = async (manager, job, finalization) => {
          await processor.finalizer(manager, job, finalization);
          controller.abort();
        };
      const handlers = new Map<JobType, JobHandler>([['CREDENTIAL_INSPECTION', processor.handler]]);
      const finalizers = new Map<JobType, JobFinalizer>([['CREDENTIAL_INSPECTION', finalizer]]);
      const worker = new DurableWorker(jobs, { workerRef: `m3-09-worker:${randomUUID()}`, leaseMs: 30_000 }, handlers, finalizers);
      await worker.run(controller.signal);
    };
    await runWorker();
    assert.equal(inspectorCalls, 1);
    const firstCredential = String(payload.credentialId);
    const secondCredential = bindings.find((binding) => binding.credentialId !== firstCredential);
    assert.ok(secondCredential);
    assert.equal(await schedulerA.scheduleDue(1, 5_000), 1, 'a separate due credential is scheduled on the next bounded run');
    await runWorker();
    assert.equal(inspectorCalls, 2);
    const intents = await dataSource.query(
      `SELECT credential_id, authorization_id, dedupe_key, reason_code, occurrences FROM ca_meta_credential_reauth_intents
       WHERE tenant_id = ?`, [tenantId],
    ) as Array<{ credential_id: string; authorization_id: string; dedupe_key: string; reason_code: string; occurrences: number | string }>;
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.credential_id, secondCredential.credentialId, 'intent retains one safe reference to the latest affected credential');
    assert.equal(Number(intents[0]?.occurrences), 2, 'two credentials under one authorization+impact coalesce');
    assert.equal(intents[0]?.authorization_id, authorizationId);
    assert.equal(intents[0]?.reason_code, 'PERMISSION_REVOKED');
    assert.match(intents[0]?.dedupe_key ?? '', new RegExp(`^authorization:${authorizationId}:impact:SYNTHETIC_AUTHORIZATION_ACCESS$`));
    assert.ok(!JSON.stringify(intents).includes(secretMarker));

    await dataSource.query(
      `UPDATE ca_meta_credential_lifecycle SET next_check_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND)
       WHERE tenant_id = ? AND credential_id = ?`, [tenantId, secondCredential.credentialId],
    );
    assert.equal(await schedulerA.scheduleDue(1, 5_000), 1);
    await dataSource.query(
      'UPDATE ca_meta_credentials SET version = version + 1 WHERE tenant_id = ? AND id = ?',
      [tenantId, secondCredential.credentialId],
    );
    const beforeFence = await dataSource.query(
      'SELECT health_state, version FROM ca_meta_credential_lifecycle WHERE tenant_id = ? AND credential_id = ?',
      [tenantId, secondCredential.credentialId],
    ) as Array<{ health_state: string; version: number | string }>;
    await runWorker();
    assert.equal(inspectorCalls, 2, 'stale credential version is rejected before decrypted secret or inspector access');
    const afterFence = await dataSource.query(
      'SELECT health_state, version FROM ca_meta_credential_lifecycle WHERE tenant_id = ? AND credential_id = ?',
      [tenantId, secondCredential.credentialId],
    ) as Array<{ health_state: string; version: number | string }>;
    assert.equal(afterFence[0]?.health_state, beforeFence[0]?.health_state);
    assert.equal(Number(afterFence[0]?.version), Number(beforeFence[0]?.version), 'stale finalizer cannot restore older metadata');

    const coalesced = await dataSource.query(
      'SELECT COUNT(*) AS count FROM ca_meta_credential_reauth_intents WHERE tenant_id = ? AND authorization_id = ? AND dedupe_key = ?',
      [tenantId, authorizationId, intents[0]!.dedupe_key],
    ) as Array<{ count: string | number }>;
    assert.equal(Number(coalesced[0]?.count ?? 0), 1, 'one authorization+impact intent can reference one affected credential');

    const addRenewalCredential = async () => {
      const binding = {
        tenantId, credentialId: randomUUID(), authorizationId, appConfigurationId, provider: 'META' as const,
        environment: 'test', flowVariant: 'INSTAGRAM' as const, authVariant: 'INSTAGRAM_LOGIN' as const,
        family: 'SYNTHETIC_RENEWAL',
      };
      const actor = { actorRef: randomUUID(), correlationId: randomUUID() };
      bindings.push(binding);
      actors.push(actor);
      await dataSource.query(
        `INSERT INTO ca_meta_credentials
         (id, tenant_id, authorization_id, app_configuration_id, provider, environment, family, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'META', 'test', 'SYNTHETIC_RENEWAL', 'ACTIVE', 1, ?, ?)`,
        [binding.credentialId, tenantId, authorizationId, appConfigurationId, timestamp, timestamp],
      );
      await vault.store({ ...binding, ...actor, secret: secretMarker });
      return binding;
    };

    const currentRenewal = await addRenewalCredential();
    assert.equal(await schedulerA.scheduleDue(1, 5_000), 1, 'explicitly supported flow/auth/family may run an injected renewal');
    await runWorker();
    assert.equal(renewalCalls, 1);
    assert.equal(inspectorCalls, 3);
    const renewedSecretVersion = await dataSource.query(
      'SELECT version FROM ca_meta_credential_secrets WHERE tenant_id = ? AND credential_id = ?',
      [tenantId, currentRenewal.credentialId],
    ) as Array<{ version: number | string }>;
    assert.equal(Number(renewedSecretVersion[0]?.version), 2, 'current versioned renewal atomically replaces the vault record');
    let replacementStored = false;
    await vault.withCredential({ ...currentRenewal, ...actors[bindings.findIndex((item) => item.credentialId === currentRenewal.credentialId)]!,
      operation: 'CREDENTIAL_INSPECTION' }, async (secret) => { replacementStored = secret === replacementMarker; });
    assert.equal(replacementStored, true, 'the synthetic replacement is present only inside the vault callback');

    const concurrentRenewal = await addRenewalCredential();
    concurrentRenewalCredentialId = concurrentRenewal.credentialId;
    assert.equal(await schedulerA.scheduleDue(1, 5_000), 1);
    await runWorker();
    assert.equal(renewalCalls, 2);
    assert.equal(inspectorCalls, 4);
    const staleSecretVersion = await dataSource.query(
      'SELECT version FROM ca_meta_credential_secrets WHERE tenant_id = ? AND credential_id = ?',
      [tenantId, concurrentRenewal.credentialId],
    ) as Array<{ version: number | string }>;
    assert.equal(Number(staleSecretVersion[0]?.version), 1, 'authorization revocation/version change during renewal rejects its late secret write');
    let staleSecretPreserved = false;
    await vault.withCredential({ ...concurrentRenewal, ...actors[bindings.findIndex((item) => item.credentialId === concurrentRenewal.credentialId)]!,
      operation: 'CREDENTIAL_INSPECTION' }, async (secret) => { staleSecretPreserved = secret === secretMarker; });
    assert.equal(staleSecretPreserved, true, 'a late renewal result cannot overwrite the current vault secret');
  } finally {
    credentialKey.fill(0);
    await database.close();
  }
});
