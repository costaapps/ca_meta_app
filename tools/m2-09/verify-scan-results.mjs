import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expectedScanImagesFromEnvironment, validateScanInputs } from './verify-scan-inputs.mjs';

function reject(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function validateScanResults(results, expected, reportHashes = undefined) {
  if (!results || typeof results !== 'object' || Array.isArray(results) || results.version !== 1 || results.sourceRevision !== expected?.sourceRevision) {
    reject('Scan results version or source SHA does not match the build outputs.');
  }
  if (results.policy?.engine !== 'Trivy' || results.policy.version !== '0.76.1' || JSON.stringify(results.policy.severity) !== JSON.stringify(['HIGH', 'CRITICAL']) || results.policy.result !== 'success') {
    reject('Scan results do not record the required successful Trivy policy.');
  }

  let namespace;
  for (const kind of ['web', 'api']) {
    const actual = results.images?.[kind];
    const target = expected.images?.[kind];
    const targetNamespace = target?.subjectName?.split('/')[1];
    if (!target || !/^[a-z0-9][a-z0-9_-]*$/.test(targetNamespace ?? '') || target.subjectName !== `docker.io/${targetNamespace}/ca-meta-${kind}` || target.imageReference !== `${target.subjectName}@${target.digest}` || !/^sha256:[0-9a-f]{64}$/.test(target.digest ?? '')) {
      reject(`Build output ${kind} image identity is invalid.`);
    }
    if (!actual || !target || actual.subjectName !== target.subjectName || actual.imageReference !== target.imageReference || actual.digest !== target.digest || actual.sourceRevision !== expected.sourceRevision) {
      reject(`${kind} scan report identity does not match the image name, reference and digest outputs from build-images.`);
    }
    if (!/^[0-9a-f]{64}$/.test(actual.archiveSha256 ?? '') || actual.report !== `trivy-${kind}.json` || !/^[0-9a-f]{64}$/.test(actual.reportSha256 ?? '')) {
      reject(`${kind} scan report evidence is incomplete.`);
    }
    const imageNamespace = actual.subjectName.split('/')[1];
    if (namespace && imageNamespace !== namespace) reject('Web and API scan reports use different Docker Hub namespaces.');
    namespace = imageNamespace;
    if (reportHashes && reportHashes[kind] !== actual.reportSha256) reject(`${kind} scan report checksum does not match scan-results.json.`);
  }
  return results;
}

async function main() {
  const directory = resolve(process.argv[2] ?? '');
  if (process.argv.length < 3) reject('Usage: node tools/m2-09/verify-scan-results.mjs <artifact-directory>');
  const expected = expectedScanImagesFromEnvironment();
  const inputs = validateScanInputs(JSON.parse(await readFile(join(directory, 'scan-inputs.json'), 'utf8')), expected);
  const reportsDirectory = join(directory, 'release-evidence');
  const reportHashes = {};
  const reportBytes = {};
  for (const kind of ['web', 'api']) {
    reportBytes[kind] = await readFile(join(reportsDirectory, `trivy-${kind}.json`));
    JSON.parse(reportBytes[kind].toString('utf8'));
    reportHashes[kind] = sha256(reportBytes[kind]);
  }
  const results = JSON.parse(await readFile(join(reportsDirectory, 'scan-results.json'), 'utf8'));
  validateScanResults(results, expected, reportHashes);
  for (const kind of ['web', 'api']) {
    if (results.images[kind].archiveSha256 !== inputs.images[kind].sha256) reject(`${kind} scan report does not identify the verified build archive.`);
  }
  console.log(`Trivy reports verified against build outputs for source ${expected.sourceRevision}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(`Scan results rejected: ${error.message}`);
    process.exit(1);
  }
}
