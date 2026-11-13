import { readFile, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`M5.08 validation requires the repository's Node 24 runtime; received ${process.version}.`);
}

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this focused harness through the npm workspace script.');
const apiRoot = join(repositoryRoot, 'apps', 'api');
const compiler = join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const outputRoot = join(apiRoot, '.test-runs');
const temporaryOutput = join(outputRoot, `m5-08-${process.pid}-${Date.now()}`);
const safePrefix = `${resolve(outputRoot)}${sep}`;
const integrationEnabled = process.env.M5_08_PROJECTION_INTEGRATION === '1';
const environmentFile = process.env.M5_08_ENV_FILE;
const packageKeys = new Set([
  'M5_08_TEST_DB_HOST', 'M5_08_TEST_DB_PORT',
  'M5_08_CENTRAL_DATABASE_NAME', 'M5_08_CENTRAL_API_DATABASE_USER', 'M5_08_CENTRAL_API_DATABASE_PASSWORD',
  'M5_08_CENTRAL_MIGRATOR_DATABASE_USER', 'M5_08_CENTRAL_MIGRATOR_DATABASE_PASSWORD',
  'M5_08_DEST_A_DATABASE_NAME', 'M5_08_DEST_A_DATABASE_USER', 'M5_08_DEST_A_DATABASE_PASSWORD',
  'M5_08_DEST_B_DATABASE_NAME', 'M5_08_DEST_B_DATABASE_USER', 'M5_08_DEST_B_DATABASE_PASSWORD',
]);

if (environmentFile) {
  const content = await readFile(resolve(environmentFile), 'utf8');
  const seen = new Set();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equals = trimmed.indexOf('=');
    if (equals < 1) continue;
    const name = trimmed.slice(0, equals).trim();
    if (!packageKeys.has(name)) continue;
    if (seen.has(name)) throw new Error(`Duplicate M5.08 setting ${name} in the environment file.`);
    let value = trimmed.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[name] = value;
    seen.add(name);
  }
}

if (integrationEnabled) {
  for (const name of packageKeys) {
    if (!process.env[name]?.trim()) throw new Error(`MariaDB integration requires ${name}; set M5_08_ENV_FILE to the isolated test credential file.`);
  }
  const fixedIntegrationSettings = new Map([
    ['M5_08_TEST_DB_HOST', '127.0.0.1'],
    ['M5_08_TEST_DB_PORT', '13307'],
    ['M5_08_CENTRAL_DATABASE_NAME', 'ca_meta_m5_08_v25'],
    ['M5_08_DEST_A_DATABASE_NAME', 'ca_meta_m5_08_v25_dest_a'],
    ['M5_08_DEST_B_DATABASE_NAME', 'ca_meta_m5_08_v25_dest_b'],
  ]);
  for (const [name, expected] of fixedIntegrationSettings) {
    if (process.env[name] !== expected) {
      throw new Error(`MariaDB integration refuses to migrate because ${name} does not match the fixed disposable M5.08 v25 target.`);
    }
  }
  process.env.MIGRATION_DATABASE_HOST = process.env.M5_08_TEST_DB_HOST;
  process.env.MIGRATION_DATABASE_PORT = process.env.M5_08_TEST_DB_PORT;
  process.env.MIGRATION_DATABASE_NAME = process.env.M5_08_CENTRAL_DATABASE_NAME;
  process.env.MIGRATION_DATABASE_USER = process.env.M5_08_CENTRAL_MIGRATOR_DATABASE_USER;
  process.env.MIGRATION_DATABASE_PASSWORD = process.env.M5_08_CENTRAL_MIGRATOR_DATABASE_PASSWORD;
  process.env.MIGRATION_DATABASE_CONNECT_TIMEOUT_MS = '5000';
  process.env.MIGRATION_LOCK_TIMEOUT_SECONDS = '20';
  process.env.MIGRATION_STATEMENT_TIMEOUT_SECONDS = '120';
  process.env.MIGRATION_MIN_SUPPORTED_API_VERSION = '1';
  process.env.API_DATABASE_USER = process.env.M5_08_CENTRAL_API_DATABASE_USER;
}

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    windowsHide: true,
    env: process.env,
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

try {
  await mkdir(outputRoot, { recursive: true });
  await mkdir(temporaryOutput, { recursive: false });
  process.stdout.write(`M5.08 focused API tests — Node ${process.version}; MariaDB integration ${integrationEnabled ? 'enabled' : 'skipped'}\n`);

  if (!run([compiler, '--project', join(apiRoot, 'tsconfig.build.json'), '--pretty', 'false'])) {
    process.exitCode = 1;
  } else {
    if (integrationEnabled && !run([join(apiRoot, 'dist', 'database', 'migrations', 'cli.js'), 'deploy'])) {
      process.exitCode = 1;
    }
    if (process.exitCode !== 1 && !run([
      compiler, '--project', join(apiRoot, 'tsconfig.test.json'), '--outDir', temporaryOutput, '--pretty', 'false',
    ])) {
      process.exitCode = 1;
    }
    if (process.exitCode !== 1 && !run([
      '--test', '--test-concurrency=1',
      join(temporaryOutput, 'test', 'm5-08-projection.spec.js'),
      join(temporaryOutput, 'test', 'm5-08-projection.integration.spec.js'),
    ])) {
      process.exitCode = 1;
    }
  }
} finally {
  const resolvedOutput = resolve(temporaryOutput);
  if (!resolvedOutput.startsWith(safePrefix) || !resolvedOutput.includes(`${sep}m5-08-`)) {
    throw new Error('M5.08 harness refused to remove an output directory outside its private workspace.');
  }
  await rm(resolvedOutput, { recursive: true, force: true });
}
