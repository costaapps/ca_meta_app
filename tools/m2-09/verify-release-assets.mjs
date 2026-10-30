import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { validateManifest } from './verify-release-manifest.mjs';
import { validateScanResults } from './verify-scan-results.mjs';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const directory = resolve(process.argv[2] ?? '');
if (process.argv.length < 3) {
  console.error('Usage: node tools/m2-09/verify-release-assets.mjs <release-assets-directory>');
  process.exit(2);
}
const expectedManifestPath = process.argv[3] ? resolve(process.argv[3]) : undefined;

try {
  const manifest = JSON.parse(await readFile(join(directory, 'release-manifest.json'), 'utf8'));
  validateManifest(manifest);
  if (expectedManifestPath) {
    const expected = JSON.parse(await readFile(expectedManifestPath, 'utf8'));
    validateManifest(expected);
    const comparable = (candidate) => {
      const result = structuredClone(candidate);
      delete result.release.createdAt;
      delete result.release.workflowRunUrl;
      delete result.changelog;
      for (const kind of ['web', 'api']) {
        delete result.images[kind].attestations.provenance.url;
        delete result.images[kind].attestations.sbom.url;
      }
      return result;
    };
    if (JSON.stringify(comparable(manifest)) !== JSON.stringify(comparable(expected))) {
      throw new Error('Existing signed release manifest disagrees with the images, contract, scan reports or schema in this retry.');
    }
  }
  if (process.env.SOURCE_REVISION && manifest.sourceRevision !== process.env.SOURCE_REVISION) {
    throw new Error('Release asset source SHA does not match this workflow run.');
  }

  const reportHashes = {};
  for (const kind of ['web', 'api']) {
    const image = manifest.images[kind];
    const sbom = await readFile(join(directory, image.attestations.sbom.asset));
    const provenance = await readFile(join(directory, image.buildKitProvenance.asset));
    if (sha256(sbom) !== image.attestations.sbom.sha256) throw new Error(`${kind} SBOM asset checksum does not match the signed manifest.`);
    if (sha256(provenance) !== image.buildKitProvenance.sha256) throw new Error(`${kind} BuildKit provenance asset checksum does not match the signed manifest.`);
    const report = await readFile(join(directory, image.scan.report));
    if (sha256(report) !== image.scan.reportSha256) throw new Error(`${kind} Trivy report checksum does not match the signed manifest.`);
    JSON.parse(report.toString('utf8'));
    reportHashes[kind] = sha256(report);
  }
  const scanEvidence = await readFile(join(directory, manifest.scanEvidence.asset));
  if (sha256(scanEvidence) !== manifest.scanEvidence.sha256) throw new Error('Scan identity evidence checksum does not match the signed manifest.');
  const scanResults = JSON.parse(scanEvidence.toString('utf8'));
  validateScanResults(scanResults, {
    sourceRevision: manifest.sourceRevision,
    images: Object.fromEntries(['web', 'api'].map((kind) => [kind, {
      subjectName: manifest.images[kind].name,
      imageReference: manifest.images[kind].reference,
      digest: manifest.images[kind].digest,
    }])),
  }, reportHashes);
  const lock = new Map();
  for (const line of (await readFile(join(directory, 'release-lock.env'), 'utf8')).split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith('#')) continue;
    const separator = entry.indexOf('=');
    if (separator < 1) throw new Error('Release lock has a malformed entry.');
    const key = entry.slice(0, separator).trim();
    if (lock.has(key)) throw new Error(`Release lock repeats ${key}.`);
    lock.set(key, entry.slice(separator + 1).trim());
  }
  const expectedLock = {
    RELEASE_ID: manifest.release.releaseId,
    SOURCE_REVISION: manifest.sourceRevision,
    CA_META_WEB_IMAGE: manifest.images.web.reference,
    CA_META_API_IMAGE: manifest.images.api.reference,
    WEB_SOURCE_REVISION: manifest.images.web.sourceRevision,
    API_SOURCE_REVISION: manifest.images.api.sourceRevision,
    SCHEMA_VERSION: String(manifest.databaseSchema.version),
    SCHEMA_MIN_COMPATIBLE: String(manifest.databaseSchema.minCompatible),
    SCHEMA_MAX_COMPATIBLE: String(manifest.databaseSchema.maxCompatible),
  };
  for (const [key, value] of Object.entries(expectedLock)) {
    if (lock.get(key) !== value) throw new Error(`Release lock ${key} does not match the signed manifest.`);
  }
  console.log(`Release assets verified: ${manifest.release.releaseId}, ${manifest.sourceRevision}.`);
} catch (error) {
  console.error(`Release assets rejected: ${error.message}`);
  process.exit(1);
}
