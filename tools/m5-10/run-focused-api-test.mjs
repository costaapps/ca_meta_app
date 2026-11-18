import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`M5.10 validation requires the repository's Node 24 runtime; received ${process.version}.`);
}
if (!process.env.npm_execpath) throw new Error('Run this focused harness through the npm workspace script.');

const apiRoot = join(repositoryRoot, 'apps', 'api');
const compiler = join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const outputRoot = join(repositoryRoot, 'tmp', 'm5-10-api-runs');
const temporaryRoot = join(outputRoot, `m5-10-${process.pid}-${Date.now()}`);
const testOutput = join(temporaryRoot, 'compiled');
const configPath = join(temporaryRoot, 'tsconfig.json');
const safePrefix = `${resolve(outputRoot)}${sep}`;
const localContracts = join(repositoryRoot, 'packages', 'contracts', 'src');

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
  await mkdir(temporaryRoot, { recursive: false });
  await mkdir(testOutput, { recursive: false });
  await writeFile(configPath, JSON.stringify({
    extends: join(apiRoot, 'tsconfig.test.json'),
    compilerOptions: {
      outDir: testOutput,
      paths: {
        '@ca-meta/contracts': [join(localContracts, 'index.d.ts')],
        '@ca-meta/contracts/runtime': [join(localContracts, 'runtime.d.ts')],
      },
    },
  }, null, 2), 'utf8');
  process.stdout.write(`M5.10 focused API tests — Node ${process.version}; local contract types mapped from this checkout\n`);

  if (run([compiler, '--project', configPath, '--pretty', 'false'])) {
    if (!run(['--test', '--test-concurrency=1', join(testOutput, 'test', 'm5-10-operations-diagnostics.spec.js')])) {
      process.exitCode = 1;
    }
  } else {
    process.exitCode = 1;
  }
} finally {
  const resolvedOutput = resolve(temporaryRoot);
  if (!resolvedOutput.startsWith(safePrefix) || !resolvedOutput.includes(`${sep}m5-10-`)) {
    throw new Error('M5.10 harness refused to remove an output directory outside its private workspace.');
  }
  await rm(resolvedOutput, { recursive: true, force: true });
}
