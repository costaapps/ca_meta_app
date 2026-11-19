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
assert.equal(databaseName, 'ca_meta_m605', 'M6.05 migration setup only targets its disposable source schema');
assert.equal(environment.database.host, '127.0.0.1', 'M6.05 MariaDB must be reached over loopback');
assert.equal(environment.database.user, 'ca_meta_migrator');
assert.ok(process.env.M6_05_DB_ROOT_PASSWORD, 'M6.05 provides only a synthetic disposable root secret');

const before = await readMigrationStatus(environment);
assert.deepEqual(before.migrations, [], 'M6.05 Compose starts with an empty source schema');
const stagedSchemaVersion = 22;
await deployMigrations(environment, MIGRATIONS.filter((migration) => migration.schemaVersion < stagedSchemaVersion));
await assert.rejects(
  deployMigrations(environment, MIGRATIONS.filter((migration) => migration.schemaVersion <= stagedSchemaVersion)),
  (error) => error instanceof CoexistenceLockDeleteGrantRequiredError,
  'the disposable migration pauses before completing v22',
);

const root = await createConnection({
  host: environment.database.host,
  port: environment.database.port,
  database: databaseName,
  user: 'root',
  password: process.env.M6_05_DB_ROOT_PASSWORD,
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
    `GRANT DELETE ON \`${databaseName}\`.\`ca_meta_onboarding_coexistence_locks\` TO 'ca_meta_migrator'@'%'`,
  );
} finally {
  await root.end();
}

await deployMigrations(environment);
const status = await readMigrationStatus(environment);
assert.equal(status.migrations.length, MIGRATIONS.length);
assert.ok(status.migrations.every((migration) => migration.state === 'APPLIED' && migration.checksumMatches));
process.stdout.write(`Disposable M6.05 source schema prepared through v${MIGRATIONS.at(-1)?.schemaVersion}.\n`);
