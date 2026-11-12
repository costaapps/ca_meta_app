import { mkdir, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`M5.10 web tests require the repository's Node 24 runtime; received ${process.version}.`);
}
if (!process.env.npm_execpath) throw new Error('Run this focused test through the npm workspace script.');

const cli = join(repositoryRoot, 'node_modules', '@angular', 'cli', 'bin', 'ng.js');
const outputRoot = join(repositoryRoot, 'apps', 'web', '.test-runs');
const temporaryOutput = join(outputRoot, `m5-10-${process.pid}-${Date.now()}`);
await mkdir(outputRoot, { recursive: true });
await mkdir(temporaryOutput, { recursive: false });
const safePrefix = `${resolve(outputRoot)}${sep}`;

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: join(repositoryRoot, 'apps', 'web'),
    stdio: 'inherit',
    windowsHide: true,
    env: process.env,
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

try {
  process.stdout.write(`M5.10 focused Angular component test — Node ${process.version}\n`);
  const outputFile = join(temporaryOutput, 'web.junit.xml');
  const args = [
    'test', 'meta-integration', '--watch=false', `--output-file=${outputFile}`,
    '--include=src/app/features/portal/operations-diagnostics.component.spec.ts',
  ];
  if (!run(args)) process.exitCode = 1;
  else {
    const report = await readFile(outputFile, 'utf8');
    const suites = [...report.matchAll(/<testsuite\b([^>]*)>/g)];
    const total = (attribute) => suites.reduce((sum, suite) => sum + Number(suite[1].match(new RegExp(`\\b${attribute}="(\\d+)"`))?.[1] ?? 0), 0);
    const tests = total('tests');
    const failures = total('failures') + total('errors');
    if (tests === 0 || failures !== 0) {
      process.stderr.write(`M5.10 Angular JUnit result: ${tests} test(s), ${failures} failure(s).\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`M5.10 Angular component: ${tests} test(s), ${failures} failure(s).\n`);
    }
  }
} finally {
  const resolvedOutput = resolve(temporaryOutput);
  if (!resolvedOutput.startsWith(safePrefix) || !resolvedOutput.includes(`${sep}m5-10-`)) {
    throw new Error('M5.10 web test harness refused to remove an output directory outside its private workspace.');
  }
  await rm(resolvedOutput, { recursive: true, force: true });
}
