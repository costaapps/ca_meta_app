import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORT_DIRECTORY = path.resolve(process.env.M2_08_REPORT_DIRECTORY ?? path.join(ROOT, 'artifacts', 'security'));
const LOCKFILES = [
  { id: 'root-workspaces', path: path.join(ROOT, 'package-lock.json') },
  { id: 'm1-07-contract-toolchain', path: path.join(ROOT, 'tools', 'm1-07', 'package-lock.json') },
];

async function scanLockfile(project) {
  const lock = JSON.parse(await readFile(project.path, 'utf8'));
  if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error(`Expected npm lockfile v3 for ${project.id}.`);
  const packages = Object.entries(lock.packages)
    .filter(([location]) => location.includes('node_modules/'))
    .map(([location, metadata]) => {
      const value = metadata.license;
      const license = typeof value === 'string' ? value : value?.type ?? 'UNCONFIRMED';
      return {
        name: metadata.name ?? location.split('node_modules/').at(-1),
        version: metadata.version ?? 'unknown',
        license,
        scope: metadata.dev === true ? 'dev' : metadata.dev === false ? 'runtime' : 'mixed-or-unclassified',
        lockfilePath: location,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.lockfilePath.localeCompare(b.lockfilePath));
  return {
    id: project.id,
    packageCount: packages.length,
    runtimeCount: packages.filter((item) => item.scope === 'runtime').length,
    devCount: packages.filter((item) => item.scope === 'dev').length,
    unconfirmedCount: packages.filter((item) => item.license === 'UNCONFIRMED').length,
    packages,
  };
}

async function main() {
  await mkdir(REPORT_DIRECTORY, { recursive: true });
  const projects = [];
  for (const lockfile of LOCKFILES) projects.push(await scanLockfile(lockfile));
  const packageCount = projects.reduce((count, project) => count + project.packageCount, 0);
  const runtimeCount = projects.reduce((count, project) => count + project.runtimeCount, 0);
  const devCount = projects.reduce((count, project) => count + project.devCount, 0);
  const unconfirmedCount = projects.reduce((count, project) => count + project.unconfirmedCount, 0);
  const report = {
    generatedAt: new Date().toISOString(),
    scanner: 'npm lockfile license metadata inventory',
    policyStatus: 'informational; repository license policy is not confirmed',
    packageCount,
    runtimeCount,
    devCount,
    unconfirmedCount,
    projects,
    limitations: ['Reads checked-in lockfile metadata only; it does not verify each package license text or grant legal approval.'],
  };
  await writeFile(path.join(REPORT_DIRECTORY, 'licenses.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const rows = projects.flatMap((project) => project.packages.map((item) =>
      `| ${project.id} | ${item.name} | ${item.version} | ${item.scope} | ${item.license} |`));
    const summary = [
      '## Lockfile license inventory', '',
      `Packages: ${packageCount}; runtime: ${runtimeCount}; dev: ${devCount}; unconfirmed: ${unconfirmedCount}.`,
      'Informational only: the repository license policy is not confirmed. The scanner reads lockfile metadata and does not verify license texts.', '',
      '| Project | Package | Version | Scope | License metadata |', '|---|---|---|---|---|',
      ...(rows.length ? rows : ['| none | — | — | — | — |']), '',
    ].join('\n');
    await writeFile(summaryPath, summary, { encoding: 'utf8', flag: 'a' });
  }
  process.stdout.write(`Recorded lockfile license metadata for ${projects.length} projects and ${packageCount} package entries.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
