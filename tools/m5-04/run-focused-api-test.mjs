import { mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`M5.04 focused API validation requires Node 24; received ${process.version}.`);
}
const apiRoot = join(repositoryRoot, 'apps', 'api');
const compiler = join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const project = join(apiRoot, 'tsconfig.m5-04-test.json');
const outputRoot = join(apiRoot, '.test-runs');
await mkdir(outputRoot, { recursive: true });
const temporaryOutput = join(outputRoot, `m5-04-${process.pid}-${Date.now()}`);
await mkdir(temporaryOutput, { recursive: false });
const safePrefix = `${resolve(outputRoot)}${sep}`;

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: repositoryRoot, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  return result.status === 0;
}

try {
  process.stdout.write(`M5.04 synthetic WhatsApp BODY template tests — Node ${process.version}\n`);
  if (!run([compiler, '--project', project, '--outDir', temporaryOutput, '--pretty', 'false'])) {
    process.exitCode = 1;
  } else if (!run(['--test', '--test-concurrency=1', join(temporaryOutput, 'test', 'm5-04-whatsapp-templates.spec.js')])) {
    process.exitCode = 1;
  }
} finally {
  const resolvedOutput = resolve(temporaryOutput);
  if (!resolvedOutput.startsWith(safePrefix) || !resolvedOutput.includes(`${sep}m5-04-`)) {
    throw new Error('M5.04 harness refused to remove an output directory outside its private workspace.');
  }
  await rm(resolvedOutput, { recursive: true, force: true });
}
