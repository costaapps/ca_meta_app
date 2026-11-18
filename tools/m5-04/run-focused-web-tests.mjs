import { mkdir, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`M5.04 focused web validation requires Node 24; received ${process.version}.`);
}
const cli = join(repositoryRoot, 'node_modules', '@angular', 'cli', 'bin', 'ng.js');
const outputRoot = join(repositoryRoot, 'apps', 'web', '.test-runs');
await mkdir(outputRoot, { recursive: true });
const temporaryOutput = join(outputRoot, `m5-04-${process.pid}-${Date.now()}`);
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
  process.stdout.write(`M5.04 focused Angular specs — Node ${process.version}\n`);
  const outputFile = join(temporaryOutput, 'web.junit.xml');
  const args = [
    'test', 'meta-integration', '--watch=false', `--output-file=${outputFile}`,
    '--include=src/app/features/portal/whatsapp-templates.component.spec.ts',
    '--include=src/app/app.routes.spec.ts',
  ];
  const commandSucceeded = run(args);
  if (!commandSucceeded) process.exitCode = 1;
  try {
    const report = await readFile(outputFile, 'utf8');
    const suites = [...report.matchAll(/<testsuite\b([^>]*)>/g)];
    const total = (attribute) => suites.reduce((sum, suite) => sum + Number(suite[1].match(new RegExp(`\\b${attribute}="(\\d+)"`))?.[1] ?? 0), 0);
    const tests = total('tests');
    const failures = total('failures') + total('errors');
    if (!commandSucceeded || tests === 0 || failures !== 0) {
      process.stderr.write(`M5.04 Angular JUnit result: ${tests} test(s), ${failures} failure(s).\n`);
      const failedCases = [...report.matchAll(/<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g)]
        .filter((match) => /<(failure|error)\b/.test(match[2] ?? ''));
      for (const failed of failedCases) {
        const name = failed[1]?.match(/\bname="([^"]+)"/)?.[1] ?? 'unknown test';
        const detail = (failed[2] ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
        process.stderr.write(`  ${name}: ${detail}\n`);
      }
      process.exitCode = 1;
    } else {
      process.stdout.write(`M5.04 Angular specs: ${tests} test(s), ${failures} failure(s).\n`);
    }
  } catch (error) {
    if (commandSucceeded) process.stderr.write(`M5.04 Angular JUnit report could not be read: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
} finally {
  const resolvedOutput = resolve(temporaryOutput);
  if (!resolvedOutput.startsWith(safePrefix) || !resolvedOutput.includes(`${sep}m5-04-`)) {
    throw new Error('M5.04 harness refused to remove an output directory outside its private workspace.');
  }
  await rm(resolvedOutput, { recursive: true, force: true });
}
