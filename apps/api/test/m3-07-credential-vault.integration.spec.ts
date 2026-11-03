import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { CredentialKeyRingConfiguration, validateEnvironment } from '../src/config/environment.js';
import { CredentialVaultDeniedError, CredentialVaultKeyUnavailableError,
  CredentialVaultOperationError, CredentialVaultRotationError } from '../src/credentials/credential-vault.errors.js';
import { ConfiguredCredentialKeyProvider } from '../src/credentials/credential-key-provider.js';
import { CredentialVaultService } from '../src/credentials/credential-vault.service.js';
import type { CredentialVaultAuthorizationPort } from '../src/credentials/credential-vault.types.js';
import { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { deployMigrations } from '../src/database/migrations/migration-runner.js';
import { readMigrationEnvironment } from '../src/database/migrations/migration-environment.js';
import { MysqlCredentialVaultRepository } from '../src/credentials/mysql-credential-vault.repository.js';
import { AuditEventWriter } from '../src/privacy/audit.service.js';

const enabled = process.env.M2_DURABLE_WORK_TEST === '1';
const timestamp = '2026-10-30 12:00:00.000000';
function assertMarkersAbsent(value: Buffer | string, markers: readonly string[], label: string): void {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  for (const marker of markers) {
    const markerBytes = Buffer.from(marker, 'utf8');
    const representations = [markerBytes, Buffer.from(markerBytes.toString('hex')), Buffer.from(markerBytes.toString('base64'))];
    assert.equal(representations.some((representation) => bytes.includes(representation)), false,
      `${label} does not expose a synthetic credential marker`);
  }
}

function readFilesRecursively(directory: string): Buffer[] {
  if (!existsSync(directory)) return [];
  const contents: Buffer[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) contents.push(...readFilesRecursively(path));
    else if (entry.isFile()) contents.push(readFileSync(path));
  }
  return contents;
}

function assertApplicationArtifactsRedacted(markers: readonly string[]): void {
  const repositoryRoot = process.cwd();
  const appArtifactPaths = [
    resolve(repositoryRoot, 'apps/api/dist'),
    resolve(repositoryRoot, 'apps/api/dist-test'),
  ];
  for (const directory of appArtifactPaths) {
    for (const content of readFilesRecursively(directory)) {
      assertMarkersAbsent(content, markers, 'application/test build artifacts');
    }
  }
}

