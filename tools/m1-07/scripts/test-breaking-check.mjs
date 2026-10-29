import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoBreakingChanges } from './breaking-diff.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const before = path.resolve(here, '../fixtures/openapi-diff-before.yaml');
const after = path.resolve(here, '../fixtures/openapi-diff-breaking.yaml');
assert.throws(() => assertNoBreakingChanges(before, after), /Found 1 breaking OpenAPI change\(s\): object_removed \/probe/);
console.log('Breaking-change checker correctly rejected the path-removal fixture.');
