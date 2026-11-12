import { mkdir, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`M5.03 validation requires Node 24; received ${process.version}.`);
}
const cli = join(repositoryRoot, 'node_modules', '@angular', 'cli', 'bin', 'ng.js');
const outputRoot = join(repositoryRoot, 'apps', 'web', '.test-runs');
await mkdir(outputRoot, { recursive: true });
const temporaryOutput = join(outputRoot, `m5-03-${process.pid}-${Date.now()}`);
await mkdir(temporaryOutput, { recursive: false });
const safePrefix = `${resolve(outputRoot)}${sep}`;

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: join(repositoryRoot, 'apps', 'web'),
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

try {
  process.stdout.write(`M5.03 focused Angular specs — Node ${process.version}\n`);
  const outputFile = join(temporaryOutput, 'web.junit.xml');
  const args = [
    'test', 'meta-integration', '--watch=false', `--output-file=${outputFile}`,
    '--include=src/app/core/onboarding/onboarding-session-store.spec.ts',
    '--include=src/app/core/onboarding/onboarding-tenant-identity.spec.ts',
    '--include=src/app/core/onboarding/portal-onboarding.service.spec.ts',
    '--include=src/app/features/portal/onboarding/portal-onboarding.component.spec.ts',
    '--include=src/app/app.routes.spec.ts',
  ];
  if (!run(args)) process.exitCode = 1;
  else {
    const report = await readFile(outputFile, 'utf8');
    const suites = [...report.matchAll(/<testsuite\b([^>]*)>/g)];
    const total = (attribute) => suites.reduce((sum, suite) => sum + Number(suite[1].match(new RegExp(`\\b${attribute}="(\\d+)"`))?.[1] ?? 0), 0);
    const tests = total('tests');
    const failures = total('failures') + total('errors');
    if (tests === 0 || failures !== 0) {
      process.stderr.write(`M5.03 Angular JUnit result: ${tests} test(s), ${failures} failure(s).\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`M5.03 Angular specs: ${tests} test(s), ${failures} failure(s).\n`);
    }
  }
} finally {
  const resolvedOutput = resolve(temporaryOutput);
  if (!resolvedOutput.startsWith(safePrefix) || !resolvedOutput.includes(`${sep}m5-03-`)) {
    throw new Error('M5.03 harness refused to remove an output directory outside its private workspace.');
  }
  await rm(resolvedOutput, { recursive: true, force: true });
}