function runDisposableMariaDbCommand(arguments_: string[], input?: Buffer): Buffer {
  const composeProject = process.env.M2_COMPOSE_PROJECT;
  const composeFile = process.env.M2_COMPOSE_FILE;
  assert.ok(composeProject && composeFile, 'the disposable MariaDB profile provides its Compose project');
  const result = spawnSync('docker', [
    'compose', '-p', composeProject, '-f', composeFile, ...arguments_,
  ], { input, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  assert.equal(result.error, undefined, 'the disposable MariaDB backup command starts successfully');
  assert.equal(result.status, 0, 'the disposable MariaDB backup command completes successfully');
  return result.stdout ?? Buffer.alloc(0);
}

function createDatabaseDump(): Buffer {
  return runDisposableMariaDbCommand([
    'exec', '-T', 'mariadb', 'sh', '-lc',
    'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb-dump --user=root --single-transaction --hex-blob --skip-comments --databases ca_meta_m205',
  ]);
}

function restoreDatabaseDump(dump: Buffer): void {
  runDisposableMariaDbCommand([
    'exec', '-T', 'mariadb', 'sh', '-lc',
    'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb --user=root -e "DROP DATABASE IF EXISTS ca_meta_m205"',
  ]);
  runDisposableMariaDbCommand([
    'exec', '-T', 'mariadb', 'sh', '-lc',
    'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb --user=root',
  ], dump);
}

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
  const repository = new MysqlCredentialVaultRepository(database, new AuditEventWriter(database));
  let restoredDatabase: DurableWorkDatabase | undefined;
  const keyV1 = randomBytes(32);
  const keyV2 = randomBytes(32);
  const keyV3 = randomBytes(32);
  const providerV1 = new ConfiguredCredentialKeyProvider(new CredentialKeyRingConfiguration('m3-test-v1', [{ version: 'm3-test-v1', key: keyV1 }]));
  const providerV2 = new ConfiguredCredentialKeyProvider(new CredentialKeyRingConfiguration('m3-test-v2', [
    { version: 'm3-test-v1', key: keyV1 },
    { version: 'm3-test-v2', key: keyV2 },
  ]));
  const providerV3 = new ConfiguredCredentialKeyProvider(new CredentialKeyRingConfiguration('m3-test-v3', [
    { version: 'm3-test-v1', key: keyV1 },
    { version: 'm3-test-v2', key: keyV2 },
    { version: 'm3-test-v3', key: keyV3 },
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
    const markerSeed = process.env.M2_COMPOSE_PROJECT?.slice('m205-'.length) ?? '';
    assert.match(markerSeed, /^[a-f0-9]{32}$/i, 'the disposable MariaDB profile provides a synthetic run identifier');
    const markerSecrets = bindings.map((_, index) =>
      `m3-07-synthetic-marker-${index}-${markerSeed}`);
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
    const staleV2Lease = await repository.acquireRotationLease(
      state.targetKeyVersion, 'synthetic-stale-v2-worker', randomUUID(), 30,
    );
    assert.ok(staleV2Lease);
    const v3Worker = new CredentialVaultService(repository, providerV3, new AllowVaultAccess());
    const stateV3 = await v3Worker.beginRotation(actor);
    assert.equal(stateV3.targetKeyVersion, 'm3-test-v3');
    let staleTransformCalls = 0;
    await assert.rejects(repository.rotateBatch(staleV2Lease, 1, () => {
      staleTransformCalls += 1;
      throw new Error('stale transformer must not run');
    }, () => {
      throw new Error('stale audit builder must not run');
    }), /stale-rotation-key-version/);
    assert.equal(staleTransformCalls, 0, 'a v2 batch cannot transform after v3 becomes active');
    const staleV2Worker = new CredentialVaultService(repository, providerV2, new AllowVaultAccess());
    await assert.rejects(staleV2Worker.resumeRotation(actor, state.targetKeyVersion), CredentialVaultRotationError);
    const restartedWorker = new CredentialVaultService(repository, providerV3, new AllowVaultAccess());
    const secondBatch = await restartedWorker.rotateNextBatch(actor, stateV3.targetKeyVersion, 1);
    assert.equal(secondBatch.processed, 1);
    assert.equal(secondBatch.done, false);
    const thirdBatch = await restartedWorker.rotateNextBatch(actor, stateV3.targetKeyVersion, 1);
    assert.equal(thirdBatch.processed, 1);
    assert.equal(thirdBatch.done, true);
    const staleWriter = new CredentialVaultService(repository, providerV1, new AllowVaultAccess());
    await assert.rejects(staleWriter.beginRotation(actor), CredentialVaultRotationError, 'a retired v1 cannot become active again');
    await assert.rejects(staleWriter.resumeRotation(actor, 'm3-test-v1'), CredentialVaultRotationError);
    await assert.rejects(
      staleWriter.store({ ...lateBinding, ...actor, secret: 'm3-07-stale-replica-marker' }),
      CredentialVaultOperationError,
    );
    assert.equal(Number((await dataSource.query(
      'SELECT COUNT(*) AS count FROM ca_meta_credential_secrets WHERE tenant_id = ? AND credential_id = ?',
      [lateBinding.tenantId, lateBinding.credentialId],
    ) as Array<{ count: string | number }>)[0]?.count ?? 0), 0, 'a stale replica cannot write after rotation completion');
    const keyVersions = await dataSource.query('SELECT DISTINCT key_version FROM ca_meta_credential_secrets') as Array<{ key_version: string }>;
    assert.deepEqual(keyVersions.map((row) => row.key_version), ['m3-test-v3']);
    const versionHistory = await dataSource.query(
      'SELECT key_version, status FROM ca_meta_credential_vault_key_versions ORDER BY key_version',
    ) as Array<{ key_version: string; status: string }>;
    assert.deepEqual(versionHistory, [
      { key_version: 'm3-test-v1', status: 'RETIRED' },
      { key_version: 'm3-test-v2', status: 'RETIRED' },
      { key_version: 'm3-test-v3', status: 'ACTIVE' },
    ]);
    const decrypted: string[] = [];
    const accessResults = await Promise.all(bindings.map((binding) => restartedWorker.withCredential(
      { ...binding, ...actor, operation: 'MESSAGE_SEND' }, async (secret) => { decrypted.push(secret); },
    )));
    assert.deepEqual(accessResults, [undefined, undefined], 'withCredential returns no callback value');
    assert.equal(markerSecrets.every((marker) => decrypted.includes(marker)), true,
      'the authorized key recovers each synthetic marker');
    assertApplicationArtifactsRedacted(markerSecrets);

    const auditRows = await dataSource.query(
      'SELECT action, operation, key_version, actor_ref FROM ca_meta_credential_access_audit WHERE tenant_id IN (?, ?) ORDER BY created_at',
      tenants,
    ) as Array<{ action: string; operation: string; key_version: string; actor_ref: string }>;
    assert.ok(auditRows.some((row) => row.action === 'STORE'));
    assert.ok(auditRows.some((row) => row.action === 'DECRYPT' && row.operation === 'MESSAGE_SEND'));
    assert.ok(auditRows.some((row) => row.action === 'ROTATE' && row.key_version === 'm3-test-v2'));
    assert.ok(auditRows.some((row) => row.action === 'ROTATE' && row.key_version === 'm3-test-v3'));
    assert.ok(!JSON.stringify(auditRows).includes(markerSecrets[0]!));

    // Exercise a MariaDB logical backup artifact, drop the isolated schema, and restore its full contents.
    await database.close();
    const databaseDump = createDatabaseDump();
    assert.ok(databaseDump.length > 0, 'the isolated MariaDB dump is non-empty');
    assertMarkersAbsent(databaseDump, markerSecrets, 'MariaDB logical backup');
    restoreDatabaseDump(databaseDump);

    restoredDatabase = new DurableWorkDatabase(environment);
    const restoredRepository = new MysqlCredentialVaultRepository(restoredDatabase, new AuditEventWriter(restoredDatabase));
    const restoredVault = new CredentialVaultService(restoredRepository, providerV3, new AllowVaultAccess());
    const missingV3 = new CredentialVaultService(restoredRepository,
      new ConfiguredCredentialKeyProvider(new CredentialKeyRingConfiguration('m3-test-v3', [
        { version: 'm3-test-v2', key: keyV2 },
      ])), new AllowVaultAccess());
    await assert.rejects(missingV3.withCredential(
      { ...bindings[0]!, ...actor, operation: 'MESSAGE_SEND' }, async () => {},
    ), CredentialVaultKeyUnavailableError);
    const restoredMarkers: string[] = [];
    await Promise.all(bindings.map((binding) => restoredVault.withCredential(
      { ...binding, ...actor, operation: 'MESSAGE_SEND' }, async (secret) => { restoredMarkers.push(secret); },
    )));
    assert.equal(markerSecrets.every((marker) => restoredMarkers.includes(marker)), true,
      'the authorized retained key restores credential access after database restore');
    for (const [index, binding] of bindings.entries()) {
      assertMarkersAbsent(JSON.stringify(await restoredRepository.findActive(binding)), markerSecrets,
        `restored application record ${index}`);
    }
  } finally {
    keyV1.fill(0);
    keyV2.fill(0);
    keyV3.fill(0);
    await restoredDatabase?.close();
    await database.close();
  }
});
