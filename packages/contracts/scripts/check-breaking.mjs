import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoBreakingChanges } from './breaking-diff.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
assertNoBreakingChanges(
  path.join(root, 'docs/meta-v2/contracts/openapi-v1.baseline.yaml'),
  path.join(root, 'docs/meta-v2/contracts/openapi.yaml'),
);
console.log('No breaking changes against the frozen proposed v1 contract.');
