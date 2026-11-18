import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { CredentialKeyRingConfiguration, validateEnvironment } from '../src/config/environment.js';
import { CredentialVaultKeyUnavailableError } from '../src/credentials/credential-vault.errors.js';
import { ConfiguredCredentialKeyProvider } from '../src/credentials/credential-key-provider.js';
import { CredentialVaultService } from '../src/credentials/credential-vault.service.js';
import type { CredentialVaultAuthorizationPort } from '../src/credentials/credential-vault.types.js';
import { MysqlCredentialVaultRepository } from '../src/credentials/mysql-credential-vault.repository.js';
import { deployMigrations, readMigrationStatus } from '../src/database/migrations/migration-runner.js';
import { MIGRATIONS } from '../src/database/migrations/migrations.js';
import { readMigrationEnvironment } from '../src/database/migrations/migration-environment.js';
import { InboxService } from '../src/inbox/inbox-service.js';
import { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { DurableJobStore } from '../src/jobs/job-store.js';
import type { InboxEventEnvelope, OutboxEventEnvelope } from '../src/jobs/event-validation.js';
import { MysqlLegacyProjectionCheckpointStore } from '../src/legacy-projection/mysql-legacy-projection-checkpoints.js';
import { MysqlConnectionLifecycleCommandRepository } from '../src/meta-lifecycle/mysql-connection-lifecycle.repository.js';
import { MysqlPortalSessionStore } from '../src/identity/mysql-portal-session.store.js';
import { OutboxService } from '../src/outbox/outbox-service.js';
import { AuditEventWriter } from '../src/privacy/audit.service.js';

const enabled = process.env.M6_05_TEST === '1';
const sourceDatabaseName = 'ca_meta_m605';
const restoredDatabaseName = 'ca_meta_m605_restore';
const backupMagic = Buffer.from('M605BK01', 'ascii');
const backupAad = Buffer.from('ca-meta:m6-05:logical-database:format-1', 'utf8');
const backupNonceLength = 12;
const backupTagLength = 16;

interface CredentialFixtureBinding {
  readonly tenantId: string;
  readonly credentialId: string;
  readonly authorizationId: string;
  readonly appConfigurationId: string;
  readonly provider: 'META';
  readonly environment: 'test';
  readonly family: 'USER_ACCESS';
}

class AllowVaultAccess implements CredentialVaultAuthorizationPort {
  async authorize(): Promise<void> {}
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertMarkersAbsent(value: Buffer | string, markers: readonly string[], label: string): void {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  for (const marker of markers) {
    const markerBytes = Buffer.from(marker, 'utf8');
    const representations = [markerBytes, Buffer.from(markerBytes.toString('hex')), Buffer.from(markerBytes.toString('base64'))];
    assert.equal(representations.some((representation) => bytes.includes(representation)), false,
      `${label} must not expose a synthetic credential marker`);
  }
}

function encryptBackup(plaintext: Buffer, key: Buffer): Buffer {
  assert.equal(key.length, 32, 'the synthetic backup key is AES-256 sized');
  const nonce = randomBytes(backupNonceLength);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: backupTagLength });
  cipher.setAAD(backupAad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([backupMagic, nonce, cipher.getAuthTag(), ciphertext]);
}

function decryptBackup(artifact: Buffer, key: Buffer): Buffer {
  const headerLength = backupMagic.length + backupNonceLength + backupTagLength;
  if (key.length !== 32 || artifact.length < headerLength || !artifact.subarray(0, backupMagic.length).equals(backupMagic)) {
    throw new Error('backup-envelope-invalid');
  }
  const nonceStart = backupMagic.length;
  const tagStart = nonceStart + backupNonceLength;
  const ciphertextStart = tagStart + backupTagLength;
  const decipher = createDecipheriv('aes-256-gcm', key, artifact.subarray(nonceStart, tagStart), { authTagLength: backupTagLength });
  decipher.setAAD(backupAad);
  decipher.setAuthTag(artifact.subarray(tagStart, ciphertextStart));
  try {
    return Buffer.concat([decipher.update(artifact.subarray(ciphertextStart)), decipher.final()]);
  } catch {
    throw new Error('backup-authentication-failed');
  }
}

function runCompose(arguments_: string[], input?: Buffer): Buffer {
  const project = process.env.M6_05_COMPOSE_PROJECT;
  const composeFile = process.env.M6_05_COMPOSE_FILE;
  assert.ok(project && /^m605-[a-f0-9]{32}$/i.test(project), 'the harness provides its UUID-scoped Compose project');
  assert.ok(composeFile, 'the harness provides its Compose file');
  const result = spawnSync('docker', ['compose', '-p', project, '-f', composeFile, ...arguments_], {
    input, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  assert.equal(result.error, undefined, 'the owned disposable MariaDB command starts');
  assert.equal(result.status, 0, 'the owned disposable MariaDB command completes');
  return result.stdout ?? Buffer.alloc(0);
}

function createLogicalDump(): Buffer {
  const rootPassword = process.env.M6_05_DB_ROOT_PASSWORD;
  assert.ok(rootPassword, 'the runner provides a temporary synthetic root password');
  return runCompose([
    'exec', '-T', '-e', `MYSQL_PWD=${rootPassword}`, 'mariadb', 'mariadb-dump', '--user=root',
    '--single-transaction', '--quick', '--hex-blob', '--routines', '--events', '--triggers', sourceDatabaseName,
  ]);
}

function createEmptyRestoreSchema(): void {
  const rootPassword = process.env.M6_05_DB_ROOT_PASSWORD;
  assert.ok(rootPassword);
  runCompose([
    'exec', '-T', '-e', `MYSQL_PWD=${rootPassword}`, 'mariadb', 'mariadb', '--user=root',
    '--execute', `CREATE DATABASE \`${restoredDatabaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
  ]);
  runCompose([
    'exec', '-T', '-e', `MYSQL_PWD=${rootPassword}`, 'mariadb', 'mariadb', '--user=root',
    '--execute', `GRANT SELECT, INSERT, UPDATE, DELETE ON \`${restoredDatabaseName}\`.* TO 'ca_meta_api'@'%'`,
  ]);
}

function restoreLogicalDump(plaintext: Buffer): void {
  const rootPassword = process.env.M6_05_DB_ROOT_PASSWORD;
  assert.ok(rootPassword);
  runCompose([
    'exec', '-T', '-e', `MYSQL_PWD=${rootPassword}`, 'mariadb', 'mariadb', '--user=root', `--database=${restoredDatabaseName}`,
  ], plaintext);
}

function queryCompose(sql: string, databaseName: string): string {
  const rootPassword = process.env.M6_05_DB_ROOT_PASSWORD;
  assert.ok(rootPassword);
  return runCompose([
    'exec', '-T', '-e', `MYSQL_PWD=${rootPassword}`, 'mariadb', 'mariadb', '--user=root', `--database=${databaseName}`,
    '--batch', '--skip-column-names', '--execute', sql,
  ]).toString('utf8').trim();
}

function inboxFixture(appConfigRef: string, eventId: string): InboxEventEnvelope {
  const now = new Date().toISOString();
  return {
    eventId,
    schemaVersion: 1,
    eventType: 'provider.message.received',
    appConfigRef,
    tenantRef: null,
    actor: { kind: 'PROVIDER', ref: 'm6-05-synthetic-provider' },
    correlationId: `m6-05-corr-${randomUUID()}`,
    causationId: null,
    aggregateRef: `m6-05-aggregate-${randomUUID()}`,
    aggregateVersion: 1,
    occurredAt: now,
    receivedAt: now,
    protectedPayloadRef: `m6-05-protected-${randomUUID()}`,
    routingState: 'PENDING',
    safeMetadata: {
      kind: 'MESSAGE_RECEIVED',
      assetRef: `m6-05-asset-${randomUUID()}`,
      messageRef: `m6-05-message-${randomUUID()}`,
      channel: 'WHATSAPP',
    },
  };
}

function outboxFixture(tenantId: string, eventId: string): OutboxEventEnvelope {
  const now = new Date().toISOString();
  return {
    eventId,
    tenantRef: tenantId,
    schemaVersion: 1,
    eventType: 'reply.requested',
    aggregateRef: `m6-05-operation-${randomUUID()}`,
    aggregateVersion: 1,
    actor: { kind: 'SYSTEM', ref: 'm6-05-synthetic-recovery' },
    correlationId: `m6-05-outbox-corr-${randomUUID()}`,
    causationId: null,
    createdAt: now,
    enqueuedAt: now,
    data: {
      kind: 'REPLY_REQUESTED',
      assetRef: `m6-05-asset-${randomUUID()}`,
      messageRef: `m6-05-message-${randomUUID()}`,
      operationRef: `m6-05-operation-${randomUUID()}`,
    },
  };
}

function migrationLedgerFingerprint(rows: readonly { schema_version: number | string; migration_id: string; checksum: string; state: string }[]): string {
  const canonical = rows.map((row) => `${row.schema_version}:${row.migration_id}:${row.checksum}:${row.state}`).join('\n');
  return sha256(canonical);
}

test('M6.05 restores an encrypted logical backup with keyring, durable state and safe recovery', {
  skip: enabled ? false : 'Run with tools/m6-05/run-restore.ps1 and its UUID-scoped MariaDB project.',
}, async () => {
  const backupPath = process.env.M6_05_BACKUP_PATH;
  const tempDirectory = process.env.M6_05_TEMP_DIRECTORY;
  assert.ok(backupPath && tempDirectory && resolve(backupPath).startsWith(`${resolve(tempDirectory)}\\`),
    'the encrypted backup artifact is confined to the run temporary directory');
  assert.equal(existsSync(backupPath), false, 'each run starts without a prior backup artifact');

  const migrationEnvironment = readMigrationEnvironment(process.env);
  await deployMigrations(migrationEnvironment);
  const migrationStatus = await readMigrationStatus(migrationEnvironment);
  assert.equal(migrationStatus.migrations.length, MIGRATIONS.length);
  assert.ok(migrationStatus.migrations.every((migration) => migration.state === 'APPLIED' && migration.checksumMatches));

  const sourceEnvironment = validateEnvironment(process.env);
  const sourceDatabase = new DurableWorkDatabase(sourceEnvironment);
  let restoredDatabase: DurableWorkDatabase | undefined;
  let restoredSessionStore: MysqlPortalSessionStore | undefined;
  const keyV1 = randomBytes(32);
  const keyV2 = randomBytes(32);
  const backupKey = randomBytes(32);
  const providerV1 = new ConfiguredCredentialKeyProvider(
    new CredentialKeyRingConfiguration('m6-05-v1', [{ version: 'm6-05-v1', key: keyV1 }]),
  );
  const providerV2 = new ConfiguredCredentialKeyProvider(new CredentialKeyRingConfiguration('m6-05-v2', [
    { version: 'm6-05-v1', key: keyV1 }, { version: 'm6-05-v2', key: keyV2 },
  ]));
  const actor = { actorRef: randomUUID(), correlationId: randomUUID() };
  const tenantId = randomUUID();
  const timestamp = '2026-11-18 12:00:00.000000';
  const bindings: CredentialFixtureBinding[] = [0, 1].map(() => ({
    tenantId,
    credentialId: randomUUID(),
    authorizationId: randomUUID(),
    appConfigurationId: randomUUID(),
    provider: 'META' as const,
    environment: 'test' as const,
    family: 'USER_ACCESS' as const,
  }));
  const revokedAuthorizationId = randomUUID();
  const credentialMarkers = bindings.map((_, index) => `m6-05-synthetic-credential-${index}-${randomUUID()}`);
  const checkpointKey = sha256('m6-05-synthetic-legacy-destination');
  const checkpointRef = `m6-05-asset-${randomUUID()}`;
  const checkpointHash = sha256('m6-05-synthetic-projection-state');
  const inboxEvent = inboxFixture(bindings[0]!.appConfigurationId, `m6-05-inbox-${randomUUID()}`);
  const outboxEvent = outboxFixture(tenantId, `m6-05-outbox-${randomUUID()}`);
  const portalPrincipalId = randomUUID();
  const portalSessionId = randomUUID();
  let sourceFixtureCommitAt: number | undefined;
  let dumpDurationMs = 0;
  let dumpCommandInvocationLagMs: number | null = null;
  let encryptionDurationMs = 0;
  let importDurationMs = 0;
  let backupBytes = 0;
  let logicalDumpBytes = 0;
  let backupSha256 = '';
  let sourceLedgerHash = '';
  let sourceTableCount = 0;
  let restoredTableCount = 0;
  let inboxJobId = '';
  let outboxJobId = '';
  let restoreSchemaStartedEmpty = false;
  let restoreStartedAt = 0;
  let rotationCursorPresent = false;
  let sessionRevoked = false;
  let revokedAuthorizationState: string | null = null;

  try {
    const source = await sourceDatabase.getDataSource();
    await source.query("SET time_zone = '+00:00'");
    await source.query('INSERT INTO ca_meta_tenants (id, created_at, updated_at) VALUES (?, ?, ?)', [tenantId, timestamp, timestamp]);
    for (const binding of bindings) {
      await source.query(
        `INSERT INTO ca_meta_app_configurations
         (id, tenant_id, provider, app_external_id, environment, created_at, updated_at)
         VALUES (?, ?, 'META', ?, 'test', ?, ?)`,
        [binding.appConfigurationId, tenantId, `m6-05-app-${binding.credentialId}`, timestamp, timestamp],
      );
      await source.query(
        `INSERT INTO ca_meta_authorizations
         (id, tenant_id, app_configuration_id, provider, environment, provider_authorization_id,
          authorization_state, observed_at, created_at, updated_at)
         VALUES (?, ?, ?, 'META', 'test', ?, 'ACTIVE', ?, ?, ?)`,
        [binding.authorizationId, tenantId, binding.appConfigurationId, `m6-05-auth-${binding.authorizationId}`,
          timestamp, timestamp, timestamp],
      );
      await source.query(
        `INSERT INTO ca_meta_credentials
         (id, tenant_id, authorization_id, app_configuration_id, provider, environment, family, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'META', 'test', 'USER_ACCESS', 'ACTIVE', 1, ?, ?)`,
        [binding.credentialId, tenantId, binding.authorizationId, binding.appConfigurationId, timestamp, timestamp],
      );
    }
    await source.query(
      `INSERT INTO ca_meta_authorizations
       (id, tenant_id, app_configuration_id, provider, environment, provider_authorization_id,
        authorization_state, observed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'META', 'test', ?, 'REVOKED', ?, ?, ?)`,
      [revokedAuthorizationId, tenantId, bindings[0]!.appConfigurationId,
        `m6-05-revoked-auth-${revokedAuthorizationId}`, timestamp, timestamp, timestamp],
    );
    const sourceRevokedAuthorization = await source.query(
      'SELECT authorization_state FROM ca_meta_authorizations WHERE tenant_id = ? AND id = ?',
      [tenantId, revokedAuthorizationId],
    ) as Array<{ authorization_state: string }>;
    assert.equal(sourceRevokedAuthorization[0]?.authorization_state, 'REVOKED');

    const vaultRepository = new MysqlCredentialVaultRepository(sourceDatabase, new AuditEventWriter(sourceDatabase));
    const writerV1 = new CredentialVaultService(vaultRepository, providerV1, new AllowVaultAccess());
    for (const [index, binding] of bindings.entries()) {
      await writerV1.store({ ...binding, ...actor, secret: credentialMarkers[index]! });
    }
    const writerV2 = new CredentialVaultService(vaultRepository, providerV2, new AllowVaultAccess());
    const rotationStarted = await writerV2.beginRotation(actor);
    assert.equal(rotationStarted.targetKeyVersion, 'm6-05-v2');
    const firstRotationBatch = await writerV2.rotateNextBatch(actor, 'm6-05-v2', 1);
    assert.equal(firstRotationBatch.processed, 1);
    assert.equal(firstRotationBatch.done, false, 'the restored fixture retains an intentionally partial key rotation');
    const rotationBeforeBackup = await writerV2.rotationState(actor, 'm6-05-v2');
    assert.equal(rotationBeforeBackup.state, 'RUNNING');
    assert.ok(rotationBeforeBackup.cursorCredentialId);

    const secretVersionsBeforeBackup = await source.query(
      'SELECT credential_id, key_version FROM ca_meta_credential_secrets WHERE tenant_id = ? ORDER BY credential_id',
      [tenantId],
    ) as Array<{ credential_id: string; key_version: string }>;
    assert.equal(secretVersionsBeforeBackup.length, 2);
    assert.deepEqual([...new Set(secretVersionsBeforeBackup.map((row) => row.key_version))].sort(), ['m6-05-v1', 'm6-05-v2']);

    const inbox = new InboxService(sourceDatabase, new DurableJobStore(sourceDatabase, () => 0));
    const persistedInbox = await inbox.persist(inboxEvent);
    assert.equal(persistedInbox.duplicate, false);
    assert.equal(persistedInbox.routingState, 'ROUTED');
    assert.ok(persistedInbox.jobId);
    inboxJobId = persistedInbox.jobId;

    const jobStore = new DurableJobStore(sourceDatabase, () => 0);
    const outbox = new OutboxService(sourceDatabase, jobStore);
    const appendedOutbox = await outbox.append(outboxEvent);
    assert.equal(appendedOutbox.duplicate, false);
    assert.ok(appendedOutbox.jobId);
    const ambiguousClaim = await jobStore.claimNext('m6-05-ambiguous-effect', 300_000, ['OUTBOX_DELIVER']);
    assert.equal(ambiguousClaim?.id, appendedOutbox.jobId);
    assert.equal(await jobStore.finish(ambiguousClaim!, { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' }, undefined,
      (manager, finalization) => outbox.finalizeDeliveryWithin(manager, ambiguousClaim!, finalization)), true);
    outboxJobId = appendedOutbox.jobId;

    const checkpoints = new MysqlLegacyProjectionCheckpointStore(sourceDatabase);
    await checkpoints.record({
      tenantId,
      destinationKeyHash: checkpointKey,
      centralRef: checkpointRef,
      sourceVersion: 9,
      projectionSchemaVersion: 1,
      contentHash: checkpointHash,
      tombstone: false,
      state: 'PENDING',
      safeErrorCode: null,
    });

    await source.query(
      `INSERT INTO ca_meta_principals (id, kind, issuer, subject, status, version, created_at, updated_at)
       VALUES (?, 'USER', 'm6-05.synthetic-issuer', ?, 'ACTIVE', 1, ?, ?)`,
      [portalPrincipalId, `m6-05-synthetic-subject-${randomUUID()}`, timestamp, timestamp],
    );
    await source.query(
      `INSERT INTO ca_meta_portal_sessions
       (id, principal_id, tenant_id, secret_hash, csrf_token_hash, context_ref_hash, context_version, entry_mode,
        created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'PORTAL_TOP_LEVEL', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6),
               DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 30 MINUTE), DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 8 HOUR), NULL)`,
      [portalSessionId, portalPrincipalId, tenantId, sha256(randomBytes(32)), sha256(randomBytes(32)), sha256(randomBytes(32))],
    );

    const ledgerRows = await source.query(
      'SELECT schema_version, migration_id, checksum, state FROM ca_meta_schema_migrations ORDER BY schema_version',
    ) as Array<{ schema_version: number | string; migration_id: string; checksum: string; state: string }>;
    assert.equal(ledgerRows.length, MIGRATIONS.length);
    assert.ok(ledgerRows.every((row) => row.state === 'APPLIED'));
    sourceLedgerHash = migrationLedgerFingerprint(ledgerRows);
    sourceTableCount = Number((await source.query(
      'SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE()',
    ) as Array<{ count: string | number }>)[0]?.count ?? 0);
    assert.ok(sourceTableCount > 0);
    sourceFixtureCommitAt = performance.now();
    await sourceDatabase.close();

    const dumpStartedAt = performance.now();
    const logicalDump = createLogicalDump();
    dumpDurationMs = performance.now() - dumpStartedAt;
    logicalDumpBytes = logicalDump.length;
    assert.ok(logicalDumpBytes > 0);
    assertMarkersAbsent(logicalDump, credentialMarkers, 'unencrypted logical backup SQL');

    const encryptionStartedAt = performance.now();
    const encryptedBackup = encryptBackup(logicalDump, backupKey);
    writeFileSync(backupPath, encryptedBackup, { flag: 'wx', mode: 0o600 });
    encryptionDurationMs = performance.now() - encryptionStartedAt;
    const reloadedBackup = readFileSync(backupPath);
    backupBytes = reloadedBackup.length;
    backupSha256 = sha256(reloadedBackup);
    assert.ok(backupBytes > logicalDumpBytes);
    assertMarkersAbsent(reloadedBackup, credentialMarkers, 'encrypted backup artifact');
    const tamperedBackup = Buffer.from(reloadedBackup);
    tamperedBackup[tamperedBackup.length - 1] = tamperedBackup[tamperedBackup.length - 1]! ^ 1;
    assert.throws(() => decryptBackup(tamperedBackup, backupKey), /backup-authentication-failed/,
      'AES-GCM rejects a modified backup before restore');
    const decryptedDump = decryptBackup(reloadedBackup, backupKey);
    assert.equal(sha256(decryptedDump), sha256(logicalDump), 'authenticated decryption reproduces the exact logical dump');
    logicalDump.fill(0);

    restoreStartedAt = performance.now();
    createEmptyRestoreSchema();
    restoreSchemaStartedEmpty = queryCompose(
      `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '${restoredDatabaseName}'`, sourceDatabaseName,
    ) === '0';
    assert.equal(restoreSchemaStartedEmpty, true);
    const importStartedAt = performance.now();
    restoreLogicalDump(decryptedDump);
    importDurationMs = performance.now() - importStartedAt;
    decryptedDump.fill(0);

    const restoredEnvironment = validateEnvironment({ ...process.env, API_DATABASE_NAME: restoredDatabaseName });
    restoredDatabase = new DurableWorkDatabase(restoredEnvironment);
    const restoredDataSource = await restoredDatabase.getDataSource();
    const restoredTableCountRows = await restoredDataSource.query(
      'SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE()',
    ) as Array<{ count: string | number }>;
    restoredTableCount = Number(restoredTableCountRows[0]?.count ?? 0);
    assert.equal(restoredTableCount, sourceTableCount, 'the logical restore preserves the complete source table set');
    const restoredLedgerRows = await restoredDataSource.query(
      'SELECT schema_version, migration_id, checksum, state FROM ca_meta_schema_migrations ORDER BY schema_version',
    ) as Array<{ schema_version: number | string; migration_id: string; checksum: string; state: string }>;
    assert.equal(restoredLedgerRows.length, MIGRATIONS.length);
    assert.equal(migrationLedgerFingerprint(restoredLedgerRows), sourceLedgerHash,
      'migration IDs, checksums and applied states survive restore');

    const restoredJobs = new DurableJobStore(restoredDatabase, () => 0);
    const restoredInbox = new InboxService(restoredDatabase, restoredJobs);
    const restoredOutbox = new OutboxService(restoredDatabase, restoredJobs);
    const restoredCheckpointStore = new MysqlLegacyProjectionCheckpointStore(restoredDatabase);
    const restoredVaultRepository = new MysqlCredentialVaultRepository(restoredDatabase, new AuditEventWriter(restoredDatabase));
    const restoredVault = new CredentialVaultService(restoredVaultRepository, providerV2, new AllowVaultAccess());

    const restoredRotation = await restoredVault.rotationState(actor, 'm6-05-v2');
    assert.equal(restoredRotation.state, 'RUNNING');
    rotationCursorPresent = restoredRotation.cursorCredentialId !== null;
    assert.equal(rotationCursorPresent, true, 'the partial key-rotation checkpoint survives restore');
    const restoredSecretVersions = await restoredDataSource.query(
      'SELECT credential_id, key_version, ciphertext FROM ca_meta_credential_secrets WHERE tenant_id = ? ORDER BY credential_id',
      [tenantId],
    ) as Array<{ credential_id: string; key_version: string; ciphertext: Buffer }>;
    assert.equal(restoredSecretVersions.length, 2);
    assert.deepEqual([...new Set(restoredSecretVersions.map((row) => row.key_version))].sort(), ['m6-05-v1', 'm6-05-v2']);
    assertMarkersAbsent(JSON.stringify(restoredSecretVersions), credentialMarkers, 'restored vault records');

    const oldVersionRow = restoredSecretVersions.find((row) => row.key_version === 'm6-05-v1');
    assert.ok(oldVersionRow, 'one credential remains on the old version during partial rotation');
    const oldBinding = bindings.find((binding) => binding.credentialId === oldVersionRow.credential_id);
    assert.ok(oldBinding);
    const missingOldKeyProvider = new ConfiguredCredentialKeyProvider(new CredentialKeyRingConfiguration('m6-05-v2', [
      { version: 'm6-05-v2', key: keyV2 },
    ]));
    const missingOldKeyVault = new CredentialVaultService(restoredVaultRepository, missingOldKeyProvider, new AllowVaultAccess());
    let missingKeyCallbackRan = false;
    await assert.rejects(missingOldKeyVault.withCredential(
      { ...oldBinding, ...actor, operation: 'BACKUP_RESTORE_CHECK' },
      async () => { missingKeyCallbackRan = true; },
    ), CredentialVaultKeyUnavailableError);
    assert.equal(missingKeyCallbackRan, false, 'a missing old key fails closed without exposing plaintext');

    const recoveredMarkers: string[] = [];
    for (const binding of bindings) {
      await restoredVault.withCredential({ ...binding, ...actor, operation: 'BACKUP_RESTORE_CHECK' }, async (secret) => {
        recoveredMarkers.push(secret);
      });
    }
    assert.deepEqual([...recoveredMarkers].sort(), [...credentialMarkers].sort(),
      'the authorized synthetic keyring recovers credentials from both versions');
    recoveredMarkers.fill('');

    const inboxRedelivery = await restoredInbox.persist({
      ...inboxEvent,
      receivedAt: new Date(Date.now() + 1_000).toISOString(),
      correlationId: `m6-05-redelivery-${randomUUID()}`,
      protectedPayloadRef: `m6-05-redelivery-handle-${randomUUID()}`,
    });
    assert.equal(inboxRedelivery.duplicate, true);
    assert.equal(inboxRedelivery.id, persistedInbox.id);
    assert.equal(inboxRedelivery.jobId, null, 'restored inbox redelivery does not enqueue a second local effect');

    const outboxRedelivery = await restoredOutbox.append(outboxEvent);
    assert.equal(outboxRedelivery.duplicate, true);
    assert.equal(outboxRedelivery.id, appendedOutbox.id);
    assert.equal(outboxRedelivery.jobId, null, 'restored outbox idempotency does not create a new delivery job');
    const noAmbiguousReplay = await restoredJobs.claimNext('m6-05-after-restore-no-replay', 300_000, ['OUTBOX_DELIVER']);
    assert.equal(noAmbiguousReplay, null, 'an UNKNOWN ambiguous effect is not replayable after restore');

    const [restoredInboxRow] = await restoredDataSource.query(
      `SELECT processing_state FROM ca_meta_inbox_events WHERE id = ? AND tenant_id = ?`,
      [persistedInbox.id, tenantId],
    ) as Array<{ processing_state: string }>;
    assert.equal(restoredInboxRow?.processing_state, 'PENDING');
    const [restoredOutboxRow] = await restoredDataSource.query(
      'SELECT delivery_state, attempt FROM ca_meta_outbox_events WHERE id = ? AND tenant_id = ?',
      [appendedOutbox.id, tenantId],
    ) as Array<{ delivery_state: string; attempt: number | string }>;
    assert.equal(restoredOutboxRow?.delivery_state, 'UNKNOWN');
    assert.equal(Number(restoredOutboxRow?.attempt), 1);
    const restoredJobRows = await restoredDataSource.query(
      `SELECT id, job_type, status, attempt FROM ca_meta_jobs WHERE tenant_id = ? AND id IN (?, ?) ORDER BY job_type`,
      [tenantId, inboxJobId, outboxJobId],
    ) as Array<{ id: string; job_type: string; status: string; attempt: number | string }>;
    assert.deepEqual(restoredJobRows.map((row) => [row.id, row.job_type, row.status, Number(row.attempt)]), [
      [inboxJobId, 'INBOX_PROCESS', 'QUEUED', 0],
      [outboxJobId, 'OUTBOX_DELIVER', 'UNKNOWN', 1],
    ]);

    const restoredCheckpoint = await restoredCheckpointStore.read(tenantId, checkpointKey, checkpointRef);
    assert.deepEqual(restoredCheckpoint, {
      tenantId,
      destinationKeyHash: checkpointKey,
      centralRef: checkpointRef,
      sourceVersion: 9,
      projectionSchemaVersion: 1,
      contentHash: checkpointHash,
      tombstone: false,
      state: 'PENDING',
      safeErrorCode: null,
    });

    const [activeSession] = await restoredDataSource.query(
      'SELECT revoked_at FROM ca_meta_portal_sessions WHERE id = ? AND principal_id = ? AND tenant_id = ?',
      [portalSessionId, portalPrincipalId, tenantId],
    ) as Array<{ revoked_at: string | null }>;
    assert.equal(activeSession?.revoked_at, null, 'the synthetic session exists as active immediately after restore');
    restoredSessionStore = new MysqlPortalSessionStore(restoredEnvironment);
    sessionRevoked = await restoredSessionStore.revokeSession(portalSessionId, portalPrincipalId);
    assert.equal(sessionRevoked, true, 'the recovery procedure revokes restored portal sessions through the application store');
    const [revokedSession] = await restoredDataSource.query(
      'SELECT revoked_at FROM ca_meta_portal_sessions WHERE id = ? AND principal_id = ?',
      [portalSessionId, portalPrincipalId],
    ) as Array<{ revoked_at: string | null }>;
    assert.ok(revokedSession?.revoked_at);

    dumpCommandInvocationLagMs = sourceFixtureCommitAt === undefined
      ? null
      : Number((dumpStartedAt - sourceFixtureCommitAt).toFixed(2));
    const recoveredAuthorization = await new MysqlConnectionLifecycleCommandRepository(
      restoredDatabase, new AuditEventWriter(restoredDatabase),
    ).findBinding({ tenantId, authorizationId: revokedAuthorizationId });
    assert.ok(recoveredAuthorization, 'the revoked Meta authorization remains available to the application lifecycle lookup');
    assert.equal(recoveredAuthorization.authorizationState, 'REVOKED',
      'recovery preserves the revoked authorization state instead of reactivating it');
    assert.equal(['ACTIVE', 'PARTIAL'].includes(recoveredAuthorization.authorizationState), false,
      'the restored revoked Meta authorization is not eligible as active');
    revokedAuthorizationState = recoveredAuthorization.authorizationState;
    const restoreProcedureMs = Number((performance.now() - restoreStartedAt).toFixed(2));
    process.stdout.write(`${JSON.stringify({
      evidenceClass: 'DISPOSABLE_MARIADB_ENCRYPTED_BACKUP_RESTORE',
      runtime: { node: process.version, mariadb: '11.8.8', schemaVersion: MIGRATIONS.at(-1)?.schemaVersion },
      sourceSchema: sourceDatabaseName,
      restoredSchema: restoredDatabaseName,
      restoredIntoEmptySchema: restoreSchemaStartedEmpty,
      migrationLedgerPreserved: migrationLedgerFingerprint(restoredLedgerRows) === sourceLedgerHash,
      sourceAndRestoreTableCounts: { source: sourceTableCount, restored: restoredTableCount },
      backup: {
        algorithm: 'AES-256-GCM',
        authenticated: true,
        tamperRejected: true,
        logicalDumpBytes,
        encryptedArtifactBytes: backupBytes,
        encryptedArtifactSha256: backupSha256,
        artifactTemporaryAndRemovedByRunner: true,
      },
      observationsOnly: {
        localDumpCommandInvocationLagFromLastSyntheticCommitMs: dumpCommandInvocationLagMs,
        logicalDumpMs: Number(dumpDurationMs.toFixed(2)),
        encryptionMs: Number(encryptionDurationMs.toFixed(2)),
        restoreImportMs: Number(importDurationMs.toFixed(2)),
        restoreProcedureMs,
        rpoRtoRatified: false,
      },
      recovered: {
        syntheticCredentialCount: restoredSecretVersions.length,
        preservedKeyVersions: [...new Set(restoredSecretVersions.map((row) => row.key_version))].sort(),
        partialRotationState: restoredRotation.state,
        rotationCursorPresent,
        missingOldKeyFailsClosed: !missingKeyCallbackRan,
        inboxState: restoredInboxRow?.processing_state,
        inboxRedeliveryIdempotent: inboxRedelivery.duplicate,
        outboxState: restoredOutboxRow?.delivery_state,
        outboxJobState: restoredJobRows.find((row) => row.id === outboxJobId)?.status,
        ambiguousOutboxNotReplayed: noAmbiguousReplay === null && outboxRedelivery.jobId === null,
        projectionCheckpointPreserved: restoredCheckpoint.state === 'PENDING',
        revokedAuthorizationState,
        revokedAuthorizationNotActive: revokedAuthorizationState === 'REVOKED',
        portalSessionRevokedDuringRecovery: sessionRevoked,
        providerCalls: 0,
      },
      localVolumeCleanup: 'UUID-scoped MariaDB volume and temporary encrypted artifact are removed by runner',
    }, null, 2)}\n`);
  } finally {
    keyV1.fill(0);
    keyV2.fill(0);
    backupKey.fill(0);
    await restoredSessionStore?.onApplicationShutdown();
    await restoredDatabase?.close();
    await sourceDatabase.close();
  }
});
