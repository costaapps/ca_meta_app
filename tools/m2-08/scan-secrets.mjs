import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORT_DIRECTORY = path.resolve(process.env.M2_08_REPORT_DIRECTORY ?? path.join(ROOT, 'artifacts', 'security'));
const VERSION = '8.30.0';
const RELEASES = {
  'linux-x64': {
    archive: `gitleaks_${VERSION}_linux_x64.tar.gz`,
    sha256: '79a3ab579b53f71efd634f3aaf7e04a0fa0cf206b7ed434638d1547a2470a66e',
  },
  'win32-x64': {
    archive: `gitleaks_${VERSION}_windows_x64.zip`,
    sha256: '54fe94f644b832dd08e8c3a5915efb3bfa862386d59fb27ca0792cb687a83573',
  },
};

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...options });
  if (result.error) throw new Error(`Could not execute pinned scanner (${binary}).`);
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function parseReport(reportPath) {
  try {
    const report = JSON.parse(requireText(reportPath));
    return Array.isArray(report) ? report : [];
  } catch {
    return null;
  }
}

function requireText(filePath) {
  return readFileSync(filePath, 'utf8');
}

function safeFindings(findings) {
  return findings.map((finding) => ({
    ruleId: finding.RuleID ?? 'unknown',
    file: finding.File ?? 'unknown',
    startLine: Number.isInteger(finding.StartLine) ? finding.StartLine : null,
    commit: /^[a-f0-9]{7,40}$/i.test(finding.Commit ?? '') ? finding.Commit : null,
  }));
}

async function downloadTool(tempRoot) {
  const key = `${process.platform}-${process.arch}`;
  const release = RELEASES[key];
  if (!release) throw new Error(`No verified Gitleaks binary is configured for ${key}.`);
  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${release.archive}`;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Pinned Gitleaks download failed with HTTP ${response.status}.`);
  const archivePath = path.join(tempRoot, release.archive);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== release.sha256) throw new Error('Pinned Gitleaks checksum mismatch.');
  await writeFile(archivePath, bytes, { flag: 'wx' });
  const extraction = run('tar', ['-xf', archivePath, '-C', tempRoot], { windowsHide: true });
  if (extraction.status !== 0) throw new Error('Pinned Gitleaks archive extraction failed.');
  return path.join(tempRoot, process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks');
}

function getBaseSha() {
  const configured = process.env.M2_08_BASE_SHA ?? '';
  if (/^[a-f0-9]{40}$/i.test(configured) && !/^0{40}$/.test(configured)) return configured;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD^'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    throw new Error('Secret scan needs a base commit; set M2_08_BASE_SHA or provide HEAD^ locally.');
  }
}

function runScan(binary, args) {
  return run(binary, args, { cwd: ROOT, windowsHide: true });
}

async function main() {
  await mkdir(REPORT_DIRECTORY, { recursive: true });
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'ca-meta-m208-gitleaks-'));
  const rawNegative = path.join(tempRoot, 'negative.json');
  const rawRepository = path.join(tempRoot, 'repository.json');
  const sanitizedPath = path.join(REPORT_DIRECTORY, 'secrets.json');
  let failed = false;

  try {
    const binary = await downloadTool(tempRoot);
    const config = path.join(ROOT, 'tools', 'm2-08', 'gitleaks.toml');
    const templatePath = path.join(ROOT, 'tools', 'm2-08', 'fixtures', 'secret-negative.txt.tmpl');
    const fixtureDirectory = path.join(tempRoot, 'fixture');
    await mkdir(fixtureDirectory);
    const fixtureContent = (await readFile(templatePath, 'utf8')).replace('{{SYNTHETIC_HEX}}', '0123456789ABCDEF0123456789ABCDEF01234567');
    await writeFile(path.join(fixtureDirectory, 'synthetic-secret.txt'), fixtureContent, { flag: 'wx' });
    const negative = runScan(binary, [
      'dir', `--config=${config}`, '--report-format=json', `--report-path=${rawNegative}`,
      '--redact=100', '--no-banner', '--log-level=error', '--exit-code=1', fixtureDirectory,
    ]);
    const negativeFindings = parseReport(rawNegative);
    const fixtureProved = negative.status !== 0 && Array.isArray(negativeFindings)
      && negativeFindings.some((finding) => finding.RuleID === 'ca-meta-synthetic-secret-fixture');
    if (!fixtureProved) failed = true;

    const baseSha = getBaseSha();
    const repository = runScan(binary, [
      'git', `--config=${config}`, '--report-format=json', `--report-path=${rawRepository}`,
      `--log-opts=--no-merges ${baseSha}..HEAD`, '--redact=100', '--no-banner', '--log-level=error', '--exit-code=1', '.',
    ]);
    const findings = parseReport(rawRepository);
    if (!Array.isArray(findings) || (repository.status !== 0 && findings.length === 0)) failed = true;
    if (Array.isArray(findings) && findings.length > 0) failed = true;

    await writeFile(sanitizedPath, `${JSON.stringify({
      scanner: `gitleaks ${VERSION}`,
      scanRange: `${baseSha}..HEAD`,
      scannedMode: 'commit diff only; working-tree-only local connection PHP files are outside this scan',
      negativeFixture: fixtureProved ? 'detected' : 'failed',
      status: failed ? 'failed' : 'passed',
      findings: Array.isArray(findings) ? safeFindings(findings) : [],
    }, null, 2)}\n`, 'utf8');
    if (failed) {
      process.stderr.write('Secret scan or its synthetic negative fixture failed. Inspect sanitized artifacts/security/secrets.json.\n');
      process.exitCode = 1;
    } else {
      process.stdout.write(`Secret scan passed for ${baseSha}..HEAD; negative fixture was detected.\n`);
    }
  } finally {
    const resolvedTemp = path.resolve(tempRoot);
    const resolvedParent = path.resolve(os.tmpdir()) + path.sep;
    if (!resolvedTemp.startsWith(resolvedParent)) throw new Error('Refusing unsafe scanner temporary-directory cleanup.');
    await rm(resolvedTemp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
