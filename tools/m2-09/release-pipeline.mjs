import { createHash } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { validateManifest } from './verify-release-manifest.mjs';

const requiredChecks = [
  'desktop-candidate',
  'm2-08-mariadb',
  'm2-08-security',
  'm2-08-images',
];
const semverPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const sourcePattern = /^[0-9a-f]{40}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
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

function collectValuesByKey(value, targetKey, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectValuesByKey(item, targetKey, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === targetKey.toLowerCase() && typeof child === 'string') found.push(child);
    collectValuesByKey(child, targetKey, found);
  }
  return found;
}

function inspectDigest(reference) {
  const result = run('docker', ['buildx', 'imagetools', 'inspect', '--format', '{{json .Manifest}}', reference], { allowFailure: true });
  if (!result.ok) {
    const error = result.stderr.toLowerCase();
    if (/manifest unknown|no such manifest|not found|404/.test(error)) return null;
    fail(`Could not inspect Docker Hub image reference ${reference}.`);
  }
  let manifest;
  try {
    manifest = JSON.parse(result.stdout);
  } catch {
    fail(`Registry returned an invalid manifest for ${reference}.`);
  }
  if (!digestPattern.test(manifest.digest ?? '')) fail(`Registry digest is invalid for ${reference}.`);
  return manifest.digest;
}

function verifyExistingAttestation(imageReference, context) {
  run('gh', [
    'attestation', 'verify', `oci://${imageReference}`,
    '--repo', context.repository,
    '--signer-workflow', `${context.repository}/.github/workflows/release.yml`,
    '--source-digest', context.sourceRevision,
    '--source-ref', `refs/tags/${context.releaseTag}`,
  ]);
}

async function extractBuildEvidence(imageReference, imageKind, context) {
  const evidencePath = resolve('artifacts/release-evidence');
  await mkdir(evidencePath, { recursive: true });
  const provenanceText = run('docker', [
    'buildx', 'imagetools', 'inspect', '--format', '{{json .Provenance.SLSA}}', imageReference,
  ]).stdout;
  let provenance;
  try {
    provenance = JSON.parse(provenanceText);
  } catch {
    fail(`${imageKind} BuildKit provenance is absent or invalid.`);
  }
  if (provenance.buildType !== 'https://mobyproject.org/buildkit@v1') fail(`${imageKind} provenance was not generated by BuildKit.`);
  const revisions = collectValuesByKey(provenance, 'revision');
  const revisionBuildArgs = collectValuesByKey(provenance, 'build-arg:OCI_REVISION');
  if (!revisions.includes(context.sourceRevision) && !revisionBuildArgs.includes(context.sourceRevision)) {
    fail(`${imageKind} BuildKit provenance does not identify the exact source SHA.`);
  }
  const sources = collectValuesByKey(provenance, 'source');
  if (sources.length > 0 && !sources.some((source) => source.toLowerCase().includes(context.repository.toLowerCase()))) {
    fail(`${imageKind} BuildKit provenance identifies a different source repository.`);
  }

  const sbomText = run('docker', [
    'buildx', 'imagetools', 'inspect', '--format', '{{json .SBOM.SPDX}}', imageReference,
  ]).stdout;
  let sbom;
  try {
    sbom = JSON.parse(sbomText);
  } catch {
    fail(`${imageKind} BuildKit SPDX SBOM is absent or invalid.`);
  }
  if (typeof sbom.spdxVersion !== 'string' || !/^SPDX-2\.\d+$/.test(sbom.spdxVersion)) fail(`${imageKind} SBOM does not contain a supported SPDX 2.x version.`);

  const provenanceBytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  const sbomBytes = Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
  const provenanceFile = `${imageKind}-provenance.slsa.json`;
  const sbomFile = `${imageKind}-sbom.spdx.json`;
  await writeFile(join(evidencePath, provenanceFile), provenanceBytes);
  await writeFile(join(evidencePath, sbomFile), sbomBytes);
  return {
    provenance: { file: provenanceFile, sha256: sha256File(provenanceBytes) },
    sbom: { file: sbomFile, sha256: sha256File(sbomBytes), format: sbom.spdxVersion },
  };
}

function verifyRuntimeLabels(imageReference, kind, context) {
  run('docker', ['pull', imageReference]);
  const labelsText = run('docker', [
    'image', 'inspect', '--format', '{{json .Config.Labels}}', imageReference,
  ]).stdout;
  let labels;
  try {
    labels = JSON.parse(labelsText);
  } catch {
    fail(`${kind} image OCI labels could not be read.`);
  }
  if (labels?.['org.opencontainers.image.revision'] !== context.sourceRevision) fail(`${kind} image OCI revision label does not match SOURCE_REVISION.`);
  if (labels?.['org.opencontainers.image.source'] !== `https://github.com/${context.repository}`) fail(`${kind} image OCI source label does not match the repository.`);
  if (labels?.['org.opencontainers.image.version'] !== context.semver) fail(`${kind} image OCI version label does not match the release SemVer.`);
}

