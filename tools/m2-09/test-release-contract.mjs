import { readFile } from 'node:fs/promises';
import { validateManifest } from './verify-release-manifest.mjs';

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/release-manifest.synthetic.json', import.meta.url), 'utf8'),
);
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

console.log(cases.join('\n'));
