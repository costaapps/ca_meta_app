import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MIGRATIONS } from '../src/database/migrations/migrations.js';
import { PRIVACY_GOVERNANCE_MIGRATION } from '../src/database/migrations/privacy-governance.js';
import { FailClosedDeletionAuthorization } from '../src/privacy/deletion.service.js';
import { redactDiagnosticValue, redactStructuredLogRecord, sanitizeAuditDiff } from '../src/privacy/redaction.js';
import { FailClosedRetentionAuthorization } from '../src/privacy/retention.service.js';
import { FailClosedSupportAccessAuthorization, SupportDiagnosticService, type SupportAccessAuthorizationPort } from '../src/privacy/audit.service.js';

const marker = 'M3_10_SYNTHETIC_ACCESS_TOKEN_MARKER_93A7C1';

test('recursive diagnostics redaction removes nested secret, contact, body, header and stack values', () => {
  const source = {
    requestId: '00000000-0000-4000-8000-000000000001',
    payload: { access_token: marker, messages: [{ text: 'synthetic customer message marker' }] },
    error: { message: marker, stack: `Error: ${marker}` },
    headers: { authorization: `Bearer ${marker}`, cookie: marker, 'x-api-key': marker },
    contact: { email: 'person@example.invalid', phone: '+1 555 010 2468' },
    state: 'ACTIVE',
  };
  const result = redactDiagnosticValue(source);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes('person@example.invalid'), false);
  assert.equal(serialized.includes('555 010 2468'), false);
  assert.equal(serialized.includes('headers'), false);
  assert.equal(serialized.includes('stack'), false);
  assert.equal(serialized.includes('ACTIVE'), true);
});

test('structured logs keep only typed allowlisted fields and audit diffs keep safe keys', () => {
  const log = redactStructuredLogRecord({
    level: 'error', event: 'http.exception', requestId: '00000000-0000-4000-8000-000000000002',
    statusCode: 500, message: marker, stack: marker, payload: { token: marker }, errorType: 'UnhandledException',
  });
  assert.deepEqual(Object.keys(log).sort(), ['errorType', 'event', 'level', 'requestId', 'statusCode'].sort());
  assert.equal(JSON.stringify(log).includes(marker), false);

  const diff = sanitizeAuditDiff({
    before: { status: 'ACTIVE', accessToken: marker }, after: { status: 'REVOKED', message: marker },
    policyVersion: 'm3-10-v1', reasonCode: 'PRIVACY_REQUEST', rawRequest: marker,
  });
  const serialized = JSON.stringify(diff);
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes('rawRequest'), false);
  assert.equal(serialized.includes('m3-10-v1'), true);
  assert.equal(serialized.includes('PRIVACY_REQUEST'), true);
});

test('support diagnostics require a scoped short-lived grant, write actor/reason audit and redact output', async () => {
  const events: Array<Record<string, unknown>> = [];
  const audit = {
    async record(event: Record<string, unknown>) { events.push(event); return '00000000-0000-4000-8000-000000000003'; },
  } as never;
  const authorization: SupportAccessAuthorizationPort = {
    async authorize(input) { return { ...input, expiresAt: new Date(Date.now() + 10_000).toISOString() }; },
  };
  const service = new SupportDiagnosticService(audit, authorization);
  const output = await service.read({
    tenantId: '00000000-0000-4000-8000-000000000001', actorRef: 'support-actor-1',
    targetRef: '00000000-0000-4000-8000-000000000002', reasonCode: 'INCIDENT',
  }, '00000000-0000-4000-8000-000000000004', async () => ({
    status: 'AVAILABLE', headers: { authorization: marker }, message: marker,
  }));
  assert.equal(JSON.stringify(output).includes(marker), false);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.action, 'SUPPORT_DIAGNOSTIC_ACCESS');
  assert.deepEqual(events[0]?.safeDiff, { reasonCode: 'INCIDENT' });
});

test('M3.10 is schema v12, with deny-by-default policy gates and disabled duration defaults', async () => {
  assert.equal(PRIVACY_GOVERNANCE_MIGRATION.schemaVersion, 12);
  assert.equal(MIGRATIONS.at(-1)?.id, PRIVACY_GOVERNANCE_MIGRATION.id);
  const policyDdl = PRIVACY_GOVERNANCE_MIGRATION.steps.find((step) => step.id === 'create-retention-policies');
  assert.ok(policyDdl && policyDdl.phase === 'expand');
  assert.match(policyDdl.sql, /DEFAULT 'DRAFT'/);
  assert.match(policyDdl.sql, /approval_ref IS NOT NULL/);
  assert.match(policyDdl.sql, /retention_seconds > 0/);
  assert.equal(await new FailClosedDeletionAuthorization().authorize({ tenantId: 't', actorRef: 'a', operation: 'REQUEST' }), null);
  assert.equal(await new FailClosedRetentionAuthorization().authorize({ tenantId: 't', environment: 'test', actorRef: 'a', operation: 'START_PURGE' }), null);
  assert.equal(await new FailClosedSupportAccessAuthorization().authorize({
    tenantId: 't', actorRef: 'a', targetRef: 'r', reasonCode: 'INCIDENT',
  }), null);
});
