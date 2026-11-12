import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`M5.03 focused API validation requires Node 24; received ${process.version}.`);
}
const apiRoot = join(repositoryRoot, 'apps', 'api');
const compiler = join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const project = join(apiRoot, 'tsconfig.m5-03-test.json');
const temporaryRoot = join(apiRoot, '.test-runs');
await mkdir(temporaryRoot, { recursive: true });
const temporaryOutput = await mkdtemp(join(temporaryRoot, 'm5-03-'));
const safePrefix = `${resolve(temporaryRoot)}${sep}`;

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: repositoryRoot, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  return result.status === 0;
}

try {
  process.stdout.write(`M5.03 focused onboarding tests — Node ${process.version}; MariaDB ${process.env.M2_DURABLE_WORK_TEST === '1' ? 'enabled' : 'skipped'}\n`);
  if (!run([compiler, '--project', project, '--pretty', 'false', '--outDir', temporaryOutput])) {
    process.exitCode = 1;
  } else if (!run(['--test', '--test-concurrency=1', join(temporaryOutput, 'test', 'migration-unit.spec.js'),
    join(temporaryOutput, 'test', 'm5-03-coexistence-conflict.spec.js'),
    join(temporaryOutput, 'test', 'm5-03-coexistence-lock.integration.spec.js')])) {
    process.exitCode = 1;
  }
} finally {
  const resolvedOutput = resolve(temporaryOutput);
  if (!resolvedOutput.startsWith(safePrefix) || !resolvedOutput.includes(`${sep}m5-03-`)) {
    throw new Error('M5.03 harness refused to remove an output directory outside its private workspace.');
  }
  await rm(resolvedOutput, { recursive: true, force: true });
}
