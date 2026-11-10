import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  MetaWebhookItemProcessor,
  MetaWebhookItemProcessorInput,
  MetaWebhookProcessResult,
} from '../src/meta-webhooks/meta-webhook.types.js';
import {
  CoexistenceWebhookItemProcessor,
  type CoexistenceWebhookEvent,
  type CoexistenceWebhookEventSink,
  type CoexistenceWebhookScope,
  type CoexistenceWebhookScopeResolver,
} from '../src/meta-webhooks/coexistence-webhook-processor.js';

const TENANT = '10000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '10000000-0000-4000-8000-000000000002';
const APP = '10000000-0000-4000-8000-000000000003';
const ASSET = '10000000-0000-4000-8000-000000000004';
const AUTHORIZATION = '10000000-0000-4000-8000-000000000005';
const EVENT_REF = 'a'.repeat(64);
const NOW = Date.parse('2027-01-01T00:00:00.000Z');

const BASE_SCOPE: CoexistenceWebhookScope = Object.freeze({
  tenantId: TENANT,
  appConfigurationId: APP,
  assetId: ASSET,
  assetKind: 'WHATSAPP_PHONE_NUMBER',
  phoneOwnershipVerified: true,
  authorizationRef: AUTHORIZATION,
  flowVariant: 'WHATSAPP_COEXISTENCE',
  authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING',
  authorizationActive: true,
  historyConsent: 'GRANTED',
  echoConsent: 'GRANTED',
  historyExpiresAt: '2027-02-01T00:00:00.000Z',
  echoExpiresAt: '2027-02-01T00:00:00.000Z',
});

function input(overrides: Partial<MetaWebhookItemProcessorInput> = {}): MetaWebhookItemProcessorInput {
  // Scenario overrides select one discriminated-union variant; each fixture supplies that variant's required fields.
  return {
    eventRef: EVENT_REF,
    eventKey: EVENT_REF,
    schemaVersion: 1,
    tenantId: TENANT,
    appConfigurationId: APP,
    assetId: ASSET,
    eventType: 'meta.webhook.whatsapp_business_account.history.messages',
    itemKind: 'messages',
    providerTimestamp: '2026-11-10T12:00:00.000Z',
    providerMessageId: 'wamid.synthetic-1',
    providerStatus: null,
    providerStatusRank: null,
    statusFence: null,
    item: Object.freeze({ id: 'wamid.synthetic-1', type: 'text', text: { body: 'synthetic only' } }),
    ...overrides,
  } as MetaWebhookItemProcessorInput;
}

class FakeScopeResolver implements CoexistenceWebhookScopeResolver {
  calls = 0;
  result: CoexistenceWebhookScope | undefined = BASE_SCOPE;
  async resolve(): Promise<CoexistenceWebhookScope | undefined> {
    this.calls += 1;
    return this.result;
  }
}

class IdempotentFakeSink implements CoexistenceWebhookEventSink {
  readonly received: CoexistenceWebhookEvent[] = [];
  readonly acceptedContent = new Map<string, CoexistenceWebhookEvent>();
  readonly acceptedStatusByRef = new Map<string, CoexistenceWebhookEvent>();
  result: MetaWebhookProcessResult = { kind: 'SUCCEEDED' };
  async accept(event: CoexistenceWebhookEvent): Promise<MetaWebhookProcessResult> {
    this.received.push(event);
    const scopeKey = `${event.tenantId}:${event.appConfigurationId}:${event.assetId}`;
    if (event.kind === 'HISTORY_STATUS') this.acceptedStatusByRef.set(`${scopeKey}:${event.eventRef}`, event);
    else this.acceptedContent.set(`${scopeKey}:${event.providerMessageId}`, event);
    return this.result;
  }
}

class FakeProcessor implements MetaWebhookItemProcessor {
  readonly received: MetaWebhookItemProcessorInput[] = [];
  result: MetaWebhookProcessResult = { kind: 'SUCCEEDED' };
  async process(value: MetaWebhookItemProcessorInput): Promise<MetaWebhookProcessResult> {
    this.received.push(value);
    return this.result;
  }
}

function setup(scope: CoexistenceWebhookScope | undefined = BASE_SCOPE) {
  const scopes = new FakeScopeResolver();
  scopes.result = scope;
  const sink = new IdempotentFakeSink();
  const fallback = new FakeProcessor();
  const processor = new CoexistenceWebhookItemProcessor(scopes, sink, fallback, true, () => NOW);
  return { processor, scopes, sink, fallback };
}

test('history item requires the exact internal Coexistence route and a granted history consent', async () => {
  const { processor, sink } = setup();
  const result = await processor.process(input());
  assert.deepEqual(result, { kind: 'SUCCEEDED' });
  assert.equal(sink.received.length, 1);
  assert.deepEqual(sink.received[0], {
    kind: 'HISTORY_MESSAGE', tenantId: TENANT, appConfigurationId: APP, assetId: ASSET,
    authorizationRef: AUTHORIZATION, eventRef: EVENT_REF, providerMessageId: 'wamid.synthetic-1',
    providerTimestamp: '2026-11-10T12:00:00.000Z', retentionExpiresAt: BASE_SCOPE.historyExpiresAt,
    suppressAutomation: true, item: input().item,
  });
});

