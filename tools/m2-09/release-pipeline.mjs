import { createHash } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { validateManifest } from './verify-release-manifest.mjs';
import { validateScanInputs } from './verify-scan-inputs.mjs';
import { validateScanResults } from './verify-scan-results.mjs';

const requiredChecks = [
  'desktop-candidate',
  'm2-08-mariadb',
  'm2-08-security',
  'm2-08-images',
];
const semverPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const sourcePattern = /^[0-9a-f]{40}$/;
const shaAttestationPredicate = 'https://slsa.dev/provenance/v1';
const sbomAttestationPredicate = 'https://spdx.dev/Document';

function fail(message) {
  throw new Error(message);
}

function environment(name) {
  const value = process.env[name];
  if (!value) fail(`Required release setting ${name} is not configured.`);
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.inherit ? 'inherit' : 'pipe',
  });
  if (result.error) fail(`${command} could not run: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) {
    const details = String(result.stderr ?? '').trim().split(/\r?\n/).slice(-3).join(' ');
    fail(`${command} failed${details ? `: ${details}` : '.'}`);
  }
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
  };
}

async function output(values) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) fail('GITHUB_OUTPUT is unavailable.');
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  await appendFile(path, `${lines.join('\n')}\n`, 'utf8');
}

function parseSemver(tag) {
  const match = semverPattern.exec(tag);
  if (!match) fail('Release Git tag must be v<major>.<minor>.<patch> (stable SemVer, no leading zeros).');
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function getReleaseContext({ verifyClean = false } = {}) {
  const releaseTag = environment('RELEASE_TAG');
  const sourceRevision = environment('SOURCE_REVISION');
  const githubRef = environment('GITHUB_REF');
  const repository = environment('GITHUB_REPOSITORY');
  const namespace = environment('DOCKERHUB_NAMESPACE');
  if (!sourcePattern.test(sourceRevision)) fail('SOURCE_REVISION must be a full lowercase Git SHA.');
  if (githubRef !== `refs/tags/${releaseTag}`) fail('Release workflow must run from the pushed SemVer tag.');
  if (!/^[a-z0-9][a-z0-9_-]{0,254}$/.test(namespace)) fail('DOCKERHUB_NAMESPACE must be an explicit lowercase Docker Hub namespace.');
  const semver = parseSemver(releaseTag);
  const currentSha = run('git', ['rev-parse', 'HEAD']).stdout;
  if (currentSha !== sourceRevision) fail('Checked-out source SHA does not match the release tag commit.');
  if (verifyClean && run('git', ['status', '--porcelain']).stdout !== '') fail('Release checkout is not clean.');
  return {
    repository,
    namespace,
    releaseTag,
    semver,
    releaseId: `${semver}+${sourceRevision.slice(0, 12)}`,
    sourceRevision,
  };
}

async function contractMetadata() {
  const bytes = await readFile(resolve('docs/meta-v2/contracts/openapi.yaml'), 'utf8');
  const versionMatch = /^  version:\s*([^\r\n#]+)$/m.exec(bytes);
  if (!versionMatch) fail('OpenAPI contract version could not be read from the release commit.');
  const version = versionMatch[1].trim().replace(/^['"]|['"]$/g, '');
  return {
    version,
    path: 'docs/meta-v2/contracts/openapi.yaml',
    sha256: createHash('sha256').update(await readFile(resolve('docs/meta-v2/contracts/openapi.yaml'))).digest('hex'),
  };
}

function writeReleaseLock(manifest, path) {
  const values = [
    '# Generated from release-manifest.json. Keep this file outside the source checkout when promoting.',
    `RELEASE_ID=${manifest.release.releaseId}`,
    `SOURCE_REVISION=${manifest.sourceRevision}`,
    `CA_META_WEB_IMAGE=${manifest.images.web.reference}`,
    `CA_META_API_IMAGE=${manifest.images.api.reference}`,
    `WEB_SOURCE_REVISION=${manifest.images.web.sourceRevision}`,
    `API_SOURCE_REVISION=${manifest.images.api.sourceRevision}`,
    `SCHEMA_VERSION=${manifest.databaseSchema.version}`,
    `SCHEMA_MIN_COMPATIBLE=${manifest.databaseSchema.minCompatible}`,
    `SCHEMA_MAX_COMPATIBLE=${manifest.databaseSchema.maxCompatible}`,
  ];
  return writeFile(path, `${values.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
}

function sha256File(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function prepare() {
  if (process.env.DOCKERHUB_RELEASE_ENABLED !== 'true') fail('Docker Hub release is disabled until an operator confirms the target environment configuration.');
  if (process.env.DOCKERHUB_IMMUTABLE_TAGS_CONFIRMED !== 'true') fail('Docker Hub immutable tag rules have not been confirmed by an operator.');
  if (process.env.DOCKERHUB_TARGET_PLATFORMS !== 'linux/amd64') fail('The configured deployment architecture must be confirmed as linux/amd64 before image publication.');
  const context = getReleaseContext({ verifyClean: true });
  const semverTag = context.semver;
  const shaTag = `sha-${context.sourceRevision}`;
  const attempt = environment('GITHUB_RUN_ATTEMPT');
  await output({
    release_tag: context.releaseTag,
    release_id: context.releaseId,
    source_revision: context.sourceRevision,
    semver: context.semver,
    dockerhub_namespace: context.namespace,
    web_semver_ref: `docker.io/${context.namespace}/ca-meta-web:${semverTag}`,
    web_sha_ref: `docker.io/${context.namespace}/ca-meta-web:${shaTag}`,
    api_semver_ref: `docker.io/${context.namespace}/ca-meta-api:${semverTag}`,
    api_sha_ref: `docker.io/${context.namespace}/ca-meta-api:${shaTag}`,
    scan_artifact: `m2-09-scan-input-${context.sourceRevision}-${attempt}`,
    scan_report_artifact: `m2-09-scan-report-${context.sourceRevision}-${attempt}`,
    evidence_artifact: `m2-09-release-${context.sourceRevision}-${attempt}`,
    publish_artifact: `m2-09-publish-${context.sourceRevision}-${attempt}`,
  });
}

async function verifyChecks(inputPath, outputPath) {
  const raw = JSON.parse(await readFile(inputPath, 'utf8'));
  const pages = Array.isArray(raw) ? raw.flat(Infinity) : [raw];
  const runs = pages.flatMap((page) => Array.isArray(page?.check_runs) ? page.check_runs : []);
  const latest = new Map();
  for (const check of runs) {
    if (!requiredChecks.includes(check.name)) continue;
    const existing = latest.get(check.name);
    const stamp = Date.parse(check.completed_at ?? check.started_at ?? 0);
    const oldStamp = existing ? Date.parse(existing.completed_at ?? existing.started_at ?? 0) : -1;
    if (!existing || stamp >= oldStamp) latest.set(check.name, check);
  }
  const verified = [];
  for (const name of requiredChecks) {
    const check = latest.get(name);
    if (!check || check.status !== 'completed' || check.conclusion !== 'success') {
      fail(`Required exact-commit check ${name} is absent or not successful.`);
    }
    if (typeof check.html_url !== 'string' || !check.html_url.startsWith('https://')) fail(`Required check ${name} has no HTTPS evidence URL.`);
    verified.push({ name, conclusion: check.conclusion, url: check.html_url });
  }
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(verified, null, 2)}\n`, 'utf8');
}

async function writeManifest(checksPath, outputDirectory) {
  const context = getReleaseContext();
  const evidenceDirectory = resolve('artifacts/release-evidence');
  const outputRoot = resolve(outputDirectory);
  await mkdir(outputRoot, { recursive: true });
  const requiredCi = JSON.parse(await readFile(checksPath, 'utf8'));
  const scanInputs = JSON.parse(await readFile('artifacts/scan-inputs.json', 'utf8'));
  const scanResultsBytes = await readFile(join(evidenceDirectory, 'scan-results.json'));
  const scanResults = JSON.parse(scanResultsBytes.toString('utf8'));
  const contract = await contractMetadata();
  const changelogText = (await readFile('artifacts/release/changelog.md', 'utf8')).trim();
  if (!changelogText) fail('Generated changelog is empty.');

  const expectedScan = {
    sourceRevision: context.sourceRevision,
    images: Object.fromEntries(['web', 'api'].map((kind) => {
      const upper = kind.toUpperCase();
      return [kind, {
        subjectName: environment(`${upper}_SUBJECT_NAME`),
        imageReference: environment(`${upper}_IMAGE_REF`),
        digest: environment(`${upper}_DIGEST`),
      }];
    })),
  };
  validateScanInputs(scanInputs, expectedScan);
  const actualReportHashes = {};
  const reportBytesByKind = {};
  for (const kind of ['web', 'api']) {
    reportBytesByKind[kind] = await readFile(join(evidenceDirectory, `trivy-${kind}.json`));
    actualReportHashes[kind] = sha256File(reportBytesByKind[kind]);
    if (scanResults.images?.[kind]?.archiveSha256 !== scanInputs.images[kind].sha256) {
      fail(`${kind} scan report does not identify the verified build archive.`);
    }
  }
  validateScanResults(scanResults, expectedScan, actualReportHashes);

  const images = {};
  for (const kind of ['web', 'api']) {
    const upper = kind.toUpperCase();
    const name = environment(`${upper}_SUBJECT_NAME`);
    const digest = environment(`${upper}_DIGEST`);
    const sbomPath = join(evidenceDirectory, `${kind}-sbom.spdx.json`);
    const provenancePath = join(evidenceDirectory, `${kind}-provenance.slsa.json`);
    const sbom = await readFile(sbomPath);
    const provenance = await readFile(provenancePath);
    const trivyReport = reportBytesByKind[kind];
    const sbomAsset = `${kind}-sbom.spdx.json`;
    const provenanceAsset = `${kind}-provenance.slsa.json`;
    await copyFile(sbomPath, join(outputRoot, sbomAsset));
    await copyFile(provenancePath, join(outputRoot, provenanceAsset));
    images[kind] = {
      name,
      reference: `${name}@${digest}`,
      digest,
      sourceRevision: context.sourceRevision,
      attestations: {
        provenance: {
          issuer: 'GitHub Actions / Sigstore',
          predicateType: shaAttestationPredicate,
          verified: true,
          url: environment(`${upper}_PROVENANCE_URL`),
        },
        sbom: {
          issuer: 'GitHub Actions / Sigstore',
          predicateType: sbomAttestationPredicate,
          verified: true,
          url: environment(`${upper}_SBOM_URL`),
          format: JSON.parse(sbom.toString('utf8')).spdxVersion,
          sha256: sha256File(sbom),
          asset: sbomAsset,
        },
      },
      buildKitProvenance: { asset: provenanceAsset, sha256: sha256File(provenance) },
      scan: {
        imageReference: `${name}@${digest}`,
        digest,
        sourceRevision: context.sourceRevision,
        engine: 'Trivy',
        version: '0.76.1',
        severity: ['HIGH', 'CRITICAL'],
        result: 'success',
        report: `trivy-${kind}.json`,
        reportSha256: sha256File(trivyReport),
      },
    };
    await writeFile(join(outputRoot, `trivy-${kind}.json`), trivyReport);
  }

  const manifest = {
    manifestVersion: 1,
    release: {
      tag: context.releaseTag,
      semver: context.semver,
      releaseId: context.releaseId,
      createdAt: new Date().toISOString(),
      workflowRunUrl: environment('RELEASE_WORKFLOW_RUN_URL'),
    },
    sourceRevision: context.sourceRevision,
    contract,
    databaseSchema: { version: 3, minCompatible: 3, maxCompatible: 3 },
    images,
    worker: {
      image: images.api.reference,
      command: [
        'sh',
        '-ec',
        'export API_DATABASE_PASSWORD="$(cat /run/secrets/api_database_password)"; exec node dist/worker/main.js',
      ],
      composeService: 'worker',
    },
    checks: {
      requiredCi,
      imageScan: {
        engine: 'Trivy',
        version: '0.76.1',
        severity: ['HIGH', 'CRITICAL'],
        result: 'success',
        reports: ['trivy-web.json', 'trivy-api.json'],
      },
    },
    changelog: {
      url: `https://github.com/${context.repository}/releases/tag/${context.releaseTag}`,
      markdown: changelogText,
    },
    scanEvidence: { asset: 'scan-results.json', sha256: sha256File(scanResultsBytes) },
  };
  validateManifest(manifest);
  await writeFile(join(outputRoot, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeReleaseLock(manifest, join(outputRoot, 'release-lock.env'));
  await copyFile('artifacts/release/changelog.md', join(outputRoot, 'changelog.md'));
  await copyFile(join(evidenceDirectory, 'scan-results.json'), join(outputRoot, 'scan-results.json'));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'prepare') await prepare();
    else if (command === 'verify-checks' && args.length === 2) await verifyChecks(args[0], args[1]);
    else if (command === 'write-manifest' && args.length === 2) await writeManifest(args[0], args[1]);
    else fail('Usage: release-pipeline.mjs prepare|verify-checks <input> <output>|write-manifest <checks> <output-dir>');
  } catch (error) {
    console.error(`M2.09 release gate failed: ${error.message}`);
    process.exitCode = 1;
  }
}

await main();
