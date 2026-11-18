import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`M5.10 API typecheck requires the repository's Node 24 runtime; received ${process.version}.`);
}
if (!process.env.npm_execpath) throw new Error('Run this typecheck through the npm workspace script.');

const apiRoot = join(repositoryRoot, 'apps', 'api');
const compiler = join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const outputRoot = join(repositoryRoot, 'tmp', 'm5-10-typecheck-runs');
const temporaryRoot = join(outputRoot, `m5-10-typecheck-${process.pid}-${Date.now()}`);
const safePrefix = `${resolve(outputRoot)}${sep}`;
const localContracts = join(repositoryRoot, 'packages', 'contracts', 'src');
const contractsPaths = {
  '@ca-meta/contracts': [join(localContracts, 'index.d.ts')],
  '@ca-meta/contracts/runtime': [join(localContracts, 'runtime.d.ts')],
};

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
  process.stdout.write(`M5.10 API typecheck — Node ${process.version}; build and test project configs\n`);
  for (const [name, config] of [['build', 'tsconfig.build.json'], ['test', 'tsconfig.test.json']]) {
    const path = join(temporaryRoot, `tsconfig.${name}.json`);
    await writeFile(path, JSON.stringify({
      extends: join(apiRoot, config),
      compilerOptions: { noEmit: true, paths: contractsPaths },
    }, null, 2), 'utf8');
    if (!run([compiler, '--project', path, '--pretty', 'false'])) {
      process.exitCode = 1;
      break;
    }
  }
} finally {
  const resolvedOutput = resolve(temporaryRoot);
  if (!resolvedOutput.startsWith(safePrefix) || !resolvedOutput.includes(`${sep}m5-10-typecheck-`)) {
    throw new Error('M5.10 API typecheck refused to remove an output directory outside its private workspace.');
  }
  await rm(resolvedOutput, { recursive: true, force: true });
}
