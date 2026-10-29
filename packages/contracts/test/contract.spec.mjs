import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ERROR_CODES } from '../src/generated/error-codes.mjs';
import { ERROR_POLICIES } from '../src/generated/error-policies.mjs';
import { generatedTextMatches } from '../../../tools/shared/generated-text.mjs';
import runtime from '../src/runtime.cjs';

const { isErrorCode, validateErrorEnvelope } = runtime;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const packageRoot = path.join(root, 'packages/contracts');
const canonicalRoot = path.join(root, 'docs/meta-v2/contracts');
const contract = YAML.parse(await readFile(path.join(canonicalRoot, 'openapi.yaml'), 'utf8'));

test('published error catalog excludes internal codes and event schema copies match canonical sources', async () => {
  const canonicalCatalog = await readFile(path.join(canonicalRoot, 'error-catalog.md'), 'utf8');
  const publicCatalog = await readFile(path.join(packageRoot, 'error-catalog.md'), 'utf8');
  const expectedPublicCatalog = canonicalCatalog.split(/\r?\n/).filter((line) => {
    const code = line.match(/^\|\s*`([^`]+)`\s*\|/)?.[1];
    return code !== 'INTERNAL_SCOPE_DENIED';
  }).join('\n');
  assert.match(canonicalCatalog, /`INTERNAL_SCOPE_DENIED`/);
  assert.doesNotMatch(publicCatalog, /INTERNAL_SCOPE_DENIED/);
  assert.ok(generatedTextMatches(publicCatalog, expectedPublicCatalog),
    'public catalog should differ only by internal-code rows');

  for (const file of [
    'events/inbox-event.schema.json',
    'events/outbox-event.schema.json',
  ]) {
    assert.ok(generatedTextMatches(
      await readFile(path.join(packageRoot, file), 'utf8'),
      await readFile(path.join(canonicalRoot, file), 'utf8'),
    ), `${file} is stale; regenerate @ca-meta/contracts`);
  }
});

test('public OpenAPI, generated types, constants, policy and runtime schema omit internal-only errors', async () => {
  const publicDocument = YAML.parse(await readFile(path.join(packageRoot, 'openapi.yaml'), 'utf8'));
  const canonicalCodes = contract.components.schemas.ErrorEnvelope.properties.code.enum;
  const publicCodes = publicDocument.components.schemas.ErrorEnvelope.properties.code.enum;
  const runtimeSchemas = JSON.parse(await readFile(path.join(packageRoot, 'src/generated/runtime-schemas.json'), 'utf8'));
  const generatedTypes = await readFile(path.join(packageRoot, 'src/generated/openapi.d.ts'), 'utf8');

  assert.ok(canonicalCodes.includes('INTERNAL_SCOPE_DENIED'));
  assert.ok(!publicCodes.includes('INTERNAL_SCOPE_DENIED'));
  assert.ok(!ERROR_CODES.includes('INTERNAL_SCOPE_DENIED'));
  assert.ok(!Object.hasOwn(ERROR_POLICIES, 'INTERNAL_SCOPE_DENIED'));
  assert.ok(!runtimeSchemas.ErrorEnvelope.properties.code.enum.includes('INTERNAL_SCOPE_DENIED'));
  assert.doesNotMatch(generatedTypes, /INTERNAL_SCOPE_DENIED/);
  assert.equal(isErrorCode('INTERNAL_SCOPE_DENIED'), false);
  assert.equal(validateErrorEnvelope({
    code: 'INTERNAL_SCOPE_DENIED',
    safeMessage: 'Internal authorization is unavailable.',
    requestId: 'req_internal_scope',
    retryable: false,
    action: 'CONTACT_ADMIN',
  }), false);
});

test('every documented ErrorEnvelope example validates and fixed code policies hold', () => {
  const examples = [];
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    if (typeof value.code === 'string' && 'requestId' in value && 'safeMessage' in value) examples.push(value);
    Object.values(value).forEach(visit);
  };
  visit(contract.paths);
  visit(contract.components.responses);
  assert.ok(examples.length >= 10, `Expected API error examples, found ${examples.length}`);
  for (const example of examples) assert.equal(validateErrorEnvelope(example), true, JSON.stringify(example));

  const policies = contract.components.schemas.ErrorEnvelope['x-error-policy-by-code'];
  for (const [code, policy] of Object.entries(policies)) {
    const matching = examples.filter((example) => example.code === code);
    assert.ok(matching.length > 0, `Missing example for fixed error policy ${code}`);
    for (const example of matching) {
      assert.equal(example.retryable, policy.retryable, `${code} retryability mismatch`);
      assert.equal(example.action, policy.action, `${code} action mismatch`);
    }
  }
});

test('synthetic error fixtures validate against the public runtime schema', async () => {
  for (const file of ['host-not-allowed.json', 'internal-error.json']) {
    const fixture = JSON.parse(await readFile(path.join(packageRoot, 'fixtures/errors', file), 'utf8'));
    assert.equal(validateErrorEnvelope(fixture), true, file);
  }
});

test('public DTO schemas and event contracts exclude tenant authority and credential fields', async () => {
  const publicDocument = YAML.parse(await readFile(path.join(packageRoot, 'openapi.yaml'), 'utf8'));
  const eventSchemas = await Promise.all(['inbox-event.schema.json', 'outbox-event.schema.json']
    .map(async (file) => JSON.parse(await readFile(path.join(packageRoot, 'events', file), 'utf8'))));
  const eventFixtures = await Promise.all(['inbox-event.json', 'outbox-event.json']
    .map(async (file) => JSON.parse(await readFile(path.join(packageRoot, 'fixtures/events', file), 'utf8'))));
  const forbidden = new Set([
    'company_uuid', 'access_token', 'refresh_token', 'ciphertext', 'client_secret', 'appsecret_proof',
  ]);
  const propertyNames = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    if (value.properties && typeof value.properties === 'object') {
      for (const [name, child] of Object.entries(value.properties)) {
        propertyNames.add(name.toLowerCase());
        visit(child);
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(publicDocument.components.schemas);
  for (const eventSchema of eventSchemas) visit(eventSchema);
  assert.deepEqual([...propertyNames].filter((name) => forbidden.has(name)).sort(), []);

  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const [index, eventSchema] of eventSchemas.entries()) {
    const validate = ajv.compile(eventSchema);
    assert.ok(Array.isArray(eventSchema.examples) && eventSchema.examples.length > 0, 'event schema must ship safe fixtures');
    for (const fixture of eventSchema.examples) assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
    assert.equal(validate(eventFixtures[index]), true, JSON.stringify(validate.errors));
  }

  const generatedTypes = await readFile(path.join(packageRoot, 'src/generated/openapi.d.ts'), 'utf8');
  assert.doesNotMatch(generatedTypes, /\/internal\/v1\/assets\/\{assetId\}\/operations|InternalAssetOperationRequest/);
  assert.doesNotMatch(generatedTypes, /readonly (?:company_uuid|access_token|refresh_token|client_secret|appsecret_proof|ciphertext)\s*:/i);
});
