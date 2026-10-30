import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection, type Connection } from 'mysql2/promise';
import { test } from 'node:test';
import { readMigrationEnvironment } from '../src/database/migrations/migration-environment.js';
import { MIGRATION_STEP_LEDGER, deployMigrations, migrationLockName, readMigrationStatus } from '../src/database/migrations/migration-runner.js';
import { MIGRATIONS } from '../src/database/migrations/migrations.js';

const enabled = process.env.M2_MIGRATION_TEST === '1';
const UUID_PREFIX = '00000000-0000-4000-8000-';
const uuid = (value: number): string => UUID_PREFIX + value.toString().padStart(12, '0');
const tenantIsolationFixture = JSON.parse(readFileSync(
  join(__dirname, '../../../../tools/m2-08/fixtures/tenant-isolation-negative.json'), 'utf8',
)) as {
  tenantA: 'primary';
  tenantB: 'other';
  appConfigurationTenant: 'primary' | 'other';
  assetTenant: 'primary' | 'other';
  expectedMariaDbError: string;
};

async function queryRows<T>(connection: Connection, sql: string, values: unknown[] = []): Promise<T[]> {
  const [result] = await connection.query(sql, values as never[]);
  return result as unknown as T[];
}

test('MariaDB migration ledger, implicit-commit recovery, backfill, role separation, tenant IDs and UTC precision', {
  skip: enabled ? false : 'Run through tools/m2-03/run-mariadb-tests.ps1 with its UUID-scoped MariaDB project.',
}, async () => {
  const environment = readMigrationEnvironment(process.env);
  const connectionOptions = {
    host: environment.database.host,
    port: environment.database.port,
    database: environment.database.name,
    user: process.env.API_DATABASE_USER,
    password: process.env.M2_API_DATABASE_PASSWORD,
    connectTimeout: environment.database.connectTimeoutMs,
    multipleStatements: false,
    dateStrings: true,
    charset: 'utf8mb4',
  };

  const crashAt = async (migrationId: string, variable: string, stepId: string, expectedCode: number): Promise<void> => {
    const child = fork(join(__dirname, 'fixtures', 'migration-crash-child.js'), [migrationId], {
      execPath: process.execPath,
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, [variable]: stepId },
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Migration crash fixture timed out at ${stepId}.`));
      }, 10_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    assert.equal(result.code, expectedCode, `child stopped at the requested crash point (${stepId}); stderr=${stderr}`);
    assert.equal(result.signal, null);
  };

  const admin = await createConnection(connectionOptions);
  try {
    await admin.query("SET time_zone = '+00:00'");
    await admin.query("SET SESSION sql_mode = CONCAT(@@session.sql_mode, ',STRICT_ALL_TABLES')");
    const before = await readMigrationStatus(environment);
    assert.deepEqual(before.migrations, []);

    const initial = MIGRATIONS[0];
    const additive = MIGRATIONS[1];
    assert.ok(initial && additive);
    await crashAt(initial.id, 'M2_CRASH_AFTER_DDL_STEP', 'create-tenants', 86);
    const partial = await readMigrationStatus(environment);
    assert.equal(partial.migrations[0]?.state, 'RUNNING');
    await Promise.all([deployMigrations(environment, [initial]), deployMigrations(environment, [initial])]);
    await deployMigrations(environment, [initial]);

    const tenantA = uuid(1);
    const tenantB = uuid(2);
    const appA = uuid(11);
    const appB = uuid(12);
    const timestamp = '2026-10-29 12:34:56.123456';
    await admin.query(
      'INSERT INTO ca_meta_tenants (id, created_at, updated_at) VALUES (?, ?, ?), (?, ?, ?)',
      [tenantA, timestamp, timestamp, tenantB, timestamp, timestamp],
    );
    await admin.query(
      `INSERT INTO ca_meta_app_configurations
       (id, tenant_id, provider, app_external_id, environment, created_at, updated_at)
       VALUES (?, ?, 'META', ?, 'test', ?, ?), (?, ?, 'META', ?, 'test', ?, ?)`,
      [appA, tenantA, '000123-app', timestamp, timestamp, appB, tenantB, '000123-app', timestamp, timestamp],
    );

    const externalId = '000-123|Zażółć 🧪';
    const rows: Array<[string, string, string, string, string, string, string]> = [];
    for (let index = 0; index < 10_000; index += 1) {
      const tenantId = index < 100 ? tenantA : tenantB;
      const appId = index < 100 ? appA : appB;
      rows.push([
        uuid(10_000 + index), tenantId, appId,
        index === 0 ? externalId : `synthetic-${index.toString().padStart(5, '0')}`,
        `legacy name ${index}`, timestamp, timestamp,
      ]);
    }
    rows.push([uuid(3000), tenantB, appB, externalId, 'same external id in another tenant', timestamp, timestamp]);
    for (let offset = 0; offset < rows.length; offset += 500) {
      const batch = rows.slice(offset, offset + 500);
      const valuesSql = batch.map(() => "(?, ?, ?, 'META', 'test', 'PAGE', ?, ?, ?, ?)").join(', ');
      await admin.query(
        `INSERT INTO ca_meta_assets
         (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id, display_name, created_at, updated_at)
        VALUES ${valuesSql}`,
        batch.flatMap((row) => row),
      );
    }
    const tenantByFixtureLabel = {
      [tenantIsolationFixture.tenantA]: tenantA,
      [tenantIsolationFixture.tenantB]: tenantB,
    };
    const longestSupportedExternalId = 'é'.repeat(512);
    await admin.query(
      `INSERT INTO ca_meta_assets
       (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id, display_name, created_at, updated_at)
       VALUES (?, ?, ?, 'META', 'test', 'PAGE', ?, 'maximum external id', ?, ?)`,
      [uuid(3001), tenantB, appB, longestSupportedExternalId, timestamp, timestamp],
    );

    await crashAt(additive.id, 'M2_CRASH_AFTER_BACKFILL_STEP', 'backfill-asset-external-name', 87);
    const stepRows = await queryRows<{ state: string; cursor_value: string | null }>(admin,
      `SELECT state, cursor_value FROM ${MIGRATION_STEP_LEDGER} WHERE migration_id = ? AND step_id = ?`,
      [additive.id, 'backfill-asset-external-name'],
    );
    assert.equal(stepRows[0]?.state, 'STARTED');
    assert.ok(stepRows[0]?.cursor_value, 'first committed batch cursor is persisted');

    // This N-1 id sorts below the stored cursor. The expansion trigger protects it while the backfill is paused.
    await admin.query(
      `INSERT INTO ca_meta_assets
       (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id, display_name, created_at, updated_at)
       VALUES (?, ?, ?, 'META', 'test', 'PAGE', ?, ?, ?, ?)`,
      [uuid(9000), tenantA, appA, 'n-1-during-backfill', 'written during partial backfill', timestamp, timestamp],
    );
    const duringBackfillWrite = await queryRows<{ external_name: string | null }>(admin,
      'SELECT external_name FROM ca_meta_assets WHERE id = ?', [uuid(9000)],
    );
    assert.equal(duringBackfillWrite[0]?.external_name, 'written during partial backfill');
    assert.ok(String(stepRows[0]?.cursor_value).localeCompare(uuid(9000)) > 0, 'test writer ID is behind the persisted cursor');

    await deployMigrations(environment, [additive]);
    await deployMigrations(environment);
    const backfillRows = await queryRows<{ count: string | number }>(admin,
      'SELECT COUNT(*) AS count FROM ca_meta_assets WHERE external_name IS NULL OR BINARY external_name <> BINARY display_name',
    );
    assert.equal(Number(backfillRows[0]?.count ?? 0), 0);

    const preserved = await queryRows<{ id: string; external_id: string; created_at: string; external_name: string }>(admin,
      `SELECT id, external_id, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at,
              external_name FROM ca_meta_assets WHERE id = ?`,
      [uuid(10_000)],
    );
    assert.equal(preserved[0]?.id, uuid(10_000));
    assert.equal(preserved[0]?.external_id, externalId);
    assert.equal(preserved[0]?.created_at, timestamp);
    assert.equal(preserved[0]?.external_name, 'legacy name 0');
    const migratedNMinusOne = await queryRows<{ display_name: string; external_name: string | null }>(admin,
      'SELECT display_name, external_name FROM ca_meta_assets WHERE id = ?', [uuid(9000)],
    );
    assert.equal(migratedNMinusOne[0]?.display_name, 'written during partial backfill');
    assert.equal(migratedNMinusOne[0]?.external_name, 'written during partial backfill');
    const longIdRows = await queryRows<{ external_id: string; char_length: number; byte_length: number }>(admin,
      'SELECT external_id, CHAR_LENGTH(external_id) AS char_length, OCTET_LENGTH(external_id) AS byte_length FROM ca_meta_assets WHERE id = ?',
      [uuid(3001)],
    );
    assert.equal(longIdRows[0]?.external_id, longestSupportedExternalId);
    assert.equal(Number(longIdRows[0]?.char_length), 512);
    assert.equal(Number(longIdRows[0]?.byte_length), 1024);

    // An N-1 writer can keep inserting the old column after the additive migration.
    await admin.query(
      `INSERT INTO ca_meta_assets
       (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id, display_name, created_at, updated_at)
       VALUES (?, ?, ?, 'META', 'test', 'PAGE', ?, ?, ?, ?)`,
      [uuid(30_001), tenantA, appA, 'n-1-write-0007', 'written by old client', timestamp, timestamp],
    );
    const nMinusOne = await queryRows<{ display_name: string; external_name: string | null }>(admin,
      'SELECT display_name, external_name FROM ca_meta_assets WHERE id = ?', [uuid(30_001)],
    );
    assert.equal(nMinusOne[0]?.display_name, 'written by old client');
    assert.equal(nMinusOne[0]?.external_name, 'written by old client');
    await admin.query('UPDATE ca_meta_assets SET display_name = ? WHERE id = ?', ['updated by N-1 writer', uuid(30_001)]);
    const updatedNMinusOne = await queryRows<{ display_name: string; external_name: string | null }>(admin,
      'SELECT display_name, external_name FROM ca_meta_assets WHERE id = ?', [uuid(30_001)],
    );
    assert.equal(updatedNMinusOne[0]?.display_name, 'updated by N-1 writer');
    assert.equal(updatedNMinusOne[0]?.external_name, 'updated by N-1 writer');
    await admin.query('UPDATE ca_meta_assets SET display_name = ? WHERE id = ?', ['updated by N-1 writer ', uuid(30_001)]);
    const trailingSpaceName = await queryRows<{ display_name: string; external_name: string | null; display_name_bytes: number; external_name_bytes: number }>(admin,
      `SELECT display_name, external_name, OCTET_LENGTH(display_name) AS display_name_bytes,
              OCTET_LENGTH(external_name) AS external_name_bytes
       FROM ca_meta_assets WHERE id = ?`, [uuid(30_001)],
    );
    assert.equal(trailingSpaceName[0]?.display_name, 'updated by N-1 writer ');
    assert.equal(trailingSpaceName[0]?.external_name, 'updated by N-1 writer ');
    assert.equal(Number(trailingSpaceName[0]?.external_name_bytes), Number(trailingSpaceName[0]?.display_name_bytes));
    await admin.query('UPDATE ca_meta_assets SET display_name = ? WHERE id = ?', ['updated by N-1 writer', uuid(30_001)]);
    const revertedTrailingSpaceName = await queryRows<{ display_name: string; external_name: string | null }>(admin,
      'SELECT display_name, external_name FROM ca_meta_assets WHERE id = ?', [uuid(30_001)],
    );
    assert.equal(revertedTrailingSpaceName[0]?.display_name, 'updated by N-1 writer');
    assert.equal(revertedTrailingSpaceName[0]?.external_name, 'updated by N-1 writer');

    // The asset unique identity includes tenant scope; the same provider ID in another tenant survived.
    const duplicateCheck = await queryRows<{ count: string | number }>(admin,
      'SELECT COUNT(*) AS count FROM ca_meta_assets WHERE external_id = ?', [externalId],
    );
    assert.equal(Number(duplicateCheck[0]?.count), 2);
    const assetCandidateKey = await queryRows<{ name: string }>(admin,
      `SELECT column_name AS name FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'ca_meta_assets'
         AND index_name = 'uq_ca_meta_asset_tenant_id' AND non_unique = 0
       ORDER BY seq_in_index`,
    );
    assert.deepEqual(assetCandidateKey.map((row) => row.name), ['tenant_id', 'id']);
    const trailingSpaceId = `${externalId} `;
    await admin.query(
      `INSERT INTO ca_meta_assets
       (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id, display_name, created_at, updated_at)
       VALUES (?, ?, ?, 'META', 'test', 'PAGE', ?, 'trailing-space identity', ?, ?)`,
      [uuid(4004), tenantA, appA, trailingSpaceId, timestamp, timestamp],
    );
    const exactIdentityCount = await queryRows<{ count: string | number }>(admin,
      'SELECT COUNT(*) AS count FROM ca_meta_assets WHERE external_id = ?', [trailingSpaceId],
    );
    assert.equal(Number(exactIdentityCount[0]?.count), 1, 'NO PAD binary collation distinguishes an external ID with a trailing space');
    const preservedTrailingSpace = await queryRows<{ external_id: string; external_name: string | null }>(admin,
      'SELECT external_id, external_name FROM ca_meta_assets WHERE id = ?', [uuid(4004)],
    );
    assert.equal(preservedTrailingSpace[0]?.external_id, trailingSpaceId);
    assert.equal(preservedTrailingSpace[0]?.external_name, 'trailing-space identity');
    await assert.rejects(
      admin.query(
        `INSERT INTO ca_meta_assets
         (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id, display_name, created_at, updated_at, external_name)
         VALUES (?, ?, ?, 'META', 'test', 'PAGE', ?, 'new writer', ?, ?, 'new writer')`,
        [uuid(4001), tenantA, appA, externalId, timestamp, timestamp],
      ),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_DUP_ENTRY',
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO ca_meta_assets
         (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id, display_name, created_at, updated_at)
         VALUES (?, ?, ?, 'META', 'test', 'PAGE', ?, 'too long', ?, ?)`,
        [uuid(4003), tenantA, appA, `${longestSupportedExternalId}é`, timestamp, timestamp],
      ),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_DATA_TOO_LONG',
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO ca_meta_assets
         (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id, display_name, created_at, updated_at)
         VALUES (?, ?, ?, 'META', 'test', 'PAGE', 'cross-tenant-fk', 'invalid', ?, ?)`,
        [
          uuid(4002),
          tenantByFixtureLabel[tenantIsolationFixture.assetTenant],
          tenantByFixtureLabel[tenantIsolationFixture.appConfigurationTenant] === tenantA ? appA : appB,
          timestamp,
          timestamp,
        ],
      ),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === tenantIsolationFixture.expectedMariaDbError,
    );

    // Session ownership lands in M3; synthetic volume checks that tenant-scoped plans use indexes without forcing them.
    const migrationConnection = await createConnection({
      ...connectionOptions,
      user: environment.database.user,
      password: environment.database.password,
    });
    try {
      await migrationConnection.query('ANALYZE TABLE ca_meta_assets');
      const explain = await queryRows<{ key: string | null; type: string }>(admin,
        `EXPLAIN SELECT id FROM ca_meta_assets
         WHERE tenant_id = ? AND asset_kind = 'PAGE' ORDER BY created_at LIMIT 20`,
        [tenantA],
      );
      assert.equal(explain[0]?.key, 'ix_ca_meta_asset_tenant_kind_created');
      assert.notEqual(explain[0]?.type, 'ALL', 'synthetic tenant-scoped asset query avoids full table scan');

      await migrationConnection.query(`CREATE TABLE IF NOT EXISTS ca_meta_m203_session_fixture (
        id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        secret_hash BINARY(32) NOT NULL,
        issued_at DATETIME(6) NOT NULL,
        idle_at DATETIME(6) NOT NULL,
        expires_at DATETIME(6) NOT NULL,
        revoked_at DATETIME(6) NULL,
        version BIGINT UNSIGNED NOT NULL DEFAULT 1,
        UNIQUE KEY uq_m203_session_secret (secret_hash),
        KEY ix_m203_session_tenant_live (tenant_id, revoked_at, expires_at)
      ) ENGINE=InnoDB`);
      const sessionRows: Array<[string, string, string, string, string, string]> = [];
      for (let index = 0; index < 10_000; index += 1) {
        const id = uuid(50_000 + index);
        sessionRows.push([id, index < 100 ? tenantA : tenantB, id, timestamp, timestamp, '2027-10-29 12:34:56.123456']);
      }
      for (let offset = 0; offset < sessionRows.length; offset += 500) {
        const batch = sessionRows.slice(offset, offset + 500);
        const valuesSql = batch.map(() => '(?, ?, UNHEX(SHA2(?, 256)), ?, ?, ?)').join(', ');
        await migrationConnection.query(
          `INSERT INTO ca_meta_m203_session_fixture (id, tenant_id, secret_hash, issued_at, idle_at, expires_at)
           VALUES ${valuesSql}`,
          batch.flatMap((row) => row),
        );
      }
      await migrationConnection.query('ANALYZE TABLE ca_meta_m203_session_fixture');
      const sessionExplain = await queryRows<{ key: string | null; type: string }>(admin,
        `EXPLAIN SELECT id FROM ca_meta_m203_session_fixture
         WHERE tenant_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 20`,
        [tenantA, timestamp],
      );
      assert.equal(sessionExplain[0]?.key, 'ix_m203_session_tenant_live');
      assert.notEqual(sessionExplain[0]?.type, 'ALL', 'synthetic tenant-scoped session query avoids full table scan');
    } finally {
      await migrationConnection.end();
    }

    const applied = await readMigrationStatus(environment);
    assert.equal(applied.migrations.length, 3);
    assert.ok(applied.migrations.every((migration) => migration.state === 'APPLIED' && migration.checksumMatches));

    const runtime = await createConnection(connectionOptions);
    try {
      await runtime.query("SET time_zone = '+00:00'");
      await runtime.query("SET SESSION sql_mode = CONCAT(@@session.sql_mode, ',STRICT_ALL_TABLES')");
      const result = await queryRows<{ count: string | number }>(runtime, 'SELECT COUNT(*) AS count FROM ca_meta_assets');
      assert.equal(Number(result[0]?.count), 10_005);
      await assert.rejects(runtime.query('CREATE TABLE runtime_role_must_not_ddl (id INT PRIMARY KEY)'),
        (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_TABLEACCESS_DENIED_ERROR');
    } finally {
      await runtime.end();
    }

    const lock = migrationLockName(environment.database.name);
    const lockResult = await queryRows<{ acquired: number }>(admin, 'SELECT GET_LOCK(?, 0) AS acquired', [lock]);
    assert.equal(Number(lockResult[0]?.acquired), 1);
    try {
      await assert.rejects(deployMigrations(environment), /lock acquisition timed out or failed/);
    } finally {
      await admin.query('SELECT RELEASE_LOCK(?)', [lock]);
    }

    await Promise.all([deployMigrations(environment), deployMigrations(environment)]);
    const finalStatus = await readMigrationStatus(environment);
    assert.ok(finalStatus.migrations.every((migration) => migration.state === 'APPLIED' && migration.checksumMatches));
  } finally {
    await admin.end();
  }
});
