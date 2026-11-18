import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, lstat, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const webRoot = join(repositoryRoot, 'apps', 'web');
const cli = join(repositoryRoot, 'node_modules', '@angular', 'cli', 'bin', 'ng.js');
const matrixPath = join(repositoryRoot, 'tools', 'm6-01', 'evidence-matrix.json');
const outputRoot = join(webRoot, '.test-runs');
const temporaryOutput = join(outputRoot, `m6-01-${process.pid}-${Date.now()}`);

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor !== 24 || nodeMinor < 15) {
  throw new Error(`M6.01 focused tests require Node >=24.15.0 <25; received ${process.version}.`);
}
const matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
if (matrix.issue !== 69 || matrix.package !== 'M6.01' || !Array.isArray(matrix.localSuite)) {
  throw new Error('M6.01 evidence matrix is malformed or targets another issue.');
}

const specs = [...new Set(matrix.localSuite)];
const declaredSpecs = new Set(specs);
const caseEvidence = matrix.scenarios.flatMap((scenario) => scenario.localTests ?? []);
if (specs.length === 0 || caseEvidence.some((item) => !declaredSpecs.has(item.file))) {
  throw new Error('Each automated scenario must point to a spec included in the focused suite.');
}

const fingerprint = createHash('sha256');
for (const relativePath of [
  'tools/m6-01/evidence-matrix.json',
  ...specs.map((spec) => `apps/web/${spec}`),
]) {
  const content = await readFile(join(repositoryRoot, relativePath));
  fingerprint.update(relativePath).update('\0').update(content).update('\0');
}
const testInputFingerprint = fingerprint.digest('hex');

const missingCases = [];
for (const evidence of caseEvidence) {
  const source = await readFile(join(webRoot, evidence.file), 'utf8');
  if (!source.includes(evidence.case)) missingCases.push(`${evidence.file}: ${evidence.case}`);
}
if (missingCases.length > 0) {
  throw new Error(`Evidence matrix points to missing named test cases:\n${missingCases.join('\n')}`);
}

await mkdir(outputRoot, { recursive: true });
const outputInfo = await lstat(outputRoot);
const realWebRoot = await realpath(webRoot);
const realOutputRoot = await realpath(outputRoot);
if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink() || realOutputRoot !== join(realWebRoot, '.test-runs')) {
  throw new Error('M6.01 harness refused an output directory outside apps/web/.test-runs.');
}
await mkdir(temporaryOutput, { recursive: false });
const junitPath = join(temporaryOutput, 'web.junit.xml');

const args = [
  cli,
  'test',
  'meta-integration',
  '--watch=false',
  `--output-file=${junitPath}`,
  ...specs.flatMap((spec) => [`--include=${spec}`]),
];

try {
  process.stdout.write(`M6.01 focused web journey checks — Node ${process.version}\n`);
  process.stdout.write(`Selected specs: ${specs.length}; test evidence fingerprint: ${testInputFingerprint}\n`);
  process.stdout.write('Evidence source: local Angular/Vitest component and service tests; no Meta/Suite4 accounts.\n');
  const result = spawnSync(process.execPath, args, {
    cwd: webRoot,
    stdio: 'inherit',
    windowsHide: true,
    env: process.env,
  });
  if (result.error) throw result.error;
  const commandPassed = result.status === 0;
  const report = await readFile(junitPath, 'utf8');
  const suites = [...report.matchAll(/<testsuite\b([^>]*)>/g)];
  const total = (attribute) => suites.reduce((sum, suite) => sum + Number(suite[1].match(new RegExp(`\\b${attribute}="(\\d+)"`))?.[1] ?? 0), 0);
  const tests = total('tests');
  const failures = total('failures') + total('errors');
  process.stdout.write(`JUnit: ${tests} test(s), ${failures} failure(s).\n`);
  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (headResult.error || headResult.status !== 0) throw new Error('Could not record the source commit for this run.');
  await writeFile(join(repositoryRoot, 'tools', 'm6-01', 'last-run.json'), `${JSON.stringify({
    package: 'M6.01',
    issue: 69,
    executedAtUtc: new Date().toISOString(),
    gitHeadAtRun: headResult.stdout.trim(),
    testInputFingerprint,
    node: process.version,
    selectedSpecCount: specs.length,
    junitSuiteCount: suites.length,
    testCount: tests,
    failureCount: failures,
    result: commandPassed && tests > 0 && failures === 0 ? 'PASS_LOCAL_FIXTURES' : 'FAIL',
    scope: 'Local Angular/Vitest specs only; no provider, Suite4 or browser E2E evidence.',
  }, null, 2)}\n`, 'utf8');
  if (!commandPassed || tests === 0 || failures !== 0) process.exitCode = 1;
} finally {
  const outputRootInfo = await lstat(outputRoot);
  const temporaryInfo = await lstat(temporaryOutput);
  const [resolvedWebRoot, resolvedOutputRoot, resolvedTemporary] = await Promise.all([
    realpath(webRoot), realpath(outputRoot), realpath(temporaryOutput),
  ]);
  if (!outputRootInfo.isDirectory() || outputRootInfo.isSymbolicLink() ||
      !temporaryInfo.isDirectory() || temporaryInfo.isSymbolicLink() ||
      resolvedOutputRoot !== join(resolvedWebRoot, '.test-runs') ||
      dirname(resolvedTemporary) !== resolvedOutputRoot ||
      basename(resolvedTemporary) !== basename(temporaryOutput) ||
      !basename(resolvedTemporary).startsWith('m6-01-')) {
    throw new Error('M6.01 harness refused to remove an output outside its unique test directory.');
  }
  await rm(resolvedTemporary, { recursive: true, force: true });
}
