import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(here, '../fixtures');
const readFixture = async (name) => JSON.parse(await readFile(path.join(fixtureRoot, name), 'utf8'));

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function payloadHash(payload) {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function executeIdempotently(records, { tenantRef, operation, key, payload }, effect) {
  const storageKey = `${tenantRef}\u0000${operation}\u0000${key}`;
  const digest = payloadHash(payload);
  const existing = records.get(storageKey);
  if (existing) {
    if (existing.digest !== digest) {
      return { status: 409, body: { code: 'IDEMPOTENCY_KEY_REUSED', retryable: false, action: 'USE_NEW_REQUEST_KEY' } };
    }
    return structuredClone(existing.response);
  }
  const response = effect();
  records.set(storageKey, { digest, response: structuredClone(response) });
  return response;
}

export function readinessAfterReturn({ statusQuery }) {
  if (!statusQuery) return 'UNKNOWN';
  if (statusQuery.status === 'READY' && statusQuery.readiness === 'READY' && statusQuery.requiredEvidenceCurrent === true) return 'READY';
  if (statusQuery.readiness === 'PARTIAL') return 'PARTIAL';
  return 'UNKNOWN';
}

export function authorizeTenantResource({ session, resource, requiredRole }) {
  if (!session) return { status: 401, body: { code: 'AUTH_REQUIRED', safeMessage: 'Sign in to continue.' } };
  if (!resource || session.tenantRef !== resource.tenantRef) {
    return { status: 404, body: { code: 'RESOURCE_NOT_AVAILABLE', safeMessage: 'The requested resource is not available.' } };
  }
  if (!session.roles.includes(requiredRole)) {
    return { status: 403, body: { code: 'ACCESS_DENIED', safeMessage: 'This action is not available for the current account.' } };
  }
  return { status: 200, body: { allowed: true } };
}

export function retryDecision({ outcome, attempt, maxAttempts, effectProvenNotApplied }) {
  if (outcome === 'UNKNOWN') return { retry: false, state: 'UNKNOWN', nextAction: 'RECONCILE' };
  if (!effectProvenNotApplied) return { retry: false, state: 'UNKNOWN', nextAction: 'RECONCILE' };
  if (attempt >= maxAttempts) return { retry: false, state: 'FAILED', nextAction: 'NONE' };
  return { retry: true, state: 'RETRY_PENDING', delaySeconds: Math.min(30, 2 ** (attempt - 1)) };
}

test('same idempotency key and payload replays the acceptance without another side effect', async () => {
  const fixture = await readFixture('idempotency.json');
  const records = new Map();
  let effectCount = 0;
  const run = (payload) => executeIdempotently(records, {
    tenantRef: fixture.tenantRef,
    operation: fixture.operation,
    key: fixture.idempotencyKey,
    payload,
  }, () => {
    effectCount += 1;
    return { status: 202, jobId: 'job_example_01' };
  });

  const first = run(fixture.samePayload);
  const replay = run(fixture.samePayloadReordered);
  assert.deepEqual(replay, first);
  assert.equal(effectCount, 1);
  assert.equal(records.size, 1);
});

test('same idempotency key with a different payload conflicts and does not repeat the effect', async () => {
  const fixture = await readFixture('idempotency.json');
  const records = new Map();
  let effectCount = 0;
  const input = (payload) => ({ tenantRef: fixture.tenantRef, operation: fixture.operation, key: fixture.idempotencyKey, payload });
  executeIdempotently(records, input(fixture.samePayload), () => { effectCount += 1; return { status: 202, jobId: 'job_example_02' }; });
  const conflict = executeIdempotently(records, input(fixture.differentPayload), () => { effectCount += 1; return { status: 202, jobId: 'must_not_exist' }; });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(effectCount, 1);
  assert.equal(records.size, 1);
});

test('idempotency namespace is isolated by tenant and operation', async () => {
  const fixture = await readFixture('idempotency.json');
  const records = new Map();
  let effectCount = 0;
  const invoke = (tenantRef, operation) => executeIdempotently(records, {
    tenantRef, operation, key: fixture.idempotencyKey, payload: fixture.samePayload,
  }, () => ({ status: 202, jobId: `job_example_${++effectCount}` }));
  invoke(fixture.tenantRef, fixture.operation);
  invoke(fixture.otherTenantRef, fixture.operation);
  invoke(fixture.tenantRef, fixture.otherOperation);
  assert.equal(effectCount, 3);
  assert.equal(records.size, 3);
});

test('provider HTTP 200 and browser 303 remain unknown until server status is queried', async () => {
  const fixture = await readFixture('provider-return.json');
  assert.equal(fixture.providerHttpStatus, 200);
  assert.equal(fixture.browserRedirectStatus, 303);
  assert.equal(readinessAfterReturn({ statusQuery: fixture.beforeStatusQuery }), 'UNKNOWN');
  assert.equal(readinessAfterReturn({ statusQuery: fixture.inProgressStatusQuery }), 'UNKNOWN');
  assert.equal(readinessAfterReturn({ statusQuery: { ...fixture.inProgressStatusQuery, status: 'PROVISIONING' } }), 'UNKNOWN');
  assert.equal(readinessAfterReturn({ statusQuery: fixture.readyStatusQuery }), 'READY');
  assert.equal(readinessAfterReturn({ statusQuery: { ...fixture.readyStatusQuery, requiredEvidenceCurrent: false } }), 'UNKNOWN');
});

test('cross-tenant reads hide resource existence and distinguish 401/403/404 safely', async () => {
  const fixture = await readFixture('tenant-access.json');
  const unauthenticated = authorizeTenantResource({ session: null, resource: fixture.resource, requiredRole: fixture.requiredRole });
  const foreignTenant = authorizeTenantResource({ session: fixture.sessionA, resource: fixture.resource, requiredRole: fixture.requiredRole });
  const missing = authorizeTenantResource({ session: fixture.sessionA, resource: fixture.missingResource, requiredRole: fixture.requiredRole });
  const insufficientRole = authorizeTenantResource({ session: fixture.viewerSessionA, resource: { id: 'asset_example_01', tenantRef: fixture.sessionA.tenantRef }, requiredRole: fixture.requiredRole });
  assert.equal(unauthenticated.status, 401);
  assert.equal(foreignTenant.status, 404);
  assert.deepEqual(foreignTenant.body, missing.body);
  assert.equal(insufficientRole.status, 403);
  assert.equal(insufficientRole.body.code, 'ACCESS_DENIED');
});

test('ambiguous external effects become UNKNOWN and the message policy allows no automatic retry', () => {
  const unknown = retryDecision({ outcome: 'UNKNOWN', attempt: 1, maxAttempts: 3, effectProvenNotApplied: false });
  assert.deepEqual(unknown, { retry: false, state: 'UNKNOWN', nextAction: 'RECONCILE' });
  const provenNoEffectAtMessageLimit = retryDecision({ outcome: 'RETRYABLE_FAILURE', attempt: 1, maxAttempts: 1, effectProvenNotApplied: true });
  assert.deepEqual(provenNoEffectAtMessageLimit, { retry: false, state: 'FAILED', nextAction: 'NONE' });
  const explicitlyConfiguredSafeRetry = retryDecision({ outcome: 'RETRYABLE_FAILURE', attempt: 1, maxAttempts: 3, effectProvenNotApplied: true });
  assert.deepEqual(explicitlyConfiguredSafeRetry, { retry: true, state: 'RETRY_PENDING', delaySeconds: 1 });
  const exhausted = retryDecision({ outcome: 'RETRYABLE_FAILURE', attempt: 3, maxAttempts: 3, effectProvenNotApplied: true });
  assert.deepEqual(exhausted, { retry: false, state: 'FAILED', nextAction: 'NONE' });
});
