import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import YAML from 'yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const contractPath = path.join(root, 'docs/meta-v2/contracts/openapi.yaml');
const contract = YAML.parse(await readFile(contractPath, 'utf8'));
const eventPaths = [
  path.join(root, 'docs/meta-v2/contracts/events/inbox-event.schema.json'),
  path.join(root, 'docs/meta-v2/contracts/events/outbox-event.schema.json'),
];

function inlineSchema(schema, stack = []) {
  if (Array.isArray(schema)) return schema.map((entry) => inlineSchema(entry, stack));
  if (!schema || typeof schema !== 'object') return schema;
  if (typeof schema.$ref === 'string') {
    const match = schema.$ref.match(/^#\/components\/schemas\/([^/]+)$/);
    assert.ok(match, `Unsupported schema reference: ${schema.$ref}`);
    const name = match[1];
    assert.ok(!stack.includes(name), `Recursive contract schema is not supported in this harness: ${name}`);
    return inlineSchema(contract.components.schemas[name], [...stack, name]);
  }
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, inlineSchema(value, stack)]));
}

function resolveResponse(response, stack = []) {
  if (typeof response?.$ref !== 'string') return response;
  const match = response.$ref.match(/^#\/components\/responses\/([^/]+)$/);
  assert.ok(match, `Unsupported response reference: ${response.$ref}`);
  const name = match[1];
  assert.ok(!stack.includes(name), `Recursive response reference: ${name}`);
  return resolveResponse(contract.components.responses[name], [...stack, name]);
}

function resolveParameter(parameter) {
  if (typeof parameter?.$ref !== 'string') return parameter;
  const match = parameter.$ref.match(/^#\/components\/parameters\/([^/]+)$/);
  assert.ok(match, `Unsupported parameter reference: ${parameter.$ref}`);
  return contract.components.parameters[match[1]];
}

function operationList() {
  const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
  return Object.entries(contract.paths).flatMap(([route, item]) => Object.entries(item)
    .filter(([method]) => methods.has(method))
    .map(([method, operation]) => ({ route, method, operation })));
}

function collectSchemaPropertyNames(schema, result = new Set(), seen = new Set()) {
  if (!schema || typeof schema !== 'object') return result;
  if (typeof schema.$ref === 'string') {
    if (seen.has(schema.$ref)) return result;
    seen.add(schema.$ref);
    const match = schema.$ref.match(/^#\/components\/schemas\/([^/]+)$/);
    if (match) collectSchemaPropertyNames(contract.components.schemas[match[1]], result, seen);
    return result;
  }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [name, child] of Object.entries(schema.properties)) {
      result.add(name);
      collectSchemaPropertyNames(child, result, seen);
    }
  }
  if (schema.items) collectSchemaPropertyNames(schema.items, result, seen);
  for (const branch of [...(schema.oneOf ?? []), ...(schema.anyOf ?? []), ...(schema.allOf ?? [])]) {
    collectSchemaPropertyNames(branch, result, seen);
  }
  return result;
}

test('OpenAPI has explicit root-host routes, deny-by-default security and no duplicate operation IDs', () => {
  assert.equal(contract.openapi, '3.1.0');
  assert.equal(contract.servers[0].url, 'https://api.example.invalid');
  assert.deepEqual(contract.security, [{ portalSession: [] }]);
  assert.ok(contract.paths['/api/v1/auth/exchanges']);
  assert.ok(contract.paths['/internal/v1/assets/{assetId}/operations']);
  assert.ok(contract.paths['/health']);
  assert.ok(contract.paths['/ready']);
  assert.deepEqual(contract.paths['/internal/v1/assets/{assetId}/operations'].post['x-internal-authorization'], {
    requiredClaims: ['service_id', 'tenant_ref', 'asset_ref', 'operation'],
    audience: 'msg4-meta-internal',
    bindings: {
      tenant_ref: 'tenant owning the asset identified by path.assetId',
      asset_ref: 'path.assetId',
      operation: 'requestBody.kind',
    },
    enforceCurrentTenantGrant: true,
    allowlist: ['SEND_REPLY', 'MARK_READ', 'REFRESH_STATUS'],
  });

  const operations = operationList();
  const ids = operations.map(({ operation }) => operation.operationId);
  assert.equal(new Set(ids).size, ids.length, 'operationId values must be unique');
  const publicPairs = new Set(contract['x-public-routes'].map(({ method, path: route }) => `${method.toLowerCase()} ${route}`));
  for (const entry of contract['x-public-routes']) {
    assert.ok(contract.paths[entry.path]?.[entry.method.toLowerCase()], `listed public route is missing: ${entry.method} ${entry.path}`);
  }
  for (const { route, method, operation } of operations) {
    const pair = `${method} ${route}`;
    if (operation.tags.includes('Internal Operations')) {
      assert.deepEqual(operation.security, [{ internalServiceAuth: [] }], `${pair} must require the internal service scope`);
    } else if (publicPairs.has(pair)) {
      assert.ok(Array.isArray(operation.security), `${pair} must explicitly declare public/pre-auth security`);
      assert.ok(operation.security.length === 0 || operation.security.every((requirement) => 'preAuthCookie' in requirement), `${pair} may not inherit portal session auth or use an undeclared public bypass`);
    } else {
      assert.deepEqual(operation.security, [{ portalSession: [] }], `${pair} must require a portal session`);
    }
  }
});

test('every request, success and reusable error example validates against its JSON Schema', async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  let checked = 0;
  const validateExamples = (schema, examples, context) => {
    assert.ok(schema, `${context} must have a schema`);
    assert.ok(examples && Object.keys(examples).length > 0, `${context} must have at least one sanitized example`);
    const validate = ajv.compile(inlineSchema(schema));
    for (const [name, example] of Object.entries(examples)) {
      assert.ok(Object.hasOwn(example, 'value'), `${context}/${name} must be an inline example`);
      const valid = validate(example.value);
      assert.ok(valid, `${context}/${name} failed: ${JSON.stringify(validate.errors)}`);
      checked += 1;
    }
  };

  for (const { route, method, operation } of operationList()) {
    if (operation.requestBody) {
      for (const [media, content] of Object.entries(operation.requestBody.content ?? {})) {
        validateExamples(content.schema, content.examples, `${method.toUpperCase()} ${route} request ${media}`);
      }
    }
    for (const [status, reference] of Object.entries(operation.responses)) {
      const response = resolveResponse(reference);
      for (const [media, content] of Object.entries(response.content ?? {})) {
        if (content.schema && content.examples) validateExamples(content.schema, content.examples, `${method.toUpperCase()} ${route} ${status} ${media}`);
      }
    }
  }

  for (const eventPath of eventPaths) {
    const schema = JSON.parse(await readFile(eventPath, 'utf8'));
    const validate = ajv.compile(schema);
    assert.ok(Array.isArray(schema.examples) && schema.examples.length > 0, `${path.basename(eventPath)} needs a sanitized example`);
    const payloadSchema = schema.$id.endsWith(':inbox-event:v1') ? schema.properties.safeMetadata : schema.properties.data;
    const payloadKinds = payloadSchema.oneOf.map((variant) => variant.properties.kind.const).sort();
    const eventTypeKinds = schema.allOf.filter((rule) => rule.if.properties.eventType).map((rule) => {
      const eventType = rule.if.properties.eventType.const;
      const kind = rule.then.properties[schema.$id.endsWith(':inbox-event:v1') ? 'safeMetadata' : 'data'].properties.kind.const;
      assert.ok(schema.properties.eventType.enum.includes(eventType), `${eventType} is listed in eventType`);
      return [eventType, kind];
    });
    assert.equal(eventTypeKinds.length, schema.properties.eventType.enum.length, `${path.basename(eventPath)} maps every eventType`);
    assert.equal(new Set(eventTypeKinds.map(([eventType]) => eventType)).size, schema.properties.eventType.enum.length, `${path.basename(eventPath)} maps each eventType once`);
    assert.deepEqual(eventTypeKinds.map(([eventType]) => eventType).sort(), [...schema.properties.eventType.enum].sort());
    assert.deepEqual(eventTypeKinds.map(([, kind]) => kind).sort(), payloadKinds, `${path.basename(eventPath)} maps every payload kind exactly once`);
    for (const [index, example] of schema.examples.entries()) {
      const valid = validate(example);
      assert.ok(valid, `${path.basename(eventPath)} example ${index} failed: ${JSON.stringify(validate.errors)}`);
      checked += 1;
    }
    const mismatched = structuredClone(schema.examples[0]);
    if (schema.$id.endsWith(':inbox-event:v1')) mismatched.eventType = 'provider.authorization.changed';
    else mismatched.eventType = 'onboarding.changed';
    assert.equal(validate(mismatched), false, `${path.basename(eventPath)} must reject eventType/kind mismatches`);
    if (schema.$id.endsWith(':inbox-event:v1')) {
      const unclassified = schema.examples.find((example) => example.eventType === 'provider.unclassified');
      assert.ok(unclassified, 'inbox schema includes a quarantined unclassified event example');
      assert.equal(validate(unclassified), true, 'unclassified inbox events remain safely representable');
      const knownRoutedWithoutTenant = structuredClone(schema.examples.find((example) => example.eventType === 'provider.message.received'));
      knownRoutedWithoutTenant.routingState = 'ROUTED';
      knownRoutedWithoutTenant.tenantRef = null;
      assert.equal(validate(knownRoutedWithoutTenant), false, 'routed inbox events must resolve exactly one tenant');
      const correctlyRouted = structuredClone(knownRoutedWithoutTenant);
      correctlyRouted.tenantRef = 'tenant_example_01';
      assert.equal(validate(correctlyRouted), true, 'routed inbox items carry their server-resolved tenant');
      const pendingWithTenant = structuredClone(schema.examples.find((example) => example.eventType === 'provider.message.received'));
      pendingWithTenant.tenantRef = 'tenant_example_01';
      assert.equal(validate(pendingWithTenant), false, 'pending inbox items must not carry a tenant before routing');
      const incorrectlyRouted = structuredClone(unclassified);
      incorrectlyRouted.routingState = 'ROUTED';
      incorrectlyRouted.tenantRef = 'tenant_example_01';
      assert.equal(validate(incorrectlyRouted), false, 'unclassified inbox events must remain quarantined without a tenant');
    }
  }
  assert.ok(checked >= 60, `expected a broad request/success/error fixture set, checked ${checked}`);
});

