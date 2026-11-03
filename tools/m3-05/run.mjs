import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const apiRoot = join(repositoryRoot, 'apps', 'api');
const workRoot = mkdtempSync(join(apiRoot, '.m3-05-validate-'));
const apiOutput = join(workRoot, 'api-test');
const onboardingOnly = process.argv.includes('--onboarding-only');

function run(label, executable, args, options = {}) {
  console.log(`\n[M3.05] ${label}`);
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: process.env,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

try {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 24) throw new Error(`Node 24 is required; current runtime is ${process.versions.node}`);
  const tsc = join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  const vitest = join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs');
  const ngc = join(repositoryRoot, 'node_modules', '@angular', 'compiler-cli', 'bundles', 'src', 'bin', 'ngc.js');
  const requiredTools = onboardingOnly ? [tsc] : [tsc, vitest, ngc];
  for (const path of requiredTools) {
    try {
      realpathSync(path);
    } catch {
      throw new Error(`Dependencies are missing. Run npm ci first; expected ${path}`);
    }
  }

  run('API focused TypeScript compilation', process.execPath, [
    tsc,
    '-p', join(apiRoot, 'tsconfig.m3-05.test.json'),
    '--outDir', apiOutput,
  ]);
  run('API embed/pre-auth focused tests', process.execPath, [
    '--test',
    join(apiOutput, 'test', 'm3-02-preauth.spec.js'),
    join(apiOutput, 'test', 'm3-05-embed-config.spec.js'),
    join(apiOutput, 'test', 'm3-05-onboarding-status.spec.js'),
    join(apiOutput, 'test', 'm3-05-onboarding-session.spec.js'),
  ]);
  run('API session mode and migration focused tests', process.execPath, [
    '--test',
    join(apiOutput, 'test', 'm3-04-session.spec.js'),
    join(apiOutput, 'test', 'migration-unit.spec.js'),
  ]);
  if (!onboardingOnly) {
    run('Safe Nginx access-log regression test', process.execPath, [
      '--test',
      join(repositoryRoot, 'tools', 'm3-05', 'nginx-log.test.mjs'),
    ]);
    run('Web entrypoint origin-validation regression test', process.execPath, [
      '--test',
      join(repositoryRoot, 'tools', 'm3-05', 'web-entrypoint.test.mjs'),
    ]);
    run('Angular application typecheck', process.execPath, [
      ngc, '-p', join(repositoryRoot, 'apps', 'web', 'tsconfig.app.json'), '--noEmit',
    ]);
    run('Web embed/config focused tests', process.execPath, [
      vitest, 'run', '--root', join(repositoryRoot, 'apps', 'web'),
      'src/app/core/config/public-runtime-config.spec.ts',
      'src/app/core/embed/embed-contract.spec.ts',
      'src/app/core/embed/embed-bridge.service.spec.ts',
    ]);
  }
  console.log(onboardingOnly
    ? '\n[M3.05] onboarding state, status, config and migration checks passed'
    : '\n[M3.05] focused checks passed');
} finally {
  const canonicalApiRoot = realpathSync(apiRoot);
  const canonicalWorkRoot = realpathSync(workRoot);
  const relativeWorkRoot = relative(canonicalApiRoot, canonicalWorkRoot);
  if (!relativeWorkRoot || relativeWorkRoot === '..' || relativeWorkRoot.startsWith(`..${sep}`) ||
      resolve(canonicalApiRoot, relativeWorkRoot) !== canonicalWorkRoot ||
      !relativeWorkRoot.startsWith('.m3-05-validate-')) {
    throw new Error('Refusing cleanup because focused-test temporary path escaped apps/api');
  }
  rmSync(canonicalWorkRoot, { recursive: true, force: true });
}
