import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const api = join(root, 'apps', 'api');
const apiDist = resolve(api, 'dist');
if (!apiDist.startsWith(`${root}${sep}`)) throw new Error('Refusing to use an API build outside the repository.');
if (!process.env.M5_07_API_DIST || resolve(process.env.M5_07_API_DIST) !== apiDist) {
  throw new Error('Run this check through the focused M5.07 runner so the isolated API build is available.');
}
const host = process.env.M5_07_DB_HOST ?? '127.0.0.1';
const port = Number(process.env.M5_07_DB_PORT ?? '13307');
const rootUser = process.env.M5_07_DB_ROOT_USER ?? 'root';
const rootPassword = process.env.M5_07_DB_ROOT_PASSWORD;
if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !rootPassword) {
  throw new Error('M5.07 migration test requires a loopback MariaDB host, a valid port, and a root password supplied through the environment.');
}

const apiRequire = createRequire(join(api, 'package.json'));
const { createConnection } = apiRequire('mysql2/promise');
const suffix = randomBytes(8).toString('hex');
const schema = `m5_07_${suffix}`;
const migrationUser = `m5_07_${suffix}`;
const migrationPassword = randomBytes(48).toString('base64url');
const sqlIdentifier = (value) => {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(value)) throw new Error('Refusing an invalid temporary SQL identifier.');
  return `\`${value}\``;
};
const sqlAccount = (user) => {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(user)) throw new Error('Refusing an invalid temporary SQL account.');
  return `'${user}'@'%'`;
};

let admin;
let schemaCreated = false;
let userCreated = false;
try {
  admin = await createConnection({ host, port, user: rootUser, password: rootPassword, connectTimeout: 5000, timezone: 'Z' });
  const [serverRows] = await admin.query('SELECT VERSION() AS version');
  const serverVersion = String(serverRows[0]?.version ?? '');
  assert.match(serverVersion, /MariaDB/i, 'migration validation must use MariaDB');

  await admin.query(`CREATE DATABASE ${sqlIdentifier(schema)} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  schemaCreated = true;
  await admin.query(`CREATE USER ${sqlAccount(migrationUser)} IDENTIFIED BY ${admin.escape(migrationPassword)}`);
  userCreated = true;
  await admin.query(`GRANT SELECT, INSERT, UPDATE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER ON ${sqlIdentifier(schema)}.* TO ${sqlAccount(migrationUser)}`);

  const migrationEnvironment = {
    ...process.env,
    API_DATABASE_USER: 'm5_07_api_runtime',
    MIGRATION_DATABASE_HOST: host,
    MIGRATION_DATABASE_PORT: String(port),
    MIGRATION_DATABASE_NAME: schema,
    MIGRATION_DATABASE_USER: migrationUser,
    MIGRATION_DATABASE_PASSWORD: migrationPassword,
    MIGRATION_DATABASE_CONNECT_TIMEOUT_MS: '5000',
    MIGRATION_LOCK_TIMEOUT_SECONDS: '15',
    MIGRATION_STATEMENT_TIMEOUT_SECONDS: '120',
    MIGRATION_MIN_SUPPORTED_API_VERSION: '1',
  };
  const deploy = spawnSync(process.execPath, [join(apiDist, 'database', 'migrations', 'cli.js'), 'deploy'], {
    cwd: root,
    env: migrationEnvironment,
    stdio: 'inherit',
  });
  if (deploy.error) throw deploy.error;
  if (deploy.status !== 0) throw new Error(`Disposable MariaDB migration deploy failed with exit ${deploy.status ?? 'signal'}.`);

  const [migrationRows] = await admin.query(
    `SELECT schema_version, state FROM ${sqlIdentifier(schema)}.ca_meta_schema_migrations
     WHERE migration_id = ?`,
    ['202611110021-internal-asset-operations'],
  );
  assert.equal(Number(migrationRows[0]?.schema_version), 21);
  assert.equal(migrationRows[0]?.state, 'APPLIED');

  const [columnRows] = await admin.query(
    `SELECT column_name AS name FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'ca_meta_internal_asset_operations' ORDER BY ordinal_position`,
    [schema],
  );
  assert.deepEqual(columnRows.map((row) => row.name), [
    'id', 'tenant_id', 'service_principal_id', 'asset_id', 'operation', 'idempotency_key_hash',
    'request_hash', 'status', 'safe_reason_code', 'provider_reference_hash', 'created_at', 'updated_at',
  ]);

  const [indexRows] = await admin.query(
    `SELECT index_name AS name, column_name AS columnName, non_unique AS nonUnique
     FROM information_schema.statistics WHERE table_schema = ? AND table_name = 'ca_meta_internal_asset_operations'
     ORDER BY index_name, seq_in_index`,
    [schema],
  );
  const indexes = new Map();
  for (const row of indexRows) {
    const found = indexes.get(row.name) ?? { unique: Number(row.nonUnique) === 0, columns: [] };
    found.columns.push(row.columnName);
    indexes.set(row.name, found);
  }
  assert.deepEqual(indexes.get('uq_ca_meta_internal_asset_operation_idem'), {
    unique: true,
    columns: ['tenant_id', 'service_principal_id', 'asset_id', 'operation', 'idempotency_key_hash'],
  });
  assert.equal(indexes.size, 5);
  process.stdout.write(`MariaDB ${serverVersion}: migration schema 21 and operation-ledger columns/indexes verified.\n`);
} finally {
  const cleanupErrors = [];
  if (admin && userCreated) {
    try { await admin.query(`DROP USER IF EXISTS ${sqlAccount(migrationUser)}`); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (admin && schemaCreated) {
    try { await admin.query(`DROP DATABASE IF EXISTS ${sqlIdentifier(schema)}`); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (admin && userCreated) {
    try {
      const [rows] = await admin.query('SELECT User FROM mysql.user WHERE User = ? AND Host = ?', [migrationUser, '%']);
      if (rows.length !== 0) cleanupErrors.push(new Error('M5.07 temporary migration user still exists after cleanup.'));
    } catch (error) { cleanupErrors.push(error); }
  }
  if (admin && schemaCreated) {
    try {
      const [rows] = await admin.query('SELECT SCHEMA_NAME FROM information_schema.schemata WHERE SCHEMA_NAME = ?', [schema]);
      if (rows.length !== 0) cleanupErrors.push(new Error('M5.07 temporary schema still exists after cleanup.'));
    } catch (error) { cleanupErrors.push(error); }
  }
  if (admin) {
    try { await admin.end(); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'M5.07 temporary MariaDB cleanup failed.');
}
