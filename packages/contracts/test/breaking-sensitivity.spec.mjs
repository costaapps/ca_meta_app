import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertNoBreakingChanges } from '../scripts/breaking-diff.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
test('breaking checker rejects removal of a public route', () => {
  assert.throws(() => assertNoBreakingChanges(
    path.join(here, 'fixtures/openapi-diff-before.yaml'),
    path.join(here, 'fixtures/openapi-diff-breaking.yaml'),
  ), /Found 1 breaking OpenAPI change\(s\): object_removed \/probe/);
});
