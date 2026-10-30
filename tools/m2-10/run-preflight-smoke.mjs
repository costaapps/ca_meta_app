import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateStagingConfiguration } from './preflight.mjs';

const fixtureRoot = resolve('tools/m2-10/fixtures');
const [environmentText, manifestText, lockText] = await Promise.all([
  readFile(resolve(fixtureRoot, 'staging-environment.synthetic.json'), 'utf8'),
  readFile(resolve('tools/m2-09/fixtures/release-manifest.synthetic.json'), 'utf8'),
  readFile(resolve(fixtureRoot, 'release-lock.synthetic.env'), 'utf8'),
]);

const environment = JSON.parse(environmentText);
const manifest = JSON.parse(manifestText);
// M2.09 intentionally binds manifests to SOURCE_REVISION in release workflows.
// This isolated fixture scenario binds to its own synthetic release instead.
process.env.SOURCE_REVISION = manifest.sourceRevision;
const valid = validateStagingConfiguration(environment, manifest, lockText);
if (valid.status !== 'configuration-valid-only' || valid.targetEnvironment !== 'staging' || valid.deploymentReady !== false) {
  throw new Error('Synthetic staging inventory did not remain explicitly non-deployable.');
}

const swappedEnvironment = structuredClone(environment);
swappedEnvironment.targetEnvironment = 'production';
let rejected = false;
try {
  validateStagingConfiguration(swappedEnvironment, manifest, lockText);
} catch {
  rejected = true;
}
if (!rejected) throw new Error('Environment swap to production was not rejected.');

console.log('M2.10 synthetic preflight passed: schema-v3 release binding checked; stage/production resources kept separate; production-target swap rejected.');
console.log('No DNS, TLS, network, Meta, credential, webhook-signature or production operation was performed.');
