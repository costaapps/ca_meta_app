import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expectedScanImagesFromEnvironment, validateScanInputs } from './verify-scan-inputs.mjs';
import { validateScanResults } from './verify-scan-results.mjs';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const root = resolve('artifacts');
const expected = expectedScanImagesFromEnvironment();
const inputs = validateScanInputs(JSON.parse(await readFile(join(root, 'scan-inputs.json'), 'utf8')), expected);
const images = {};
const reportHashes = {};
for (const kind of ['web', 'api']) {
  const report = `trivy-${kind}.json`;
  const reportBytes = await readFile(join(root, 'release-evidence', report));
  JSON.parse(reportBytes.toString('utf8'));
  reportHashes[kind] = sha256(reportBytes);
  images[kind] = {
    subjectName: inputs.images[kind].subjectName,
    imageReference: inputs.images[kind].imageReference,
    digest: inputs.images[kind].digest,
    sourceRevision: inputs.sourceRevision,
    archiveSha256: inputs.images[kind].sha256,
    report,
    reportSha256: reportHashes[kind],
  };
}
const results = {
  version: 1,
  sourceRevision: inputs.sourceRevision,
  policy: { engine: 'Trivy', version: '0.76.1', severity: ['HIGH', 'CRITICAL'], result: 'success' },
  images,
};
validateScanResults(results, expected, reportHashes);
await writeFile(join(root, 'release-evidence', 'scan-results.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
console.log(`Recorded Trivy report identities for source ${inputs.sourceRevision}.`);
