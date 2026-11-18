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
assert.equal(databaseName, 'ca_meta_m603', 'M6.03 setup only targets its disposable schema');
assert.equal(environment.database.host, '127.0.0.1', 'M6.03 MariaDB must be reached over loopback');
assert.equal(migrationUser, 'ca_meta_migrator');
assert.ok(process.env.M6_DB_ROOT_PASSWORD, 'the M6.03 harness provides only a synthetic disposable root secret');

const stagedSchemaVersion = 22;
const before = await readMigrationStatus(environment);
assert.deepEqual(before.migrations, [], 'M6.03 Compose starts with an empty schema');
await deployMigrations(environment, MIGRATIONS.filter((migration) => migration.schemaVersion < stagedSchemaVersion));
await assert.rejects(
  deployMigrations(environment, MIGRATIONS.filter((migration) => migration.schemaVersion <= stagedSchemaVersion)),
  (error) => error instanceof CoexistenceLockDeleteGrantRequiredError,
  'the disposable migration pauses before creating the v22 trigger',
);

const root = await createConnection({
  host: environment.database.host,
  port: environment.database.port,
  database: databaseName,
  user: 'root',
  password: process.env.M6_DB_ROOT_PASSWORD,
  connectTimeout: environment.database.connectTimeoutMs,
  multipleStatements: false,
  dateStrings: true,
  charset: 'utf8mb4',
});
try {
  const [context] = await root.query(
    'SELECT DATABASE() AS database_name, SUBSTRING_INDEX(CURRENT_USER(), \'@\', 1) AS database_account',
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
process.stdout.write(`Disposable M6.03 schema prepared through v${MIGRATIONS.at(-1)?.schemaVersion}.\n`);
