import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORT_DIRECTORY = path.resolve(process.env.M2_08_REPORT_DIRECTORY ?? path.join(ROOT, 'artifacts', 'security'));
const REQUESTED_BASE_ROOT = process.env.M2_08_AUDIT_BASE && path.resolve(process.env.M2_08_AUDIT_BASE);
const BASE_ROOT = REQUESTED_BASE_ROOT && existsSync(path.join(REQUESTED_BASE_ROOT, 'package-lock.json')) ? REQUESTED_BASE_ROOT : null;
const BASE_SHA = process.env.M2_08_BASE_SHA || null;
const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const PROJECTS = [
  { id: 'root-workspaces', directory: ROOT },
  { id: 'm1-07-contract-toolchain', directory: path.join(ROOT, 'tools', 'm1-07') },
];

function runAudit(cwd, omitDev) {
  const args = ['audit', '--json', '--package-lock-only'];
  if (omitDev) args.push('--omit=dev');
  const child = spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    // Resolve npm.cmd on Windows; this function supplies only fixed audit flags.
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (child.error) throw new Error('npm audit could not start.');
  if (![0, 1].includes(child.status)) throw new Error(`npm audit was incomplete (exit ${child.status ?? 'unknown'}).`);
  let data;
  try {
    data = JSON.parse(child.stdout ?? '');
  } catch {
    throw new Error('npm audit returned invalid JSON; report withheld.');
  }
  if (!data.metadata?.vulnerabilities || !data.vulnerabilities) {
    throw new Error('npm audit did not return the expected dependency report.');
  }
  return data;
}

function advisoryIds(finding) {
  const via = (finding.via ?? []).map((entry) => {
    if (typeof entry === 'string') return `dependency:${entry}`;
    if (entry.url) return entry.url;
    if (entry.source !== undefined) return `advisory:${entry.source}`;
    return `advisory:${entry.title ?? 'unknown'}:${entry.range ?? 'unknown'}`;
  });
  return [...new Set(via)].sort();
}

