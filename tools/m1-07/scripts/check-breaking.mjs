import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoBreakingChanges } from './breaking-diff.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const baseline = path.join(root, 'docs/meta-v2/contracts/openapi-v1.baseline.yaml');
const current = path.join(root, 'docs/meta-v2/contracts/openapi.yaml');
assertNoBreakingChanges(baseline, current);
console.log('No breaking changes against the frozen proposed v1 contract.');
