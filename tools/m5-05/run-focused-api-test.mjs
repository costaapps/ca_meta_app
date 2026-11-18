import { mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`M5.05 validation requires the repository's Node 24 runtime; received ${process.version}.`);
}

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this focused harness through the npm workspace script.');
const apiRoot = join(repositoryRoot, 'apps', 'api');
const compiler = join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const outputRoot = join(apiRoot, '.test-runs');
const temporaryOutput = join(outputRoot, `m5-05-${process.pid}-${Date.now()}`);
const safePrefix = `${resolve(outputRoot)}${sep}`;

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
  process.stdout.write(`M5.05 focused API + CORS regression tests — Node ${process.version}\n`);

  if (!run([compiler, '--project', join(apiRoot, 'tsconfig.build.json'), '--pretty', 'false'])) {
    process.exitCode = 1;
  } else {
    if (process.env.M5_05_AUTOMATION_TEST === '1' &&
        !run([join(apiRoot, 'dist', 'database', 'migrations', 'cli.js'), 'deploy'])) {
      process.exitCode = 1;
    }

    if (process.exitCode !== 1 && !run([
      join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--project', join(apiRoot, 'tsconfig.test.json'),
      '--outDir', temporaryOutput,
      '--pretty', 'false',
    ])) {
      process.exitCode = 1;
    }

    if (process.exitCode !== 1 && !run([
      '--test', '--test-concurrency=1',
      join(temporaryOutput, 'test', 'm5-05-automation-config.spec.js'),
      join(temporaryOutput, 'test', 'm5-05-automation-config.integration.spec.js'),
      join(temporaryOutput, 'test', 'm3-04-session.spec.js'),
    ])) {
      process.exitCode = 1;
    }
  }
} finally {
  const resolvedOutput = resolve(temporaryOutput);
  if (!resolvedOutput.startsWith(safePrefix) || !resolvedOutput.includes(`${sep}m5-05-`)) {
    throw new Error('M5.05 harness refused to remove an output directory outside its private workspace.');
  }
  await rm(resolvedOutput, { recursive: true, force: true });
}
