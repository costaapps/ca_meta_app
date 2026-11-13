import { mkdir, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`M5.06 focused web validation requires Node 24; received ${process.version}.`);
}
const cli = join(root, 'node_modules', '@angular', 'cli', 'bin', 'ng.js');
const outputRoot = join(root, 'apps', 'web', '.test-runs');
await mkdir(outputRoot, { recursive: true });
const output = join(outputRoot, `m5-06-${process.pid}-${Date.now()}`);
await mkdir(output, { recursive: false });
const safePrefix = `${resolve(outputRoot)}${sep}`;

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: join(root, 'apps', 'web'), stdio: 'inherit', windowsHide: true, env: process.env,
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

try {
  process.stdout.write(`M5.06 focused Angular specs — Node ${process.version}\n`);
  const outputFile = join(output, 'web.junit.xml');
  const commandSucceeded = run([
    'test', 'meta-integration', '--watch=false', `--output-file=${outputFile}`,
    '--include=src/app/features/portal/notifications.component.spec.ts',
  ]);
  const report = await readFile(outputFile, 'utf8');
  const suites = [...report.matchAll(/<testsuite\b([^>]*)>/g)];
  const total = (name) => suites.reduce((sum, entry) => sum + Number(entry[1].match(new RegExp(`\\b${name}="(\\d+)"`))?.[1] ?? 0), 0);
  const tests = total('tests');
  const failures = total('failures') + total('errors');
  if (!commandSucceeded || tests === 0 || failures !== 0) {
    process.stderr.write(`M5.06 web result: ${tests} test(s), ${failures} failure(s).\n`);
    process.exitCode = 1;
  } else process.stdout.write(`M5.06 web specs: ${tests} test(s), ${failures} failure(s).\n`);
} finally {
  const resolvedOutput = resolve(output);
  if (!resolvedOutput.startsWith(safePrefix) || !resolvedOutput.includes(`${sep}m5-06-`)) {
    throw new Error('M5.06 web harness refused to remove output outside its private directory.');
  }
  await rm(resolvedOutput, { recursive: true, force: true });
}
