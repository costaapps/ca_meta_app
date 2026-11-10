import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const compiler = join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const project = join(repositoryRoot, 'apps', 'api', 'tsconfig.m4-08-test.json');
const temporaryOutput = await mkdtemp(join(tmpdir(), 'ca-meta-m4-08-'));
const dependencyPath = [join(repositoryRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(delimiter);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: { ...process.env, NODE_PATH: dependencyPath },
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  return result.status === 0;
}

try {
  process.stdout.write(`M4.08 Facebook Pages + M4.11 contract checks — Node ${process.version}\n`);
  if (!run(process.execPath, [compiler, '--project', project, '--pretty', 'false', '--outDir', temporaryOutput])) {
    process.exitCode ||= 1;
  } else {
    run(process.execPath, ['--test',
      join(temporaryOutput, 'test', 'm4-08-facebook-pages.spec.js'),
      join(temporaryOutput, 'test', 'm4-11-meta-subscriptions.spec.js')]);
  }
} finally {
  await rm(temporaryOutput, { recursive: true, force: true });
}