test('public success DTOs and event envelopes contain no credential or raw message fields', async () => {
  const forbiddenProperty = /^(?:accessToken|refreshToken|token|secret|clientSecret|appSecret|ciphertext|authorizationCode|sessionCookie|providerPayload|rawPayload|messageText|messageBody|bodyText)$/i;
  const checkedProperties = new Set();
  for (const { route, method, operation } of operationList()) {
    for (const [status, responseRef] of Object.entries(operation.responses)) {
      const response = resolveResponse(responseRef);
      for (const content of Object.values(response.content ?? {})) {
        if (!content.schema) continue;
        for (const name of collectSchemaPropertyNames(content.schema)) checkedProperties.add(name);
      }
    }
  }
  for (const name of checkedProperties) assert.doesNotMatch(name, forbiddenProperty, `unsafe response DTO field: ${name}`);

  for (const eventPath of eventPaths) {
    const schema = JSON.parse(await readFile(eventPath, 'utf8'));
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        assert.doesNotMatch(key, forbiddenProperty, `unsafe event field: ${key}`);
        visit(value);
      }
    };
    visit(schema);
  }

  const authExchange = contract.paths['/api/v1/auth/exchanges'].post;
  const providerCode = contract.paths['/api/v1/onboarding-sessions/{onboardingSessionId}/authorization-code'].post;
  assert.ok(authExchange.requestBody.content['application/json'].schema.$ref.endsWith('/PortalEntryExchangeRequest'));
  assert.ok(providerCode.requestBody.content['application/json'].schema.$ref.endsWith('/ProviderAuthorizationCodeRequest'));
  assert.ok(!Object.hasOwn(contract.components.schemas.OnboardingCreateRequest.properties, 'company_uuid'));
});

