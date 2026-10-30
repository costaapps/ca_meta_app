import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const requiredChecks = [
  'desktop-candidate',
  'm2-08-mariadb',
  'm2-08-security',
  'm2-08-images',
];
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const imageReferencePattern = /^docker\.io\/[a-z0-9][a-z0-9_-]*\/ca-meta-(?:web|api)@sha256:[0-9a-f]{64}$/;
const workerCommand = [
  'sh',
  '-ec',
  'export API_DATABASE_PASSWORD="$(cat /run/secrets/api_database_password)"; exec node dist/worker/main.js',
];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function requireUrl(value, label) {
  requireValue(typeof value === 'string', `${label} must be a URL.`);
  const parsed = new URL(value);
  requireValue(parsed.protocol === 'https:', `${label} must use HTTPS.`);
}

function validateImage(image, kind, sourceRevision) {
  requireValue(image && typeof image === 'object', `${kind} image is missing.`);
  requireValue(typeof image.name === 'string' && new RegExp(`^docker\\.io\\/[a-z0-9][a-z0-9_-]*\\/ca-meta-${kind}$`).test(image.name), `${kind} image name is invalid.`);
  requireValue(digestPattern.test(image.digest), `${kind} image digest is invalid.`);
  requireValue(image.reference === `${image.name}@${image.digest}`, `${kind} reference must be digest-pinned.`);
  requireValue(imageReferencePattern.test(image.reference), `${kind} registry image reference is invalid.`);
  requireValue(image.sourceRevision === sourceRevision, `${kind} image source revision differs from the manifest SHA.`);
  requireValue(image.buildKitProvenance?.asset === `${kind}-provenance.slsa.json` && /^[0-9a-f]{64}$/.test(image.buildKitProvenance.sha256), `${kind} BuildKit provenance evidence is incomplete.`);
  requireValue(image.attestations && image.attestations.provenance?.verified === true, `${kind} provenance is not verified.`);
  requireValue(image.attestations.provenance.issuer === 'GitHub Actions / Sigstore', `${kind} provenance issuer is invalid.`);
  requireValue(image.attestations.provenance.predicateType === 'https://slsa.dev/provenance/v1', `${kind} provenance predicate type is invalid.`);
  requireUrl(image.attestations.provenance.url, `${kind} provenance URL`);
  const sbom = image.attestations.sbom;
  requireValue(sbom?.verified === true && sbom.issuer === 'GitHub Actions / Sigstore', `${kind} SBOM attestation is not verified.`);
  requireValue(sbom.predicateType === 'https://spdx.dev/Document' && /^SPDX-2\.\d+$/.test(sbom.format), `${kind} SBOM format is invalid.`);
  requireValue(/^[0-9a-f]{64}$/.test(sbom.sha256) && sbom.asset === `${kind}-sbom.spdx.json`, `${kind} SBOM evidence is incomplete.`);
  requireUrl(sbom.url, `${kind} SBOM attestation URL`);
  requireValue(image.scan?.engine === 'Trivy' && image.scan.version === '0.76.1', `${kind} Trivy scan version is invalid.`);
  requireValue(JSON.stringify(image.scan.severity) === JSON.stringify(['HIGH', 'CRITICAL']), `${kind} scan severity policy changed.`);
  requireValue(image.scan.imageReference === image.reference && image.scan.digest === image.digest && image.scan.sourceRevision === sourceRevision, `${kind} scan identity does not match its image digest and source SHA.`);
  requireValue(image.scan.result === 'success' && image.scan.report === `trivy-${kind}.json` && /^[0-9a-f]{64}$/.test(image.scan.reportSha256), `${kind} image scan report is incomplete.`);
}

