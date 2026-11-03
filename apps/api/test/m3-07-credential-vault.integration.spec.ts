import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CredentialKeyRingConfiguration, validateEnvironment } from '../src/config/environment.js';
import { CredentialVaultDeniedError, CredentialVaultKeyUnavailableError,
  CredentialVaultOperationError } from '../src/credentials/credential-vault.errors.js';
import { ConfiguredCredentialKeyProvider } from '../src/credentials/credential-key-provider.js';
import { CredentialVaultService } from '../src/credentials/credential-vault.service.js';
import type { CredentialVaultAuthorizationPort } from '../src/credentials/credential-vault.types.js';
import { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { deployMigrations } from '../src/database/migrations/migration-runner.js';
import { readMigrationEnvironment } from '../src/database/migrations/migration-environment.js';
import { MysqlCredentialVaultRepository } from '../src/credentials/mysql-credential-vault.repository.js';

const enabled = process.env.M2_DURABLE_WORK_TEST === '1';
const timestamp = '2026-10-30 12:00:00.000000';

class AllowVaultAccess implements CredentialVaultAuthorizationPort {
  async authorize(): Promise<void> {}
}

test('M3.07 MariaDB envelopes enforce tenant context and restartable single-lease rotation', {
  skip: enabled ? false : 'Run in the disposable M2.05/M3 MariaDB profile with M2_DURABLE_WORK_TEST=1.',
}, async () => {
  await deployMigrations(readMigrationEnvironment(process.env));
  const environment = validateEnvironment(process.env);
  const database = new DurableWorkDatabase(environment);
  const dataSource = await database.getDataSource();
  const repository = new MysqlCredentialVaultRepository(database);
  const keyV1 = randomBytes(32);
  const keyV2 = randomBytes(32);
  const providerV1 = new ConfiguredCredentialKeyProvider(new CredentialKeyRingConfiguration('m3-test-v1', [{ version: 'm3-test-v1', key: keyV1 }]));
  const providerV2 = new ConfiguredCredentialKeyProvider(new CredentialKeyRingConfiguration('m3-test-v2', [
    { version: 'm3-test-v1', key: keyV1 },
    { version: 'm3-test-v2', key: keyV2 },
  ]));
  const actor = { actorRef: randomUUID(), correlationId: randomUUID() };
  const tenants = [randomUUID(), randomUUID()];
  const bindings = tenants.map((tenantId) => ({ tenantId, credentialId: randomUUID(), authorizationId: randomUUID(), appConfigurationId: randomUUID(), provider: 'META' as const, environment: 'test', family: 'USER_ACCESS' }));
  const lateBinding = { ...bindings[0]!, credentialId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' };

  try {
    await dataSource.query("SET time_zone = '+00:00'");
    for (const binding of bindings) {
      await dataSource.query(
        `INSERT INTO ca_meta_tenants (id, status, version, created_at, updated_at)
         VALUES (?, 'ACTIVE', 1, ?, ?)`, [binding.tenantId, timestamp, timestamp],
      );
      await dataSource.query(
        `INSERT INTO ca_meta_app_configurations (id, tenant_id, provider, app_external_id, environment, created_at, updated_at)
         VALUES (?, ?, 'META', ?, 'test', ?, ?)`,
        [binding.appConfigurationId, binding.tenantId, `m3-07-app-${binding.tenantId}`, timestamp, timestamp],
      );
      await dataSource.query(
        `INSERT INTO ca_meta_authorizations (id, tenant_id, app_configuration_id, provider, environment,
          provider_authorization_id, authorization_state, observed_at, created_at, updated_at)
         VALUES (?, ?, ?, 'META', 'test', ?, 'ACTIVE', ?, ?, ?)`,
        [binding.authorizationId, binding.tenantId, binding.appConfigurationId, `m3-07-auth-${binding.authorizationId}`, timestamp, timestamp, timestamp],
      );
      await dataSource.query(
        `INSERT INTO ca_meta_credentials
         (id, tenant_id, authorization_id, app_configuration_id, provider, environment, family, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'META', 'test', 'USER_ACCESS', 'ACTIVE', 1, ?, ?)`,
        [binding.credentialId, binding.tenantId, binding.authorizationId, binding.appConfigurationId, timestamp, timestamp],
      );
    }
    await dataSource.query(
      `INSERT INTO ca_meta_credentials
       (id, tenant_id, authorization_id, app_configuration_id, provider, environment, family, status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'META', 'test', 'USER_ACCESS', 'ACTIVE', 1, ?, ?)`,
      [lateBinding.credentialId, lateBinding.tenantId, lateBinding.authorizationId, lateBinding.appConfigurationId, timestamp, timestamp],
    );

    const writer = new CredentialVaultService(repository, providerV1, new AllowVaultAccess());
    const markerSecrets = bindings.map((_, index) => `m3-07-synthetic-marker-${index}`);
    for (const [index, binding] of bindings.entries()) {
      await writer.store({ ...binding, ...actor, secret: markerSecrets[index]! });
    }
    const persisted = await dataSource.query(
      `SELECT tenant_id, credential_id, ciphertext, nonce, authentication_tag, key_version
       FROM ca_meta_credential_secrets ORDER BY credential_id`,
    ) as Array<{ tenant_id: string; credential_id: string; ciphertext: Buffer; nonce: Buffer; authentication_tag: Buffer; key_version: string }>;
    assert.equal(persisted.length, 2);
    assert.ok(persisted.every((row) => row.key_version === 'm3-test-v1' && row.nonce.length === 12 && row.authentication_tag.length === 16));
    assert.ok(persisted.every((row) => markerSecrets.every((marker) => !row.ciphertext.includes(Buffer.from(marker)))));
    assert.ok(!JSON.stringify(persisted).includes(markerSecrets[0]!));

    const vault = new CredentialVaultService(repository, providerV2, new AllowVaultAccess());
    const denied = new CredentialVaultService(repository, providerV2, {
      async authorize() { throw new Error('synthetic policy denial'); },
    });
    await assert.rejects(denied.withCredential({ ...bindings[0]!, ...actor, operation: 'MESSAGE_SEND' }, async () => {}), CredentialVaultDeniedError);
    await assert.rejects(vault.withCredential({ ...bindings[1]!, tenantId: randomUUID(), ...actor, operation: 'MESSAGE_SEND' }, async () => {}));

    const snapshot = persisted.find((row) => row.credential_id === bindings[0]!.credentialId)!;
    const state = await vault.beginRotation(actor);
    const leaseAttempts = await Promise.all([
      repository.acquireRotationLease(state.targetKeyVersion, 'synthetic-worker-a', randomUUID(), 30),
      repository.acquireRotationLease(state.targetKeyVersion, 'synthetic-worker-b', randomUUID(), 30),
    ]);
    assert.equal(leaseAttempts.filter(Boolean).length, 1, 'the DB lease allows one replica to claim the rotation');
    await dataSource.query(
      'UPDATE ca_meta_credential_rotations SET lease_expires_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND) WHERE target_key_version = ?',
      [state.targetKeyVersion],
    );

    const firstBatch = await vault.rotateNextBatch(actor, state.targetKeyVersion, 1);
    assert.equal(firstBatch.processed, 1);
    assert.equal(firstBatch.done, false);
    const restartedWorker = new CredentialVaultService(repository, providerV2, new AllowVaultAccess());
    const secondBatch = await restartedWorker.rotateNextBatch(actor, state.targetKeyVersion, 1);
    assert.equal(secondBatch.processed, 1);
    assert.equal(secondBatch.done, true);
    const staleWriter = new CredentialVaultService(repository, providerV1, new AllowVaultAccess());
    await assert.rejects(
      staleWriter.store({ ...lateBinding, ...actor, secret: 'm3-07-stale-replica-marker' }),
      CredentialVaultOperationError,
    );
    assert.equal(Number((await dataSource.query(
      'SELECT COUNT(*) AS count FROM ca_meta_credential_secrets WHERE tenant_id = ? AND credential_id = ?',
      [lateBinding.tenantId, lateBinding.credentialId],
    ) as Array<{ count: string | number }>)[0]?.count ?? 0), 0, 'a stale replica cannot write after rotation completion');
    const keyVersions = await dataSource.query('SELECT DISTINCT key_version FROM ca_meta_credential_secrets') as Array<{ key_version: string }>;
    assert.deepEqual(keyVersions.map((row) => row.key_version), ['m3-test-v2']);
    const decrypted: string[] = [];
    const accessResults = await Promise.all(bindings.map((binding) => restartedWorker.withCredential(
      { ...binding, ...actor, operation: 'MESSAGE_SEND' }, async (secret) => { decrypted.push(secret); },
    )));
    assert.deepEqual(accessResults, [undefined, undefined], 'withCredential returns no callback value');
    assert.deepEqual(new Set(decrypted), new Set(markerSecrets));

    // Restore the captured v1 envelope in the isolated test DB and verify only the retained v1 key can recover it.
    await dataSource.query(
      `UPDATE ca_meta_credential_secrets SET ciphertext = ?, nonce = ?, authentication_tag = ?, key_version = 'm3-test-v1'
       WHERE tenant_id = ? AND credential_id = ?`,
      [snapshot.ciphertext, snapshot.nonce, snapshot.authentication_tag, snapshot.tenant_id, snapshot.credential_id],
    );
    let restored = '';
    const restoreResult = await restartedWorker.withCredential({ ...bindings[0]!, ...actor, operation: 'MESSAGE_SEND' }, async (secret) => { restored = secret; });
    assert.equal(restoreResult, undefined);
    assert.equal(restored, markerSecrets[0]);
    const missingV1 = new CredentialVaultService(repository,
      new ConfiguredCredentialKeyProvider(new CredentialKeyRingConfiguration('m3-test-v2', [{ version: 'm3-test-v2', key: keyV2 }])),
      new AllowVaultAccess());
    await assert.rejects(missingV1.withCredential({ ...bindings[0]!, ...actor, operation: 'MESSAGE_SEND' }, async () => {}), CredentialVaultKeyUnavailableError);

    const auditRows = await dataSource.query(
      'SELECT action, operation, key_version, actor_ref FROM ca_meta_credential_access_audit WHERE tenant_id IN (?, ?) ORDER BY created_at',
      tenants,
    ) as Array<{ action: string; operation: string; key_version: string; actor_ref: string }>;
    assert.ok(auditRows.some((row) => row.action === 'STORE'));
    assert.ok(auditRows.some((row) => row.action === 'DECRYPT' && row.operation === 'MESSAGE_SEND'));
    assert.ok(auditRows.some((row) => row.action === 'ROTATE' && row.key_version === 'm3-test-v2'));
    assert.ok(!JSON.stringify(auditRows).includes(markerSecrets[0]!));
  } finally {
    keyV1.fill(0);
    keyV2.fill(0);
    await database.close();
  }
});