test('safe error catalog and OpenAPI error-code enum stay in lockstep', async () => {
  const catalog = await readFile(path.join(root, 'docs/meta-v2/contracts/error-catalog.md'), 'utf8');
  const documented = [...catalog.matchAll(/^\|\s+`([A-Z_]+)`\s+\|/gm)].map((match) => match[1]).sort();
  const schema = contract.components.schemas.ErrorEnvelope.properties.code.enum.slice().sort();
  assert.deepEqual(documented, schema);
  assert.ok(documented.includes('FLOW_NOT_ELIGIBLE'));
  assert.ok(documented.includes('META_UNAVAILABLE'));

  const validateError = new Ajv2020({ allErrors: true, strict: false }).compile(inlineSchema(contract.components.schemas.ErrorEnvelope));
  const errorPolicy = contract.components.schemas.ErrorEnvelope['x-error-policy-by-code'];
  const validatesErrorContract = (envelope) => {
    if (!validateError(envelope)) return false;
    const policy = errorPolicy[envelope.code];
    return !policy || (envelope.retryable === policy.retryable && envelope.action === policy.action);
  };
  const safeEnvelope = { safeMessage: 'The operation could not be confirmed yet.', requestId: 'req_example_99' };
  for (const [code, action] of [['OUTCOME_UNKNOWN', 'CHECK_STATUS'], ['IDEMPOTENCY_KEY_REUSED', 'USE_NEW_REQUEST_KEY']]) {
    const valid = { ...safeEnvelope, code, retryable: false, action };
    assert.deepEqual(errorPolicy[code], { retryable: false, action });
    assert.equal(validatesErrorContract(valid), true, `${code} safe envelope is valid`);
    assert.equal(validatesErrorContract({ ...valid, retryable: true }), false, `${code} must not be retryable`);
    assert.equal(validatesErrorContract({ ...valid, action: 'REFRESH' }), false, `${code} must use ${action}`);
  }
});

