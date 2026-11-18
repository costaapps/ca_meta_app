import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const apiRoot = join(repositoryRoot, 'apps', 'api');
const outputRoot = join(apiRoot, '.test-runs');
const temporaryRoot = join(outputRoot, `m6-02-${process.pid}-${Date.now()}`);
const testOutput = join(temporaryRoot, 'compiled');
const configPath = join(temporaryRoot, 'tsconfig.json');
const compiler = join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const safePrefix = `${resolve(outputRoot)}${sep}`;
const contractSource = join(repositoryRoot, 'packages', 'contracts', 'src');
const suites = [
  'm3-01-identity.spec.js',
  'm3-01-job-authorization.spec.js',
  'm3-02-preauth.spec.js',
  'm3-02-auth-exchange.spec.js',
  'm3-03-magic-link.spec.js',
  'm3-04-session.spec.js',
  'm3-05-onboarding-session.spec.js',
  'm3-06-meta-assets.spec.js',
  'm3-07-credential-vault.spec.js',
  'm3-08-credential-resolver.spec.js',
  'm3-09-credential-lifecycle.spec.js',
  'm3-10-privacy.spec.js',
  'm3-11-legacy-import.spec.js',
  'm3-12-asset-catalog.spec.js',
  'm4-02-meta-graph.spec.js',
  'm4-10-meta-webhooks.spec.js',
  'm4-11-meta-subscriptions.spec.js',
  'm4-12-asset-observation.spec.js',
  'm4-13-connection-lifecycle.spec.js',
  'm5-03-coexistence-conflict.spec.js',
  'm5-04-whatsapp-templates.spec.js',
  'm5-05-automation-config.spec.js',
  'm5-06-notification-action.spec.js',
  'm5-07-internal-operations.spec.js',
  'm5-08-projection.spec.js',
  'm5-09-migration-execution.spec.js',
  'm5-10-operations-diagnostics.spec.js',
  'api-boundaries.spec.js',
];

function run(args, label, env = process.env) {
  process.stdout.write(`\n> ${label}\n`);
  const result = spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    windowsHide: true,
    env,
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor !== 24 || nodeMinor < 15) {
  throw new Error(`M6.02 validation requires Node >=24.15.0 <25; received ${process.version}.`);
}

let created = false;
try {
  await mkdir(outputRoot, { recursive: true });
  const outputInfo = await lstat(outputRoot);
  const [realApiRoot, realOutputRoot] = await Promise.all([realpath(apiRoot), realpath(outputRoot)]);
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink() ||
      realOutputRoot !== join(realApiRoot, '.test-runs')) {
    throw new Error('M6.02 refused a test-output path outside apps/api/.test-runs.');
  }
  await mkdir(temporaryRoot, { recursive: false });
  created = true;
  await mkdir(testOutput, { recursive: false });
  await writeFile(configPath, JSON.stringify({
    extends: join(apiRoot, 'tsconfig.test.json'),
    compilerOptions: {
      outDir: testOutput,
      paths: {
        '@ca-meta/contracts': [join(contractSource, 'index.d.ts')],
        '@ca-meta/contracts/runtime': [join(contractSource, 'runtime.d.ts')],
      },
    },
  }, null, 2), 'utf8');

  process.stdout.write(`M6.02 adversarial API checks — Node ${process.version}; selected suites ${suites.length}\n`);
  const compiled = run([compiler, '--project', configPath, '--pretty', 'false'], 'compile API source and test types');
  if (!compiled) {
    process.exitCode = 1;
  } else if (!run(['--test', '--test-concurrency=1', ...suites.map((suite) => join(testOutput, 'test', suite))], 'run tenant/auth/vault/webhook/redaction suites', {
    ...process.env,
    M5_09_FIXTURE_PATH: join(repositoryRoot, 'tools', 'm5-09', 'fixtures', 'synthetic-migration-inventory.json'),
  })) {
    process.exitCode = 1;
  } else if (!run([join(repositoryRoot, 'tools', 'm6-02', 'security-surface-check.mjs')], 'inspect workflows and runtime image boundaries')) {
    process.exitCode = 1;
  }
} finally {
  if (created) {
    const outputInfo = await lstat(outputRoot);
    const temporaryInfo = await lstat(temporaryRoot);
    const [realApiRoot, realOutputRoot, realTemporaryRoot] = await Promise.all([
      realpath(apiRoot), realpath(outputRoot), realpath(temporaryRoot),
    ]);
    if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink() ||
        !temporaryInfo.isDirectory() || temporaryInfo.isSymbolicLink() ||
        realOutputRoot !== join(realApiRoot, '.test-runs') ||
        dirname(realTemporaryRoot) !== realOutputRoot ||
        !/^m6-02-\d+-\d+$/.test(realTemporaryRoot.split(sep).at(-1) ?? '')) {
      throw new Error('M6.02 refused to clean an output directory outside its private API test namespace.');
    }
    await rm(realTemporaryRoot, { recursive: true, force: true });
  }
}