test('history statuses retain the status fence and require the same explicit expiry policy', async () => {
  const { processor, sink } = setup();
  const statusFence = {
    leaseVersion: 2, leaseToken: 'synthetic-lease-token', eventKey: EVENT_REF,
    providerTimestamp: '2026-11-10T12:00:00.000Z',
  };
  const status = input({
    eventType: 'meta.webhook.whatsapp_business_account.history.statuses',
    itemKind: 'statuses', providerStatus: 'delivered', providerStatusRank: 20, statusFence,
  });
  assert.deepEqual(await processor.process(status), { kind: 'SUCCEEDED' });
  assert.deepEqual(sink.received[0], {
    kind: 'HISTORY_STATUS', tenantId: TENANT, appConfigurationId: APP, assetId: ASSET,
    authorizationRef: AUTHORIZATION, eventRef: EVENT_REF, providerMessageId: 'wamid.synthetic-1',
    providerTimestamp: '2026-11-10T12:00:00.000Z', providerStatus: 'delivered',
    retentionExpiresAt: BASE_SCOPE.historyExpiresAt, statusFence, suppressAutomation: true,
  });

  const missingExpiry = setup({ ...BASE_SCOPE, historyExpiresAt: null });
  assert.deepEqual(await missingExpiry.processor.process(status), {
    kind: 'PERMANENT_FAILURE', safeErrorCode: 'MESSAGE_RETENTION_NOT_CONFIGURED',
  });
  assert.equal(missingExpiry.sink.received.length, 0);
});

test('declined and unknown history consent store no history payload and produce distinct safe outcomes', async () => {
  const declined = setup({ ...BASE_SCOPE, historyConsent: 'DECLINED' });
  assert.deepEqual(await declined.processor.process(input()), {
    kind: 'PERMANENT_FAILURE', safeErrorCode: 'HISTORY_CONSENT_DECLINED',
  });
  assert.equal(declined.sink.received.length, 0);

  const unknown = setup({ ...BASE_SCOPE, historyConsent: 'UNKNOWN' });
  assert.deepEqual(await unknown.processor.process(input()), {
    kind: 'PERMANENT_FAILURE', safeErrorCode: 'HISTORY_CONSENT_NOT_CONFIRMED',
  });
  assert.equal(unknown.sink.received.length, 0);
});

test('history is not stored without an explicit future retention expiry', async () => {
  const { processor, sink } = setup({ ...BASE_SCOPE, historyExpiresAt: null });
  assert.deepEqual(await processor.process(input()), { kind: 'PERMANENT_FAILURE', safeErrorCode: 'MESSAGE_RETENTION_NOT_CONFIGURED' });
  assert.equal(sink.received.length, 0);
});

test('scope mismatch and revoked authorization fail before storage', async () => {
  for (const scope of [
    { ...BASE_SCOPE, tenantId: OTHER_TENANT },
    { ...BASE_SCOPE, appConfigurationId: OTHER_TENANT },
    { ...BASE_SCOPE, assetId: OTHER_TENANT },
    { ...BASE_SCOPE, authorizationActive: false },
    { ...BASE_SCOPE, phoneOwnershipVerified: false },
    { ...BASE_SCOPE, flowVariant: 'WHATSAPP_EXCLUSIVE' },
  ]) {
    const { processor, sink } = setup(scope as unknown as CoexistenceWebhookScope);
    assert.deepEqual(await processor.process(input()), { kind: 'PERMANENT_FAILURE', safeErrorCode: 'COEXISTENCE_SCOPE_MISMATCH' });
    assert.equal(sink.received.length, 0);
  }
});

test('business app echo requires consent and retention and is explicitly marked to suppress automation', async () => {
  const echo = input({
    eventType: 'meta.webhook.whatsapp_business_account.smb_message_echoes.messages',
    item: Object.freeze({ id: 'wamid.echo.synthetic', type: 'text' }),
    providerMessageId: 'wamid.echo.synthetic',
  });
  const declined = setup({ ...BASE_SCOPE, echoConsent: 'DECLINED' });
  assert.deepEqual(await declined.processor.process(echo), {
    kind: 'PERMANENT_FAILURE', safeErrorCode: 'ECHO_CONSENT_DECLINED',
  });
  assert.equal(declined.sink.received.length, 0);

  const noExpiry = setup({ ...BASE_SCOPE, echoExpiresAt: null });
  assert.deepEqual(await noExpiry.processor.process(echo), {
    kind: 'PERMANENT_FAILURE', safeErrorCode: 'MESSAGE_RETENTION_NOT_CONFIGURED',
  });
  assert.equal(noExpiry.sink.received.length, 0);

  const { processor, sink } = setup();
  assert.deepEqual(await processor.process(echo), { kind: 'SUCCEEDED' });
  const received = sink.received[0];
  if (!received || received.kind !== 'BUSINESS_APP_ECHO') assert.fail('expected an app echo event');
  assert.equal(received.source, 'BUSINESS_APP');
  assert.equal(received.suppressAutomation, true);
});

