import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const apiRoot = join(repositoryRoot, 'apps', 'api');
const compiler = join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const project = join(apiRoot, 'tsconfig.m4-04-test.json');
const temporaryRoot = join(apiRoot, '.test-runs');
await mkdir(temporaryRoot, { recursive: true });
const temporaryOutput = await mkdtemp(join(temporaryRoot, 'm4-04-'));
const safePrefix = `${resolve(temporaryRoot)}${sep}`;

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: repositoryRoot, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  return result.status === 0;
}

try {
  process.stdout.write(`M4.04 exclusive WhatsApp focused harness — Node ${process.version}\n`);
  if (!run([compiler, '--project', project, '--pretty', 'false', '--outDir', temporaryOutput])) {
    process.exitCode = 1;
  } else if (!run(['--test', '--test-concurrency=1',
    join(temporaryOutput, 'test', 'm4-04-whatsapp-exclusive.spec.js'),
    join(temporaryOutput, 'test', 'm4-02-meta-graph.spec.js'),
    join(temporaryOutput, 'test', 'm4-03-onboarding-saga.spec.js'),
    join(temporaryOutput, 'test', 'm3-05-onboarding-status.spec.js'),
    join(temporaryOutput, 'test', 'm3-05-onboarding-session.spec.js')])) {
    process.exitCode = 1;
  }
} finally {
  const resolvedOutput = resolve(temporaryOutput);
  if (!resolvedOutput.startsWith(safePrefix) || !resolvedOutput.includes(`${sep}m4-04-`)) {
    throw new Error('M4.04 harness refused to remove an output directory outside its private workspace.');
  }
  await rm(resolvedOutput, { recursive: true, force: true });
}