test('compatibility matrix accounts for every sanitized baseline row exactly once', async () => {
  const readCsv = async (file) => {
    const text = await readFile(file, 'utf8');
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quoted && char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = !quoted;
      else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
      else if (char === '\n' && !quoted) { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
      else cell += char;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const [header, ...data] = rows;
    return data.filter((values) => values.length).map((values) => Object.fromEntries(header.map((name, index) => [name, values[index] ?? ''])));
  };
  const baseline = await readCsv(path.join(root, 'docs/baseline/endpoint-matrix.csv'));
  const matrix = await readCsv(path.join(root, 'docs/meta-v2/contracts/compatibility-matrix.csv'));
  assert.equal(baseline.length, 53);
  assert.equal(matrix.length, baseline.length);
  assert.equal(new Set(matrix.map((row) => row.matrix_row)).size, baseline.length);
  for (let index = 0; index < baseline.length; index += 1) {
    assert.equal(matrix[index].matrix_row, String(index + 1));
    for (const [sourceField, targetField] of [['kind', 'source_kind'], ['method', 'source_method'], ['path_or_symbol', 'source_path_or_symbol'], ['source_file', 'source_file'], ['source_symbol', 'source_symbol']]) {
      assert.equal(matrix[index][targetField], baseline[index][sourceField], `baseline row ${index + 1} ${sourceField} mismatch`);
    }
    for (const field of ['v1_operation', 'v1_target', 'compatibility_policy', 'next_gate', 'evidence_limit']) assert.ok(matrix[index][field], `baseline row ${index + 1} has no ${field}`);
  }
  const drift = matrix.find((row) => row.compatibility_policy === 'exclude-not-confirmed');
  assert.ok(drift);
  assert.match(drift.evidence_limit, /Not confirmed/);

  const templateRows = matrix.filter((row) => row.source_path_or_symbol === '/whatsapp/templates');
  assert.ok(templateRows.length > 0, 'baseline includes WhatsApp template operations');
  for (const row of templateRows) {
    const expected = row.source_method === 'GET'
      ? ['listTemplates', 'GET /api/v1/whatsapp/accounts/{assetId}/templates']
      : row.source_method === 'POST'
        ? ['createTemplate', 'POST /api/v1/whatsapp/accounts/{assetId}/templates']
        : null;
    assert.ok(expected, `unexpected method for ${row.source_kind} ${row.source_path_or_symbol}: ${row.source_method}`);
    assert.deepEqual(
      [row.v1_operation, row.v1_target],
      expected,
      `${row.source_kind} ${row.source_method} ${row.source_path_or_symbol} must map by HTTP method`,
    );
  }
});

test('contract has bounded pagination, ETag preconditions and 202 Location for accepted jobs', () => {
  const listOperations = ['listConnections', 'listAssets', 'listTemplates', 'listNotifications'];
  for (const id of listOperations) {
    const operation = operationList().find((entry) => entry.operation.operationId === id).operation;
    const parameterNames = operation.parameters.map(resolveParameter).map((parameter) => parameter.name);
    assert.ok(parameterNames.includes('cursor'), `${id} has a cursor`);
    assert.ok(parameterNames.includes('limit'), `${id} has a limit`);
    assert.equal(contract.components.parameters.Limit.schema.maximum, 100);
  }
  const config = contract.paths['/api/v1/assets/{assetId}/automation-config'];
  assert.ok(config.get.responses['200'].headers.ETag);
  assert.ok(config.put.parameters.map(resolveParameter).some((parameter) => parameter.name === 'If-Match'));
  for (const { route, method, operation } of operationList()) {
    for (const [status, responseRef] of Object.entries(operation.responses)) {
      if (status !== '202') continue;
      const response = resolveResponse(responseRef);
      if (response.content?.['application/json']?.schema?.$ref?.endsWith('/JobAccepted') || response.content?.['application/json']?.schema?.$ref?.endsWith('/NotificationActionAccepted')) {
        assert.ok(response.headers?.Location, `${method.toUpperCase()} ${route} needs HTTP Location for its accepted job`);
      }
    }
  }
});

test('proposed payload and retry bounds are explicit and UNKNOWN external writes are never retried automatically', () => {
  assert.deepEqual(contract['x-proposed-payload-limits'], {
    defaultJsonRequestBytes: 65536,
    providerAuthorizationCodeRequestBytes: 16384,
    replyTextBytes: 4096,
    templateRequestBytes: 16384,
    signedWebhookRawBytes: 1048576,
    pageSizeDefault: 50,
    pageSizeMaximum: 100,
  });
  const retry = contract['x-retry-policy'];
  assert.equal(retry.safeReadsAndLocallyIdempotentJobs.maxAutomaticAttempts, 3);
  assert.equal(retry.safeReadsAndLocallyIdempotentJobs.maxElapsedSeconds, 60);
  assert.equal(retry.externalMutationsWithoutVerifiedProviderIdempotency.maxAutomaticAttempts, 1);
  assert.equal(retry.externalMutationsWithoutVerifiedProviderIdempotency.includesInitialRequest, true);
  assert.equal(retry.externalMutationsWithoutVerifiedProviderIdempotency.maxAutomaticRetries, 0);
  assert.equal(retry.externalMutationsWithoutVerifiedProviderIdempotency.onAmbiguousOutcome, 'UNKNOWN');
  assert.equal(retry.externalMutationsWithoutVerifiedProviderIdempotency.messageSend, 'no automatic retry');
  for (const id of ['requestMagicLink', 'disconnectConnection', 'submitProviderAuthorizationCode', 'sendReply', 'createTemplate', 'actOnNotification']) {
    const operation = operationList().find(({ operation: candidate }) => candidate.operationId === id)?.operation;
    assert.ok(operation, `missing externally visible operation ${id}`);
    const policy = operation['x-retry-policy'].toLowerCase();
    assert.match(policy, /one automatic|at most one automatic/, `${id} includes one initial automatic attempt`);
    assert.match(policy, /zero automatic retries|no automatic retry|do not automatically retry/, `${id} forbids automatic retries`);
  }
  const reauthorization = operationList().find(({ operation }) => operation.operationId === 'createReauthorization').operation;
  assert.match(reauthorization.description, /changes no provider state/i);
  assert.match(reauthorization['x-retry-policy'], /same Idempotency-Key and body/i);
  const sendReply = operationList().find(({ operation }) => operation.operationId === 'sendReply').operation;
  assert.match(sendReply['x-retry-policy'], /UNKNOWN/);
  assert.match(sendReply['x-retry-policy'], /No blind retry/);
});

test('consumer contract examples cover lists, templates, replies and notifications', () => {
  const ids = new Set(operationList().map(({ operation }) => operation.operationId));
  for (const id of ['listConnections', 'listTemplates', 'getAutomationConfig', 'replaceAutomationConfig', 'sendReply', 'listNotifications', 'actOnNotification']) assert.ok(ids.has(id), `missing consumer example operation ${id}`);
  const operations = operationList();
  for (const id of ['listConnections', 'listTemplates', 'getAutomationConfig', 'replaceAutomationConfig', 'sendReply', 'listNotifications']) {
    const operation = operations.find((entry) => entry.operation.operationId === id).operation;
    const response = Object.values(operation.responses).map((reference) => resolveResponse(reference)).find((entry) => entry.content?.['application/json']?.examples);
    assert.ok(response, `${id} must have a sanitized response example`);
    if (['replaceAutomationConfig', 'sendReply'].includes(id)) {
      assert.ok(operation.requestBody?.content?.['application/json']?.examples?.sanitized?.value, `${id} must have a sanitized request example`);
    }
  }
});
