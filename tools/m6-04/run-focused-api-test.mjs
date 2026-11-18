import { mkdir, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`M6.04 focused API test requires Node 24; received ${process.version}.`);
}
const apiRoot = join(repositoryRoot, 'apps', 'api');
const compiler = join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const outputRoot = join(apiRoot, '.test-runs');
const temporaryOutput = join(outputRoot, `m6-04-${process.pid}-${Date.now()}`);
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
  for (const dashboard of ['service.json', 'flows.json', 'migration.json']) {
    JSON.parse(await readFile(join(repositoryRoot, 'tools', 'm6-04', 'dashboards', dashboard), 'utf8'));
  }
  await mkdir(outputRoot, { recursive: true });
  await mkdir(temporaryOutput, { recursive: false });
  process.stdout.write(`M6.04 focused API test — Node ${process.version}; one synthetic observability scenario\n`);
  if (!run([compiler, '--project', join(apiRoot, 'tsconfig.test.json'), '--outDir', temporaryOutput, '--pretty', 'false'])) {
    process.exitCode = 1;
  } else if (!run(['--test', join(temporaryOutput, 'test', 'm6-04-observability.spec.js')])) {
    process.exitCode = 1;
  }
} finally {
  const resolvedOutput = resolve(temporaryOutput);
  if (!resolvedOutput.startsWith(safePrefix) || !resolvedOutput.includes(`${sep}m6-04-`)) {
    throw new Error('M6.04 focused API harness refused to remove an output directory outside its private workspace.');
  }
  await rm(resolvedOutput, { recursive: true, force: true });
}
