import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const apiRoot = join(repositoryRoot, 'apps', 'api');
const outputRoot = join(apiRoot, '.test-runs');
const temporaryOutput = join(outputRoot, `m5-09-${process.pid}-${Date.now()}`);
const databaseEnabled = process.argv.includes('--database');

if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`M5.09 focused validation requires Node 24; received ${process.version}.`);
}
if (!process.env.npm_execpath) throw new Error('Run this focused harness through the @ca-meta/api npm workspace script.');

const compiler = join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const buildOutput = join(temporaryOutput, 'build');
const testOutput = join(temporaryOutput, 'test');
const apiRequire = createRequire(join(apiRoot, 'package.json'));
const { createConnection } = apiRequire('mysql2/promise');
const fixturePath = join(repositoryRoot, 'tools', 'm5-09', 'fixtures', 'synthetic-migration-inventory.json');

function run(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    windowsHide: true,
    env: options.env ?? process.env,
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

function sqlIdentifier(value) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(value)) throw new Error('Refusing an invalid temporary SQL identifier.');
  return `\`${value}\``;
}

function sqlAccount(value) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(value)) throw new Error('Refusing an invalid temporary SQL account.');
  return `'${value}'@'%'`;
}

async function runDisposableMariaDb(buildCli) {
  const host = process.env.M5_09_DB_HOST ?? '127.0.0.1';
  const port = Number(process.env.M5_09_DB_PORT ?? '13307');
  const rootUser = process.env.M5_09_DB_ROOT_USER ?? 'root';
  const rootPassword = process.env.M5_09_DB_ROOT_PASSWORD;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !rootPassword) {
    throw new Error('M5.09 MariaDB test requires a loopback host, valid port, and M5_09_DB_ROOT_PASSWORD from the local test environment.');
  }

  const suffix = randomBytes(8).toString('hex');
  const schema = `m5_09_${suffix}`;
  const migrationUser = `m5_09_m_${suffix}`;
  const apiUser = `m5_09_a_${suffix}`;
  const migrationPassword = randomBytes(48).toString('base64url');
  const apiPassword = randomBytes(48).toString('base64url');
  let admin;
  let schemaCreated = false;
  let migrationUserCreated = false;
  let apiUserCreated = false;
  try {
    admin = await createConnection({ host, port, user: rootUser, password: rootPassword, connectTimeout: 5000, timezone: 'Z' });
    const [serverRows] = await admin.query('SELECT VERSION() AS version');
    const serverVersion = String(serverRows[0]?.version ?? '');
    assert.match(serverVersion, /MariaDB/i, 'M5.09 migration integration requires MariaDB');

    await admin.query(`CREATE DATABASE ${sqlIdentifier(schema)} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    schemaCreated = true;
    await admin.query(`CREATE USER ${sqlAccount(migrationUser)} IDENTIFIED BY ${admin.escape(migrationPassword)}`);
    migrationUserCreated = true;
    await admin.query(`GRANT SELECT, INSERT, UPDATE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER ON ${sqlIdentifier(schema)}.* TO ${sqlAccount(migrationUser)}`);
    await admin.query(`CREATE USER ${sqlAccount(apiUser)} IDENTIFIED BY ${admin.escape(apiPassword)}`);
    apiUserCreated = true;
    await admin.query(`GRANT SELECT, INSERT, UPDATE ON ${sqlIdentifier(schema)}.* TO ${sqlAccount(apiUser)}`);

    const migrationEnvironment = {
      ...process.env,
      API_DATABASE_USER: apiUser,
      MIGRATION_DATABASE_HOST: host,
      MIGRATION_DATABASE_PORT: String(port),
      MIGRATION_DATABASE_NAME: schema,
      MIGRATION_DATABASE_USER: migrationUser,
      MIGRATION_DATABASE_PASSWORD: migrationPassword,
      MIGRATION_DATABASE_CONNECT_TIMEOUT_MS: '5000',
      MIGRATION_LOCK_TIMEOUT_SECONDS: '20',
      MIGRATION_STATEMENT_TIMEOUT_SECONDS: '120',
      MIGRATION_MIN_SUPPORTED_API_VERSION: '1',
    };
    if (!run([buildCli, 'deploy'], { env: migrationEnvironment })) {
      throw new Error('Disposable M5.09 MariaDB migration deploy failed.');
    }

    const integrationEnvironment = {
      ...migrationEnvironment,
      M5_09_TEST: '1',
      API_DATABASE_HOST: host,
      API_DATABASE_PORT: String(port),
      API_DATABASE_NAME: schema,
      API_DATABASE_USER: apiUser,
      API_DATABASE_PASSWORD: apiPassword,
      API_DATABASE_CONNECT_TIMEOUT_MS: '5000',
    };
    if (!run([
      '--test', '--test-concurrency=1',
      join(testOutput, 'test', 'm5-09-migration-execution.integration.spec.js'),
    ], { env: integrationEnvironment })) {
      throw new Error('Disposable M5.09 MariaDB integration failed.');
    }
    process.stdout.write(`M5.09 MariaDB ${serverVersion}: isolated migration v26, manifest resume, writer CAS, shadow-read flag and cohort rollback verified.\n`);
  } finally {
    const cleanupErrors = [];
    if (admin && apiUserCreated) {
      try { await admin.query(`DROP USER IF EXISTS ${sqlAccount(apiUser)}`); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (admin && migrationUserCreated) {
      try { await admin.query(`DROP USER IF EXISTS ${sqlAccount(migrationUser)}`); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (admin && schemaCreated) {
      try { await admin.query(`DROP DATABASE IF EXISTS ${sqlIdentifier(schema)}`); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (admin && apiUserCreated) {
      try {
        const [rows] = await admin.query('SELECT User FROM mysql.user WHERE User = ? AND Host = ?', [apiUser, '%']);
        if (rows.length !== 0) cleanupErrors.push(new Error('M5.09 temporary API account remained after cleanup.'));
      } catch (error) { cleanupErrors.push(error); }
    }
    if (admin && migrationUserCreated) {
      try {
        const [rows] = await admin.query('SELECT User FROM mysql.user WHERE User = ? AND Host = ?', [migrationUser, '%']);
        if (rows.length !== 0) cleanupErrors.push(new Error('M5.09 temporary migration account remained after cleanup.'));
      } catch (error) { cleanupErrors.push(error); }
    }
    if (admin && schemaCreated) {
      try {
        const [rows] = await admin.query('SELECT SCHEMA_NAME FROM information_schema.schemata WHERE SCHEMA_NAME = ?', [schema]);
        if (rows.length !== 0) cleanupErrors.push(new Error('M5.09 temporary schema remained after cleanup.'));
      } catch (error) { cleanupErrors.push(error); }
    }
    if (admin) {
      try { await admin.end(); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'M5.09 temporary MariaDB cleanup failed.');
  }
}

let temporaryOutputCreated = false;
try {
  await mkdir(outputRoot, { recursive: true });
  const outputInfo = await lstat(outputRoot);
  const [realRepositoryRoot, realApiRoot, realOutputRoot] = await Promise.all([
    realpath(repositoryRoot), realpath(apiRoot), realpath(outputRoot),
  ]);
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink() ||
      realApiRoot !== join(realRepositoryRoot, 'apps', 'api') ||
      realOutputRoot !== join(realApiRoot, '.test-runs')) {
    throw new Error('M5.09 harness refused a test-output path that resolves outside its API workspace.');
  }
  await mkdir(temporaryOutput, { recursive: false });
  temporaryOutputCreated = true;
  await mkdir(buildOutput, { recursive: false });
  await mkdir(testOutput, { recursive: false });
  process.stdout.write(`M5.09 focused API checks — Node ${process.version}; disposable MariaDB ${databaseEnabled ? 'enabled' : 'skipped'}\n`);
  if (!run([compiler, '--project', join(apiRoot, 'tsconfig.build.json'), '--outDir', buildOutput, '--pretty', 'false'])) {
    process.exitCode = 1;
  } else if (!run([compiler, '--project', join(apiRoot, 'tsconfig.test.json'), '--outDir', testOutput, '--pretty', 'false'])) {
    process.exitCode = 1;
  } else {
    const unitEnvironment = {
      ...process.env,
      M5_09_FIXTURE_PATH: fixturePath,
    };
    if (!run([
      '--test', '--test-concurrency=1',
      join(testOutput, 'test', 'm5-09-migration-execution.spec.js'),
      join(testOutput, 'test', 'm5-09-migration-execution.integration.spec.js'),
    ], { env: unitEnvironment })) {
      process.exitCode = 1;
    } else if (databaseEnabled) {
      await runDisposableMariaDb(join(buildOutput, 'database', 'migrations', 'cli.js'));
    }
  }
} finally {
  if (temporaryOutputCreated) {
    const outputInfo = await lstat(outputRoot);
    const temporaryInfo = await lstat(temporaryOutput);
    const [realApiRoot, realOutputRoot, realTemporaryOutput] = await Promise.all([
      realpath(apiRoot), realpath(outputRoot), realpath(temporaryOutput),
    ]);
    if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink() ||
        !temporaryInfo.isDirectory() || temporaryInfo.isSymbolicLink() ||
        realOutputRoot !== join(realApiRoot, '.test-runs') ||
        dirname(realTemporaryOutput) !== realOutputRoot ||
        basename(realTemporaryOutput) !== basename(temporaryOutput) ||
        !basename(realTemporaryOutput).startsWith('m5-09-')) {
      throw new Error('M5.09 harness refused to remove an output directory outside its private workspace.');
    }
    await rm(realTemporaryOutput, { recursive: true, force: true });
  }
}