function normalize(data, runtimePackages) {
  const packages = Object.entries(data.vulnerabilities)
    .map(([name, finding]) => ({
      name,
      severity: finding.severity ?? 'unknown',
      scope: runtimePackages.has(name) ? 'runtime-or-mixed' : 'dev-only',
      direct: finding.isDirect === true,
      range: finding.range ?? null,
      fixAvailable: finding.fixAvailable ?? false,
      paths: [...new Set(finding.nodes ?? [])].sort(),
      advisories: advisoryIds(finding),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { counts: data.metadata.vulnerabilities, packages };
}

function findingMap(report) {
  const map = new Map();
  for (const finding of report.packages) {
    const paths = finding.paths.length > 0 ? finding.paths : ['unresolved-path'];
    const advisories = finding.advisories.length > 0 ? finding.advisories : ['unidentified'];
    for (const advisory of advisories) {
      for (const installPath of paths) {
        const key = `${finding.name}\u0000${advisory}\u0000${finding.scope}\u0000${installPath}`;
        map.set(key, finding);
      }
    }
  }
  return map;
}

function compare(current, baseline) {
  const oldFindings = findingMap(baseline);
  const added = [];
  const escalated = [];
  for (const [key, finding] of findingMap(current)) {
    const previous = oldFindings.get(key);
    const [, advisory, , installPath] = key.split('\u0000');
    if (!previous) {
      added.push({ package: finding.name, severity: finding.severity, scope: finding.scope, advisory, path: installPath });
    } else if ((SEVERITY_RANK[finding.severity] ?? 0) > (SEVERITY_RANK[previous.severity] ?? 0)) {
      escalated.push({ package: finding.name, from: previous.severity, to: finding.severity, scope: finding.scope, advisory, path: installPath });
    }
  }
  return { added, escalated };
}

function numberOrZero(value) {
  return typeof value === 'number' ? value : 0;
}

async function auditProject(project) {
  if (!existsSync(path.join(project.directory, 'package-lock.json'))) {
    throw new Error(`Missing package-lock.json for ${project.id}.`);
  }
  const currentFull = runAudit(project.directory, false);
  const currentRuntime = runAudit(project.directory, true);
  const current = normalize(currentFull, new Set(Object.keys(currentRuntime.vulnerabilities)));
  const runtimeCounts = currentRuntime.metadata.vulnerabilities;
  const devOnlyCounts = Object.fromEntries(Object.entries(current.counts).map(([severity, count]) => [
    severity,
    Math.max(0, numberOrZero(count) - numberOrZero(runtimeCounts[severity])),
  ]));

  let baseline = { counts: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 }, packages: [] };
  if (BASE_ROOT) {
    const relative = path.relative(ROOT, project.directory);
    const baseProject = path.join(BASE_ROOT, relative);
    if (!existsSync(path.join(baseProject, 'package-lock.json'))) {
      throw new Error(`Comparison base has no lockfile for ${project.id}; audit cannot compare safely.`);
    }
    const baselineFull = runAudit(baseProject, false);
    const baselineRuntime = runAudit(baseProject, true);
    baseline = normalize(baselineFull, new Set(Object.keys(baselineRuntime.vulnerabilities)));
  }

  return {
    id: project.id,
    current,
    runtimeCounts,
    devOnlyCounts,
    baseCounts: baseline.counts,
    comparison: compare(current, baseline),
  };
}

function appendSummary(projects, result) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return null;
  const lines = [
    '## Dependency audit', '',
    'Historical reference only (2026-10-28): root npm workspaces had 47 findings (4 critical, 31 high, 11 moderate, 1 low). This is not an allowlist.',
    `Comparison base: ${BASE_SHA ?? 'empty initial baseline'}. New package/advisory/path/scope entries and severity escalations fail the check.`, '',
  ];
  for (const project of projects) {
    lines.push(`### ${project.id}`, '',
      `Current counts: ${JSON.stringify(project.current.counts)}; runtime counts: ${JSON.stringify(project.runtimeCounts)}; dev-only counts: ${JSON.stringify(project.devOnlyCounts)}.`,
      '', '| Package | Severity | Scope | Advisory | Install path |', '|---|---|---|---|---|');
    for (const item of project.current.packages) {
      for (const advisory of item.advisories.length ? item.advisories : ['unidentified']) {
        for (const installPath of item.paths.length ? item.paths : ['unresolved-path']) {
          lines.push(`| ${item.name} | ${item.severity} | ${item.scope} | ${advisory} | ${installPath} |`);
        }
      }
    }
    if (project.current.packages.length === 0) lines.push('| none | — | — | — | — |');
    lines.push('', '#### Added or escalated relative to base', '', '| Package | Change | Scope | Advisory | Install path |', '|---|---|---|---|---|');
    const changes = [
      ...project.comparison.added.map((item) => ({ ...item, change: `new ${item.severity}` })),
      ...project.comparison.escalated.map((item) => ({ ...item, change: `${item.from} → ${item.to}` })),
    ];
    for (const item of changes) lines.push(`| ${item.package} | ${item.change} | ${item.scope} | ${item.advisory} | ${item.path} |`);
    if (changes.length === 0) lines.push('| none | — | — | — | — |');
    lines.push('');
  }
  lines.push('npm audit does not establish exploitability or reachability.', '');
  return writeFile(summaryPath, lines.join('\n'), { encoding: 'utf8', flag: 'a' });
}

async function main() {
  await mkdir(REPORT_DIRECTORY, { recursive: true });
  if (!BASE_ROOT && process.env.M2_08_ALLOW_EMPTY_AUDIT_BASE !== '1') {
    throw new Error('Dependency audit requires M2_08_AUDIT_BASE with the target/predecessor lockfiles. Set M2_08_ALLOW_EMPTY_AUDIT_BASE=1 only for an explicitly new-project bootstrap.');
  }
  if (REQUESTED_BASE_ROOT && !BASE_ROOT && BASE_SHA && !/^0{40}$/.test(BASE_SHA)) {
    throw new Error('The configured comparison base has no package-lock.json; dependency audit cannot compare safely.');
  }
  const projects = [];
  for (const project of PROJECTS) projects.push(await auditProject(project));
  const added = projects.flatMap((project) => project.comparison.added.map((finding) => ({ project: project.id, ...finding })));
  const escalated = projects.flatMap((project) => project.comparison.escalated.map((finding) => ({ project: project.id, ...finding })));
  const report = {
    generatedAt: new Date().toISOString(),
    scanner: 'npm audit --json --package-lock-only',
    comparison: {
      baseSha: BASE_SHA,
      mode: BASE_ROOT ? 'exact package/advisory/path/scope delta against target branch lockfiles' : 'new branch; empty comparison baseline',
      historicalReference: {
        asOf: '2026-10-28',
        scope: 'root npm workspaces only',
        total: 47,
        critical: 4,
        high: 31,
        moderate: 11,
        low: 1,
        allowlisted: false,
      },
      added,
      severityEscalations: escalated,
    },
    projects,
    status: added.length || escalated.length ? 'failed-new-findings' : 'passed-no-new-findings',
    limitations: ['npm audit reports known advisories; exploitability/reachability is not established.'],
  };
  await writeFile(path.join(REPORT_DIRECTORY, 'npm-audit.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await appendSummary(projects, report);

  if (added.length || escalated.length) {
    process.stderr.write(`Dependency audit found ${added.length} new advisory/package/path/scope entries and ${escalated.length} severity escalations. See sanitized artifacts/security/npm-audit.json.\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Dependency audit recorded ${projects.length} projects; no new advisory/package/path/scope delta against ${BASE_SHA ?? 'empty baseline'}.\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
