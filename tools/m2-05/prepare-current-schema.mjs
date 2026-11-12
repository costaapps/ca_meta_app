import assert from 'node:assert/strict';
import { createConnection } from 'mysql2/promise';
import { readMigrationEnvironment } from '../../apps/api/dist-test/src/database/migrations/migration-environment.js';
import {
  CoexistenceLockDeleteGrantRequiredError,
  deployMigrations,
  readMigrationStatus,
} from '../../apps/api/dist-test/src/database/migrations/migration-runner.js';
import { MIGRATIONS } from '../../apps/api/dist-test/src/database/migrations/migrations.js';

const environment = readMigrationEnvironment(process.env);
const databaseName = environment.database.name;
const migrationUser = environment.database.user;
assert.equal(databaseName, 'ca_meta_m205', 'this setup is only for the disposable M2.05 schema');
assert.equal(environment.database.host, '127.0.0.1', 'the M2.05 schema must be reached over loopback');
assert.equal(migrationUser, 'ca_meta_migrator', 'the setup must use its dedicated synthetic migration account');
assert.match(databaseName, /^[A-Za-z0-9_]+$/);
assert.match(migrationUser, /^[A-Za-z0-9_]+$/);
assert.ok(process.env.M2_ROOT_PASSWORD, 'the disposable M2.05 harness provides its synthetic root credential');

const before = await readMigrationStatus(environment);
assert.deepEqual(before.migrations, [], 'the M2.05 Compose project starts with a fresh schema');
assert.ok(MIGRATIONS.length >= 2, 'the current migration registry has a terminal migration');

// Apply the existing chain, then let the v22 runner create its table and pause without DELETE.
await deployMigrations(environment, MIGRATIONS.slice(0, -1));
await assert.rejects(
  deployMigrations(environment),
  (error) => error instanceof CoexistenceLockDeleteGrantRequiredError,
  'the synthetic schema pauses before the v22 trigger until its exact table grant is provided',
);

const root = await createConnection({
  host: environment.database.host,
  port: environment.database.port,
  database: databaseName,
  user: 'root',
  password: process.env.M2_ROOT_PASSWORD,
  connectTimeout: environment.database.connectTimeoutMs,
  multipleStatements: false,
  dateStrings: true,
  charset: 'utf8mb4',
});
try {
  const [context] = await root.query(
    "SELECT DATABASE() AS database_name, SUBSTRING_INDEX(CURRENT_USER(), '@', 1) AS database_account",
  );
  assert.equal(context[0]?.database_name, databaseName);
  assert.equal(context[0]?.database_account, 'root');
  await root.query(
    `GRANT DELETE ON \`${databaseName}\`.\`ca_meta_onboarding_coexistence_locks\` TO '${migrationUser}'@'%'`,
  );
} finally {
  await root.end();
}

await deployMigrations(environment);
const recovered = await readMigrationStatus(environment);
assert.equal(recovered.migrations.length, MIGRATIONS.length);
assert.ok(recovered.migrations.every((migration) => migration.state === 'APPLIED' && migration.checksumMatches));
process.stdout.write(`Disposable M2.05 schema prepared through v${MIGRATIONS.at(-1)?.schemaVersion} with the table-scoped trigger grant.\n`);