export function validateManifest(manifest) {
  requireValue(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'Manifest must be a JSON object.');
  requireValue(manifest.manifestVersion === 1, 'Unsupported release manifest version.');
  requireValue(shaPattern.test(manifest.sourceRevision), 'sourceRevision must be a full lowercase Git SHA.');

  const release = manifest.release;
  requireValue(release && typeof release === 'object', 'Release metadata is missing.');
  requireValue(semverPattern.test(release.semver), 'Release SemVer must be a stable major.minor.patch version accepted by release-lock v3.');
  requireValue(release.tag === `v${release.semver}`, 'Git release tag must match the SemVer version.');
  requireValue(release.releaseId === `${release.semver}+${manifest.sourceRevision.slice(0, 12)}`, 'RELEASE_ID must be SemVer plus the first 12 characters of sourceRevision.');
  requireValue(!Number.isNaN(Date.parse(release.createdAt)), 'createdAt must be an ISO date-time.');
  requireUrl(release.workflowRunUrl, 'workflowRunUrl');

  requireValue(manifest.contract?.path === 'docs/meta-v2/contracts/openapi.yaml', 'Contract path is invalid.');
  requireValue(typeof manifest.contract.version === 'string' && manifest.contract.version.length > 0, 'Contract version is missing.');
  requireValue(/^[0-9a-f]{64}$/.test(manifest.contract.sha256), 'Contract SHA256 is invalid.');
  requireValue(manifest.databaseSchema?.version === 3 && manifest.databaseSchema.minCompatible === 3 && manifest.databaseSchema.maxCompatible === 3, 'The release must match the current exact M2.07 schema-v3 compatibility range.');

  validateImage(manifest.images?.web, 'web', manifest.sourceRevision);
  validateImage(manifest.images?.api, 'api', manifest.sourceRevision);
  requireValue(manifest.images.web.name !== manifest.images.api.name, 'Web and API must use distinct repositories.');
  requireValue(manifest.images.web.name.split('/')[1] === manifest.images.api.name.split('/')[1], 'Web and API must use the same Docker Hub namespace.');
  requireValue(manifest.images.web.digest !== manifest.images.api.digest, 'Web and API must have distinct image digests.');
  requireValue(manifest.worker?.image === manifest.images.api.reference, 'Worker must use the exact API image digest.');
  requireValue(JSON.stringify(manifest.worker?.command) === JSON.stringify(workerCommand), 'Worker command differs from the M2.07 Compose contract.');
  requireValue(manifest.worker?.composeService === 'worker', 'Worker Compose service name is invalid.');

  requireValue(Array.isArray(manifest.checks?.requiredCi), 'Required CI evidence is missing.');
  const checks = new Map();
  for (const check of manifest.checks.requiredCi) {
    requireValue(requiredChecks.includes(check.name) && check.conclusion === 'success', 'A required CI check is missing or failed.');
    requireUrl(check.url, `CI check ${check.name} URL`);
    requireValue(!checks.has(check.name), `CI check ${check.name} is duplicated.`);
    checks.set(check.name, check);
  }
  requireValue(requiredChecks.every((name) => checks.has(name)), 'The release is missing one or more M2.08 checks.');
  requireValue(manifest.checks.imageScan?.engine === 'Trivy' && manifest.checks.imageScan.version === '0.76.1', 'Release scan evidence is missing.');
  requireValue(JSON.stringify(manifest.checks.imageScan.severity) === JSON.stringify(['HIGH', 'CRITICAL']), 'Release scan policy changed.');
  requireValue(manifest.checks.imageScan.result === 'success' && manifest.checks.imageScan.reports.length === 2, 'Both image scan reports must be present and successful.');
  requireValue(manifest.changelog && typeof manifest.changelog.markdown === 'string' && manifest.changelog.markdown.trim().length > 0, 'Generated changelog is missing.');
  requireUrl(manifest.changelog.url, 'changelog URL');
  requireValue(manifest.scanEvidence?.asset === 'scan-results.json' && /^[0-9a-f]{64}$/.test(manifest.scanEvidence.sha256), 'The signed scan identity evidence is missing.');

  const serialized = JSON.stringify(manifest);
  requireValue(!/\blatest\b/i.test(serialized), 'Mutable latest tags are prohibited in a release manifest.');
  requireValue(!/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|dckr_pat_[A-Za-z0-9_]{20,})\b/.test(serialized), 'The release manifest appears to contain a credential.');
  if (process.env.SOURCE_REVISION) {
    requireValue(manifest.sourceRevision === process.env.SOURCE_REVISION, 'Manifest source SHA does not match this workflow run.');
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: node tools/m2-09/verify-release-manifest.mjs <manifest.json>');
    process.exit(2);
  }
  try {
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    validateManifest(manifest);
    console.log(`Release manifest accepted: ${manifest.release.releaseId}, source ${manifest.sourceRevision}, web/api digest-pinned, schema v3.`);
  } catch (error) {
    console.error(`Release manifest rejected: ${error.message}`);
    process.exit(1);
  }
}