async function prepare() {
  if (process.env.DOCKERHUB_RELEASE_ENABLED !== 'true') fail('Docker Hub release is disabled until an operator confirms the target environment configuration.');
  if (process.env.DOCKERHUB_IMMUTABLE_TAGS_CONFIRMED !== 'true') fail('Docker Hub immutable tag rules have not been confirmed by an operator.');
  if (process.env.DOCKERHUB_TARGET_PLATFORMS !== 'linux/amd64') fail('The configured deployment architecture must be confirmed as linux/amd64 before image publication.');
  environment('DOCKERHUB_USERNAME');
  environment('DOCKERHUB_TOKEN');
  const context = getReleaseContext({ verifyClean: true });
  run('docker', ['buildx', 'version']);
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

async function resolveImage() {
  const kind = environment('IMAGE_KIND');
  if (!['web', 'api'].includes(kind)) fail('IMAGE_KIND must be web or api.');
  const context = getReleaseContext();
  const imageName = `docker.io/${context.namespace}/ca-meta-${kind}`;
  const versionReference = `${imageName}:${context.semver}`;
  const shaReference = `${imageName}:sha-${context.sourceRevision}`;
  const versionDigest = inspectDigest(versionReference);
  const shaDigest = inspectDigest(shaReference);
  if (versionDigest && shaDigest && versionDigest !== shaDigest) fail(`${kind} SemVer and SHA tags already point to different immutable digests.`);

  let digest = versionDigest ?? shaDigest;
  let reused = false;
  if (digest) {
    reused = true;
  } else {
    const candidateTag = `candidate-${context.sourceRevision}-${environment('GITHUB_RUN_ID')}-${environment('GITHUB_RUN_ATTEMPT')}`;
    const candidateReference = `${imageName}:${candidateTag}`;
    const metadataPath = join(environment('RUNNER_TEMP'), `m2-09-${kind}-build.json`);
    run('docker', [
      'buildx', 'build',
      '--platform', 'linux/amd64',
      '--file', `infra/docker/${kind}.Dockerfile`,
      '--build-arg', `OCI_VERSION=${context.semver}`,
      '--build-arg', `OCI_REVISION=${context.sourceRevision}`,
      '--provenance=mode=max,version=v1',
      '--sbom=true',
      '--metadata-file', metadataPath,
      '--tag', candidateReference,
      '--push',
      '.',
    ], { inherit: true });
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    digest = metadata['containerimage.digest'];
    if (!digestPattern.test(digest ?? '')) fail(`${kind} Buildx metadata did not return an image digest.`);
  }

  const imageReference = `${imageName}@${digest}`;
  verifyRuntimeLabels(imageReference, kind, context);
  const evidence = await extractBuildEvidence(imageReference, kind, context);
  if (reused) verifyExistingAttestation(imageReference, context);
  await output({
    digest,
    image_ref: imageReference,
    subject_name: imageName,
    reused: String(reused),
    buildkit_provenance_file: evidence.provenance.file,
    buildkit_provenance_sha256: evidence.provenance.sha256,
    sbom_file: evidence.sbom.file,
    sbom_sha256: evidence.sbom.sha256,
    sbom_format: evidence.sbom.format,
  });
}

function verifyAttestation(imageReference, context, predicateType = undefined) {
  const args = [
    'attestation', 'verify', `oci://${imageReference}`,
    '--repo', context.repository,
    '--signer-workflow', `${context.repository}/.github/workflows/release.yml`,
    '--source-digest', context.sourceRevision,
    '--source-ref', `refs/tags/${context.releaseTag}`,
    '--format', 'json',
  ];
  if (predicateType) args.push('--predicate-type', predicateType);
  return run('gh', args).stdout;
}

async function verifyAttestations() {
  const context = getReleaseContext();
  const directory = resolve('artifacts/release-evidence');
  const evidence = [];
  for (const kind of ['web', 'api']) {
    const imageReference = environment(`${kind.toUpperCase()}_IMAGE_REF`);
    if (!imageReference.endsWith(`@${environment(`${kind.toUpperCase()}_DIGEST`)}`)) fail(`${kind} subject digest does not match its image reference.`);
    const provenance = verifyAttestation(imageReference, context, shaAttestationPredicate);
    const sbom = verifyAttestation(imageReference, context, sbomAttestationPredicate);
    const provenancePath = join(directory, `github-${kind}-provenance-verification.json`);
    const sbomPath = join(directory, `github-${kind}-sbom-verification.json`);
    await writeFile(provenancePath, `${JSON.stringify(JSON.parse(provenance), null, 2)}\n`, 'utf8');
    await writeFile(sbomPath, `${JSON.stringify(JSON.parse(sbom), null, 2)}\n`, 'utf8');
    evidence.push(kind);
  }
  if (evidence.length !== 2) fail('Both web and API GitHub attestations must verify.');
}

function promoteTag(imageName, digest, tag) {
  const target = `${imageName}:${tag}`;
  const currentDigest = inspectDigest(target);
  if (currentDigest) {
    if (currentDigest !== digest) fail(`Immutable release tag ${target} already points to another digest; refusing to overwrite it.`);
    return;
  }
  run('docker', ['buildx', 'imagetools', 'create', '--prefer-index=true', '--tag', target, `${imageName}@${digest}`], { inherit: true });
  const promotedDigest = inspectDigest(target);
  if (promotedDigest !== digest) fail(`Promoted tag ${target} did not preserve the verified source digest.`);
}

async function promote() {
  const context = getReleaseContext();
  for (const kind of ['web', 'api']) {
    const imageName = environment(`${kind.toUpperCase()}_SUBJECT_NAME`);
    const imageReference = environment(`${kind.toUpperCase()}_IMAGE_REF`);
    const digest = environment(`${kind.toUpperCase()}_DIGEST`);
    if (imageReference !== `${imageName}@${digest}` || !digestPattern.test(digest)) fail(`${kind} release identity is incomplete.`);
    promoteTag(imageName, digest, context.semver);
    promoteTag(imageName, digest, `sha-${context.sourceRevision}`);
    const semverDigest = inspectDigest(`${imageName}:${context.semver}`);
    const shaDigest = inspectDigest(`${imageName}:sha-${context.sourceRevision}`);
    if (semverDigest !== digest || shaDigest !== digest) fail(`${kind} SemVer/SHA tags do not resolve to the promoted digest.`);
  }
}

async function writeManifest(checksPath, outputDirectory) {
  const context = getReleaseContext();
  const evidenceDirectory = resolve('artifacts/release-evidence');
  const outputRoot = resolve(outputDirectory);
  await mkdir(outputRoot, { recursive: true });
  const requiredCi = JSON.parse(await readFile(checksPath, 'utf8'));
  const contract = await contractMetadata();
  const changelogText = (await readFile('artifacts/release/changelog.md', 'utf8')).trim();
  if (!changelogText) fail('Generated changelog is empty.');

  const images = {};
  for (const kind of ['web', 'api']) {
    const upper = kind.toUpperCase();
    const name = environment(`${upper}_SUBJECT_NAME`);
    const digest = environment(`${upper}_DIGEST`);
    const sbomPath = join(evidenceDirectory, `${kind}-sbom.spdx.json`);
    const provenancePath = join(evidenceDirectory, `${kind}-provenance.slsa.json`);
    const trivyPath = join(evidenceDirectory, `trivy-${kind}.json`);
    const sbom = await readFile(sbomPath);
    const provenance = await readFile(provenancePath);
    const trivyReport = await readFile(trivyPath);
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
        engine: 'Trivy',
        version: '0.76.1',
        severity: ['HIGH', 'CRITICAL'],
        result: 'success',
        report: `trivy-${kind}.json`,
        reportSha256: sha256File(trivyReport),
      },
    };
    await copyFile(trivyPath, join(outputRoot, `trivy-${kind}.json`));
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
  };
  validateManifest(manifest);
  await writeFile(join(outputRoot, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeReleaseLock(manifest, join(outputRoot, 'release-lock.env'));
  await copyFile('artifacts/release/changelog.md', join(outputRoot, 'changelog.md'));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'prepare') await prepare();
    else if (command === 'verify-checks' && args.length === 2) await verifyChecks(args[0], args[1]);
    else if (command === 'resolve-image') await resolveImage();
    else if (command === 'verify-attestations') await verifyAttestations();
    else if (command === 'promote') await promote();
    else if (command === 'write-manifest' && args.length === 2) await writeManifest(args[0], args[1]);
    else fail('Usage: release-pipeline.mjs prepare|verify-checks <input> <output>|resolve-image|verify-attestations|promote|write-manifest <checks> <output-dir>');
  } catch (error) {
    console.error(`M2.09 release gate failed: ${error.message}`);
    process.exitCode = 1;
  }
}

await main();
