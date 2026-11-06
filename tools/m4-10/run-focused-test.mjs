import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const apiRoot = path.join(repositoryRoot, 'apps', 'api');
const tempRoot = mkdtempSync(path.join(apiRoot, '.m4-10-test-'));
const outputRoot = path.join(tempRoot, 'dist-test');
const compiler = path.join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const runner = path.join(outputRoot, 'test', 'm4-10-meta-webhooks.spec.js');

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: repositoryRoot, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed with status ${result.status ?? 'unknown'}.`);
}

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 15) throw new Error('M4.10 harness requires Node 24.15 or newer in the Node 24 line.');
  run([compiler, '-p', path.join(apiRoot, 'tsconfig.test.json'), '--outDir', outputRoot]);
  run(['--test', runner]);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'M4.10 focused test failed.'}\n`);
  process.exitCode = 1;
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