test('duplicate inbox delivery forwards the same eventRef for transactional sink idempotency', async () => {
  const { processor, sink } = setup();
  await processor.process(input());
  await processor.process(input());
  assert.deepEqual(sink.received.map((event) => event.eventRef), [EVENT_REF, EVENT_REF]);
  assert.equal(sink.acceptedContent.size, 1);
});

test('echo content identity suppresses duplicate rows when the inbox event reference differs', async () => {
  const { processor, sink } = setup();
  const echo = input({
    eventType: 'meta.webhook.whatsapp_business_account.smb_message_echoes.messages',
    providerMessageId: 'wamid.echo.same',
    item: Object.freeze({ id: 'wamid.echo.same', type: 'text', metadata: 'first' }),
  });
  await processor.process(echo);
  await processor.process({ ...echo, eventRef: 'b'.repeat(64), eventKey: 'b'.repeat(64) });
  assert.equal(sink.received.length, 2);
  assert.equal(sink.acceptedContent.size, 1);
});

test('state sync is rejected until its provider schema and phone ownership route are confirmed', async () => {
  const { processor, scopes, sink } = setup();
  const state = input({ eventType: 'meta.webhook.whatsapp_business_account.smb_app_state_sync', itemKind: 'change' });
  assert.deepEqual(await processor.process(state), {
    kind: 'PERMANENT_FAILURE', safeErrorCode: 'STATE_SYNC_SCHEMA_NOT_CONFIRMED',
  });
  assert.equal(scopes.calls, 0);
  assert.equal(sink.received.length, 0);
});

test('Coexistence processing requires explicit opt-in and does not delegate Coexistence events', async () => {
  const scopes = new FakeScopeResolver();
  const sink = new IdempotentFakeSink();
  const fallback = new FakeProcessor();
  const processor = new CoexistenceWebhookItemProcessor(scopes, sink, fallback, false, () => NOW);
  assert.deepEqual(await processor.process(input()), {
    kind: 'PERMANENT_FAILURE', safeErrorCode: 'COEXISTENCE_PROCESSOR_DISABLED',
  });
  assert.equal(scopes.calls, 0);
  assert.equal(fallback.received.length, 0);
  assert.equal(sink.received.length, 0);
});

test('malformed and unsupported Coexistence leaves cannot reach the event sink', async () => {
  const { processor, sink, fallback } = setup();
  assert.deepEqual(await processor.process(input({ eventKey: 'b'.repeat(64) })), {
    kind: 'PERMANENT_FAILURE', safeErrorCode: 'COEXISTENCE_EVENT_ID_INVALID',
  });
  assert.deepEqual(await processor.process(input({
    eventType: 'meta.webhook.whatsapp_business_account.smb_message_echoes.statuses', itemKind: 'statuses',
    providerStatus: 'delivered', providerStatusRank: 20,
    statusFence: {
      leaseVersion: 1, leaseToken: 'synthetic-lease-token', eventKey: EVENT_REF,
      providerTimestamp: '2026-11-10T12:00:00.000Z',
    },
  })), { kind: 'PERMANENT_FAILURE', safeErrorCode: 'COEXISTENCE_EVENT_SHAPE_NOT_CONFIRMED' });
  assert.deepEqual(await processor.process(input({
    eventType: 'meta.webhook.whatsapp_business_account.account_update', itemKind: 'change',
  })), { kind: 'PERMANENT_FAILURE', safeErrorCode: 'COEXISTENCE_EVENT_TYPE_NOT_SUPPORTED' });
  assert.equal(sink.received.length, 0);
  assert.equal(fallback.received.length, 0);
});

test('non-Coexistence events continue through the configured fallback processor', async () => {
  const { processor, sink, fallback } = setup();
  const otherProduct = input({ eventType: 'meta.webhook.page.feed', itemKind: 'change' });
  assert.deepEqual(await processor.process(otherProduct), { kind: 'SUCCEEDED' });
  assert.deepEqual(fallback.received, [otherProduct]);
  assert.equal(sink.received.length, 0);
});

test('sink failures remain retryable and unsafe error strings are replaced', async () => {
  const { processor, sink } = setup();
  sink.result = { kind: 'RETRYABLE_FAILURE', safeErrorCode: 'bearer synthetic-secret-value' };
  assert.deepEqual(await processor.process(input()), {
    kind: 'RETRYABLE_FAILURE', safeErrorCode: 'COEXISTENCE_STORE_FAILURE',
  });
});
