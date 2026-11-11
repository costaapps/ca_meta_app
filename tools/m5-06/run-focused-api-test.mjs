import { mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`M5.06 focused API validation requires Node 24; received ${process.version}.`);
}
if (!process.env.npm_execpath) throw new Error('Run this focused harness through the npm workspace script.');

const apiRoot = join(root, 'apps', 'api');
const outputRoot = join(apiRoot, '.test-runs');
const output = join(outputRoot, `m5-06-${process.pid}-${Date.now()}`);
const safePrefix = `${resolve(outputRoot)}${sep}`;
const compiler = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true, env: process.env });
  if (result.error) throw result.error;
  return result.status === 0;
}

try {
  await mkdir(outputRoot, { recursive: true });
  await mkdir(output, { recursive: false });
  process.stdout.write(`M5.06 focused API integration — Node ${process.version}\n`);

  if (!run([compiler, '--project', join(apiRoot, 'tsconfig.build.json'), '--pretty', 'false'])) process.exitCode = 1;
  if (process.exitCode !== 1 && !run([compiler, '--project', join(apiRoot, 'tsconfig.m5-06.json'), '--outDir', output, '--pretty', 'false'])) process.exitCode = 1;
  if (process.exitCode !== 1 && process.env.M5_06_NOTIFICATION_TEST === '1' && process.env.M5_06_MIGRATE === '1') {
    if (!run([compiler, '--project', join(apiRoot, 'tsconfig.build.json'), '--pretty', 'false', '--outDir', join(apiRoot, 'dist')]) ||
        !run([join(apiRoot, 'dist', 'database', 'migrations', 'cli.js'), 'deploy'])) process.exitCode = 1;
  }
  if (process.exitCode !== 1) {
    if (!run(['--test', '--test-concurrency=1', join(output, 'test', 'm5-06-notifications.integration.spec.js'),
      join(output, 'test', 'm5-06-notification-action.spec.js')])) process.exitCode = 1;
  }
} finally {
  const resolvedOutput = resolve(output);
  if (!resolvedOutput.startsWith(safePrefix) || !resolvedOutput.includes(`${sep}m5-06-`)) {
    throw new Error('M5.06 API harness refused to remove output outside its private directory.');
  }
  await rm(resolvedOutput, { recursive: true, force: true });
}
