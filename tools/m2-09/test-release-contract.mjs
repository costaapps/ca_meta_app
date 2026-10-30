import { readFile } from 'node:fs/promises';
import { validateManifest } from './verify-release-manifest.mjs';
import { validateScanInputs } from './verify-scan-inputs.mjs';
import { validateScanResults } from './verify-scan-results.mjs';

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/release-manifest.synthetic.json', import.meta.url), 'utf8'),
);
const scanInputsFixture = JSON.parse(
  await readFile(new URL('./fixtures/scan-inputs.synthetic.json', import.meta.url), 'utf8'),
);
const scanResultsFixture = JSON.parse(
  await readFile(new URL('./fixtures/scan-results.synthetic.json', import.meta.url), 'utf8'),
);
const expectedScan = {
  sourceRevision: scanInputsFixture.sourceRevision,
  images: Object.fromEntries(['web', 'api'].map((kind) => [kind, {
    subjectName: scanInputsFixture.images[kind].subjectName,
    imageReference: scanInputsFixture.images[kind].imageReference,
    digest: scanInputsFixture.images[kind].digest,
  }])),
};
const scanReportHashes = Object.fromEntries(['web', 'api'].map((kind) => [kind, scanResultsFixture.images[kind].reportSha256]));
const cases = [];

function expectPass(name, action) {
  action();
  cases.push(`${name}: PASS`);
}

function expectReject(name, action, expectedText) {
  try {
    action();
  } catch (error) {
    if (!error.message.includes(expectedText)) {
      throw new Error(`${name} rejected for an unexpected reason: ${error.message}`);
    }
    cases.push(`${name}: PASS (rejected)`);
    return;
  }
  throw new Error(`${name} was incorrectly accepted.`);
}

expectPass('complete synthetic manifest', () => validateManifest(structuredClone(fixture)));
expectReject(
  'partial API publication cannot produce a complete manifest',
  () => {
    const partial = structuredClone(fixture);
    partial.images.api = null;
    validateManifest(partial);
  },
  'api image is missing',
);
expectReject(
  'images from different source commits are rejected',
  () => {
    const mixed = structuredClone(fixture);
    mixed.images.api.sourceRevision = 'fedcba9876543210fedcba9876543210fedcba98';
    validateManifest(mixed);
  },
  'api image source revision differs',
);
expectReject(
  'mutable latest tag is rejected',
  () => {
    const mutable = structuredClone(fixture);
    mutable.images.web.reference = 'docker.io/synthetic/ca-meta-web:latest';
    validateManifest(mutable);
  },
  'reference must be digest-pinned',
);
expectPass('scan inputs match build image outputs', () => validateScanInputs(structuredClone(scanInputsFixture), expectedScan));
expectPass('scan reports match build image outputs', () => validateScanResults(structuredClone(scanResultsFixture), expectedScan, scanReportHashes));
expectReject(
  'divergent API digest cannot be scanned as the build output',
  () => {
    const divergent = structuredClone(scanInputsFixture);
    divergent.images.api.digest = 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    divergent.images.api.imageReference = `${divergent.images.api.subjectName}@${divergent.images.api.digest}`;
    validateScanInputs(divergent, expectedScan);
  },
  'api scan archive identity does not match',
);
expectReject(
  'divergent API namespace cannot be scanned as the build output',
  () => {
    const divergent = structuredClone(scanInputsFixture);
    divergent.images.api.subjectName = 'docker.io/other-namespace/ca-meta-api';
    divergent.images.api.imageReference = `${divergent.images.api.subjectName}@${divergent.images.api.digest}`;
    validateScanInputs(divergent, expectedScan);
  },
  'api scan archive identity does not match',
);
expectReject(
  'scan result digest must match the build output',
  () => {
    const divergent = structuredClone(scanResultsFixture);
    divergent.images.web.digest = 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    validateScanResults(divergent, expectedScan, scanReportHashes);
  },
  'web scan report identity does not match',
);

console.log(cases.join('\n'));
