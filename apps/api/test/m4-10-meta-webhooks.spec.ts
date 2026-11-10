import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import type { ApiEnvironment } from '../src/config/environment.js';
import type { MetaAppConfiguration } from '../src/meta-config/meta-app-config.configuration.js';
import {
  MetaWebhookConfigurationResolver,
  MetaWebhookIngressService,
  MetaWebhookSignatureError,
} from '../src/meta-webhooks/meta-webhook-ingress.service.js';
import { compareMetaWebhookStatusOrder, itemFromProtectedDelivery, MetaWebhookPayloadValidationError,
  META_WEBHOOK_RAW_POST_PATH, parseMetaWebhookDelivery } from '../src/meta-webhooks/meta-webhook-validation.js';
import { verifyChallengeToken, verifyMetaWebhookSignature } from '../src/meta-webhooks/meta-webhook-signature.js';
import { MetaWebhookRepository } from '../src/meta-webhooks/meta-webhook.repository.js';
import type { MetaWebhookEventRow } from '../src/meta-webhooks/meta-webhook.repository.js';
import { MetaWebhookReplayService } from '../src/meta-webhooks/meta-webhook-replay.service.js';
import { MetaWebhookWorker } from '../src/meta-webhooks/meta-webhook-worker.js';
import type {
  MetaWebhookPayloadProtector,
  MetaWebhookSecretProvider,
  ProtectedMetaWebhookPayload,
} from '../src/meta-webhooks/meta-webhook.types.js';

const appSecret = Buffer.from('synthetic-app-secret-for-tests-only', 'utf8');
const rotatedSecret = Buffer.from('synthetic-next-app-secret-for-tests-only', 'utf8');
const verificationToken = 'synthetic-independent-verify-token';

function signature(body: Buffer, key = appSecret): string {
  return `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;
}

function envelope(): Buffer {
  return Buffer.from(`{
  "object":"whatsapp_business_account",
  "entry":[{"id":"synthetic-waba-9","changes":[{"field":"messages","value":{
    "metadata":{"phone_number_id":"synthetic-phone-id-7"},
    "messages":[{"id":"wamid.synthetic.1","from":"+15550000001","timestamp":"1793980800","type":"text","text":{"body":"synthetic body"}}],
    "statuses":[
      {"id":"wamid.synthetic.1","recipient_id":"+15550000001","status":"sent","timestamp":"1793980801"},
      {"id":"wamid.synthetic.1","recipient_id":"+15550000001","status":"delivered","timestamp":"1793980802"},
      {"id":"wamid.synthetic.1","recipient_id":"+15550000001","status":"read","timestamp":"1793980803"}
    ]
  }}]}]
}
`, 'utf8');
}

function fakeProfile(overrides: Partial<MetaAppConfiguration> = {}): MetaAppConfiguration {
  return {
    configurationRef: 'synthetic-config', environment: 'test', flowVariant: 'WHATSAPP_EXCLUSIVE',
    authVariant: 'WHATSAPP_EMBEDDED_SIGNUP', providerAppIdRef: 'synthetic-meta-app',
    providerAppId: '1234567890', appMode: 'DEVELOPMENT', appDomain: 'example.test',
    callbackUri: 'https://example.test/callback', redirectAllowlist: ['https://example.test'],
    appSecretRef: 'vault://meta-app/test/synthetic/app-secret', tokenConfigurationRef: 'vault://meta-app/test/synthetic/token',
    capabilityManifestVersion: 'v1', enabled: true,
    versions: { graphApi: { value: 'v25.0', status: 'NOT_CONFIRMED' } },
    capabilityEvidence: [], ...overrides,
  } as MetaAppConfiguration;
}

function apiEnvironment(): ApiEnvironment {
  return { nodeEnv: 'test' } as ApiEnvironment;
}

function protectedPayload(reference: string, raw: Buffer): ProtectedMetaWebhookPayload {
  return {
    reference,
    keyReference: 'synthetic-test-key-v1',
    nonce: Buffer.alloc(12, 1),
    authenticationTag: Buffer.alloc(16, 2),
    ciphertext: Buffer.from(raw),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
}

test('signature covers exact raw bytes and checks current and previous App Secret versions', () => {
  const raw = Buffer.from('{ "x" : 1 }\n', 'utf8');
  assert.equal(verifyMetaWebhookSignature(raw, signature(raw, rotatedSecret), [appSecret, rotatedSecret]), true);
  assert.equal(verifyMetaWebhookSignature(raw, signature(Buffer.from('{"x":1}\n')), [appSecret, rotatedSecret]), false);
  assert.equal(verifyMetaWebhookSignature(raw, 'sha256=bad', [appSecret]), false);
  assert.equal(verifyMetaWebhookSignature(raw, signature(raw), []), false);
});

test('challenge verification uses a separate token and fixed-size timing-safe comparison', () => {
  assert.equal(verifyChallengeToken(verificationToken, verificationToken), true);
  assert.equal(verifyChallengeToken('different-token', verificationToken), false);
  assert.equal(verifyChallengeToken(undefined, verificationToken), false);
});

test('per-item parsing preserves message and status changes and routes only by opaque asset ID', () => {
  const raw = envelope();
  const parsed = parseMetaWebhookDelivery(raw);
  assert.equal(parsed.items.length, 4);
  assert.equal(new Set(parsed.items.map((item) => item.eventRef)).size, 4);
  assert.ok(parsed.items.some((item) => item.eventType === 'meta.webhook.whatsapp_business_account.messages.messages'));
  assert.ok(parsed.items.some((item) => item.eventType === 'meta.webhook.whatsapp_business_account.messages.statuses'));
  assert.ok(parsed.items.every((item) => item.resourceExternalId === 'synthetic-phone-id-7'));
  const delivered = parsed.items.find((item) => item.locator.nestedKind === 'statuses' && item.locator.nestedIndex === 1);
  assert.ok(delivered);
  assert.equal(itemFromProtectedDelivery(raw, delivered.locator).status, 'delivered');
  assert.equal(delivered.schemaVersion, 1);
  assert.equal(delivered.eventKey, delivered.eventRef);
  assert.equal(delivered.providerMessageId, 'wamid.synthetic.1');
  assert.equal(delivered.providerStatus, 'delivered');
  assert.equal(delivered.providerTimestamp, new Date(1_793_980_802_000).toISOString());
  assert.equal(parsed.items.some((item) => item.resourceExternalId === '+15550000001'), false);
});

test('WhatsApp account updates use the WABA while messages/statuses without phone metadata stay unmapped', () => {
  const raw = Buffer.from(JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      { id: 'synthetic-waba-account', changes: [{ field: 'account_update', value: { event: 'name_update' } }] },
      { id: 'synthetic-waba-missing-phone', changes: [{ field: 'messages', value: {
        messages: [{ id: 'wamid.synthetic.missing-phone', timestamp: '1793980800', type: 'text' }],
        statuses: [{ id: 'wamid.synthetic.missing-phone', status: 'delivered', timestamp: '1793980801' }],
      } }] },
    ],
  }), 'utf8');
  const parsed = parseMetaWebhookDelivery(raw);
  const accountEvent = parsed.items.find((item) => item.field === 'account_update');
  assert.deepEqual(accountEvent?.resourceKinds, ['WHATSAPP_BUSINESS_ACCOUNT']);
  assert.equal(accountEvent?.resourceExternalId, 'synthetic-waba-account');
  const messageAndStatus = parsed.items.filter((item) => item.locator.nestedKind === 'messages' || item.locator.nestedKind === 'statuses');
  assert.equal(messageAndStatus.length, 2);
  assert.ok(messageAndStatus.every((item) => item.resourceKinds.length === 0 && item.resourceExternalId === null),
    'entry.id is not used as a fallback asset for individual messages or statuses');
});

test('history and message echoes route only by each item phone number and never by the WABA entry', () => {
  const raw = Buffer.from(JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'synthetic-waba-unconfirmed-family', changes: [
      { field: 'history', value: { messages: [
        { id: 'wamid.history.with-phone', phone_number_id: 'synthetic-history-phone' },
        { id: 'wamid.history.without-phone' },
      ] } },
      { field: 'smb_message_echoes', value: { messages: [
        { id: 'wamid.echo.with-phone', phone_number_id: 'synthetic-echo-phone' },
        { id: 'wamid.echo.without-phone' },
      ] } },
      { field: 'smb_app_state_sync', value: { metadata: { phone_number_id: 'synthetic-unconfirmed-phone' }, state: 'synthetic' } },
    ] }],
  }), 'utf8');
  const parsed = parseMetaWebhookDelivery(raw);
  const history = parsed.items.filter((item) => item.field === 'history');
  const echoes = parsed.items.filter((item) => item.field === 'smb_message_echoes');
  const appState = parsed.items.find((item) => item.field === 'smb_app_state_sync');
  assert.deepEqual(history.map((item) => item.resourceExternalId), ['synthetic-history-phone', null]);
  assert.deepEqual(echoes.map((item) => item.resourceExternalId), ['synthetic-echo-phone', null]);
  assert.ok([...history, ...echoes].filter((item) => item.resourceExternalId === null)
    .every((item) => item.resourceKinds.length === 0), 'missing leaf references stay tenantless');
  assert.deepEqual(appState?.resourceKinds, [], 'unconfirmed account-state shape has no WABA fallback');
});

test('raw-body boundary matches the canonical appConfigRef route shape', () => {
  assert.equal(META_WEBHOOK_RAW_POST_PATH.test('/api/v1/webhooks/meta/appConfig_01.v2-3'), true);
  assert.equal(META_WEBHOOK_RAW_POST_PATH.test('/api/v1/webhooks/meta/config/ref'), false);
  assert.equal(META_WEBHOOK_RAW_POST_PATH.test(`/api/v1/webhooks/meta/${'a'.repeat(97)}`), false);
});

test('provider status ordering rejects older statuses and fails closed on ambiguous timestamp ties', () => {
  const sent = { timestamp: '2026-11-06T00:00:01.000Z', status: 'sent', rank: 10 };
  const delivered = { timestamp: '2026-11-06T00:00:02.000Z', status: 'delivered', rank: 20 };
  const readAtSameSecond = { timestamp: '2026-11-06T00:00:02.000Z', status: 'read', rank: 30 };
  const failedAtSameSecond = { timestamp: '2026-11-06T00:00:02.000Z', status: 'failed', rank: null };
  assert.equal(compareMetaWebhookStatusOrder(delivered, sent), 'NEWER');
  assert.equal(compareMetaWebhookStatusOrder(sent, delivered), 'OLDER');
  assert.equal(compareMetaWebhookStatusOrder(readAtSameSecond, delivered), 'NEWER');
  assert.equal(compareMetaWebhookStatusOrder(failedAtSameSecond, delivered), 'AMBIGUOUS');
  assert.equal(compareMetaWebhookStatusOrder(
    { timestamp: '2026-11-06T00:00:03.000Z', status: 'sent', rank: 10 }, delivered,
  ), 'OLDER', 'a later timestamp cannot regress the known progress rank');
  assert.equal(compareMetaWebhookStatusOrder(
    { timestamp: '2026-11-06T00:00:03.000Z', status: 'failed', rank: null }, delivered,
  ), 'AMBIGUOUS', 'an unknown status rank is never authorized by a newer timestamp');
});

test('status claim suppresses provider timestamps older than the latest processed item', async () => {
  const updates: unknown[][] = [];
  const row = {
    id: 'event-synthetic-old', provider_app_id: '1234567890', environment: 'test', event_ref: 'a'.repeat(64),
    schema_version: 1, event_type: 'meta.webhook.statuses', item_kind: 'statuses',
    provider_timestamp: '2026-11-06 10:00:00.000000', provider_message_id: 'wamid.synthetic.1',
    provider_status: 'sent', provider_status_rank: 10, tenant_id: 'tenant-synthetic-1',
    app_configuration_id: 'config-synthetic-1', asset_id: 'asset-synthetic-1', attempt: 0,
    lease_version: 0, item_locator_json: JSON.stringify({ entryIndex: 0, changeIndex: 0, nestedKind: 'statuses', nestedIndex: 0 }),
    payload_reference: '12345678-1234-4123-8123-123456789abc', key_reference: 'key-ref',
    nonce: Buffer.alloc(12), authentication_tag: Buffer.alloc(16), ciphertext: Buffer.from('protected'),
    expires_at: '2026-11-07 10:00:00.000000',
  };
  const manager = {
    async query(sql: string, parameters: unknown[] = []) {
      if (sql.includes('FROM ca_meta_webhook_events event') && sql.includes('LIMIT 1 FOR UPDATE')) return [row];
      if (sql.includes('SELECT lease_owner, lease_token, lease_version')) {
        return [{ lease_owner: null, lease_token: null, lease_version: 4, lease_until: null, lease_active: 0 }];
      }
      if (sql.includes('SELECT provider_timestamp, provider_status, provider_status_rank')) return [
        { provider_timestamp: '2026-11-06 10:00:01.000000', provider_status: 'delivered', provider_status_rank: 20 },
      ];
      if (sql.includes("SET process_state = ?, lease_owner = NULL, lease_until = NULL")) {
        updates.push(parameters);
        return { affectedRows: 1 };
      }
      return [];
    },
  };
  const dataSource = { manager, async transaction<T>(callback: (value: typeof manager) => Promise<T>) { return callback(manager); } };
  const repository = new MetaWebhookRepository({ async getDataSource() { return dataSource; } } as never);
  assert.equal(await repository.claimNext('synthetic-worker-1'), null);
  assert.equal(updates[0]?.[0], 'PROCESSED');
  assert.equal(updates[0]?.[1], 'STALE_PROVIDER_STATUS');
});

test('envelope bounds reject malformed and oversized bodies', () => {
  assert.throws(() => parseMetaWebhookDelivery(Buffer.from('{', 'utf8')), MetaWebhookPayloadValidationError);
  assert.throws(() => parseMetaWebhookDelivery(Buffer.alloc(256 * 1024 + 1)), MetaWebhookPayloadValidationError);
  assert.throws(() => parseMetaWebhookDelivery(Buffer.from('{"object":"page","entry":[]}')), MetaWebhookPayloadValidationError);
});

test('appConfigRef resolves one exact profile in the runtime environment and rejects duplicates', () => {
  const profile = fakeProfile();
  const resolver = new MetaWebhookConfigurationResolver([profile], apiEnvironment().nodeEnv);
  assert.equal(resolver.resolveByAppConfigRef('synthetic-config')?.providerAppId, '1234567890');
  const sharedAppId = new MetaWebhookConfigurationResolver([
    profile, fakeProfile({ configurationRef: 'synthetic-coexistence-config', flowVariant: 'WHATSAPP_COEXISTENCE',
      authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING' }),
  ], 'test');
  assert.equal(sharedAppId.resolveByAppConfigRef('synthetic-config')?.configurationRef, 'synthetic-config');
  assert.equal(sharedAppId.resolveByAppConfigRef('synthetic-coexistence-config')?.configurationRef,
    'synthetic-coexistence-config', 'profiles sharing one provider App ID remain individually resolvable');
  assert.equal(resolver.resolveByAppConfigRef('1234567890'), undefined, 'the public route reference is not the provider App ID');
  const conflict = new MetaWebhookConfigurationResolver([
    profile, fakeProfile({ flowVariant: 'WHATSAPP_COEXISTENCE', authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING',
      appSecretRef: 'vault://meta-app/test/other/app-secret' }),
  ], 'test');
  assert.equal(conflict.resolveByAppConfigRef('synthetic-config'), undefined, 'duplicate public references fail closed even when profiles differ');
  const otherEnvironment = new MetaWebhookConfigurationResolver([fakeProfile({ environment: 'staging' })], 'test');
  assert.equal(otherEnvironment.resolveByAppConfigRef('synthetic-config'), undefined);
});

test('quarantine replay fails closed when the durable source configuration is missing or ambiguous', async () => {
  const profile = fakeProfile();
  const reasons: string[] = [];
  const row = {
    id: 'event-synthetic-quarantine', provider_app_id: '1234567890', environment: 'test',
    delivery_id: '12345678-1234-4123-8123-123456789abc', item_locator_json: '{}', event_ref: 'a'.repeat(64),
    app_configuration_ref: null, delivery_provider_app_id: '1234567890', delivery_environment: 'test',
    key_reference: 'synthetic-key', nonce: Buffer.alloc(12), authentication_tag: Buffer.alloc(16),
    ciphertext: Buffer.from('synthetic'), expires_at: new Date(Date.now() + 60_000).toISOString(),
  } as unknown as MetaWebhookEventRow;
  let currentRow = row;
  const repository = {
    async getQuarantined() { return currentRow; },
    async recordReplayUnavailable(input: { readonly reasonCode: string }) { reasons.push(input.reasonCode); },
  } as unknown as MetaWebhookRepository;
  const protector: MetaWebhookPayloadProtector = {
    async protect(input) { return protectedPayload(input.reference, input.rawBody); },
    async unprotect() { throw new Error('unprotect must not run without a unique exact profile'); },
  };
  const authorization = { async assertAuthorized() { return undefined; } };
  const replay = new MetaWebhookReplayService([profile], 'test', repository, protector, authorization);
  assert.equal(await replay.replayQuarantined({ eventId: row.id, actorRef: 'synthetic-operator', caseRef: 'synthetic-case' }),
    'STILL_QUARANTINED');
  assert.equal(reasons.pop(), 'APPLICATION_CONTEXT_UNAVAILABLE', 'missing source configuration stays quarantined');

  currentRow = { ...row, app_configuration_ref: 'synthetic-config' };
  const ambiguousReplay = new MetaWebhookReplayService([
    profile, fakeProfile({ flowVariant: 'WHATSAPP_COEXISTENCE', authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING' }),
  ], 'test', repository, protector, authorization);
  assert.equal(await ambiguousReplay.replayQuarantined({ eventId: row.id, actorRef: 'synthetic-operator', caseRef: 'synthetic-case' }),
    'STILL_QUARANTINED');
  assert.equal(reasons.pop(), 'APPLICATION_CONTEXT_UNAVAILABLE', 'duplicate exact references stay quarantined');
});

test('signature is checked before parsing, and challenge never requests an App Secret', async () => {
  const calls = { verification: 0, appSecret: 0, protect: 0, persist: 0 };
  const secrets: MetaWebhookSecretProvider = {
    async verificationToken() { calls.verification += 1; return verificationToken; },
    async appSecretVersions() { calls.appSecret += 1; return [appSecret, rotatedSecret]; },
  };
  const protector: MetaWebhookPayloadProtector = {
    async protect(input) { calls.protect += 1; return protectedPayload(input.reference, input.rawBody); },
    async unprotect(value) { return Buffer.from(value.ciphertext); },
  };
  const repository = {
    async persist(input: { readonly items: readonly unknown[] }) {
      calls.persist += 1;
      return { received: input.items.length, inserted: input.items.length, duplicate: 0, quarantined: 0 };
    },
  } as unknown as MetaWebhookRepository;
  const service = new MetaWebhookIngressService(
    new MetaWebhookConfigurationResolver([fakeProfile()], 'test'), secrets, protector, repository,
  );

  assert.equal(await service.challenge({ appConfigRef: 'synthetic-config', mode: 'subscribe',
    verifyToken: verificationToken, challenge: 'synthetic-challenge' }), 'synthetic-challenge');
  assert.equal(calls.verification, 1);
  assert.equal(calls.appSecret, 0);
  await assert.rejects(service.ingest({ appConfigRef: 'synthetic-config', rawBody: Buffer.from('{', 'utf8'), signature: 'sha256=bad' }), MetaWebhookSignatureError);
  assert.equal(calls.protect, 0);
  assert.equal(calls.persist, 0);
});

test('ingress persists signature-verification evidence before it reports successful receipt', async () => {
  const raw = envelope();
  const profile = fakeProfile();
  const secrets: MetaWebhookSecretProvider = {
    async verificationToken() { return verificationToken; },
    async appSecretVersions() { return [appSecret]; },
  };
  const protector: MetaWebhookPayloadProtector = {
    async protect(input) { return protectedPayload(input.reference, input.rawBody); },
    async unprotect(value) { return Buffer.from(value.ciphertext); },
  };
  let commit!: () => void;
  const committed = new Promise<void>((resolve) => { commit = resolve; });
  let beginPersist!: () => void;
  const persistenceStarted = new Promise<void>((resolve) => { beginPersist = resolve; });
  let verifiedAt: Date | undefined;
  const repository = {
    async persist(input: { readonly signatureVerifiedAt: Date }) {
      verifiedAt = input.signatureVerifiedAt;
      beginPersist();
      await committed;
      return { received: 4, inserted: 4, duplicate: 0, quarantined: 0 };
    },
  } as unknown as MetaWebhookRepository;
  const service = new MetaWebhookIngressService(new MetaWebhookConfigurationResolver([profile], 'test'), secrets, protector, repository);
  let settled = false;
  const receivedAt = new Date('2000-01-01T00:00:00.000Z');
  const pending = service.ingest({ appConfigRef: 'synthetic-config', rawBody: raw, signature: signature(raw), receivedAt })
    .then((value) => { settled = true; return value; });
  await persistenceStarted;
  assert.equal(settled, false);
  assert.ok(verifiedAt instanceof Date);
  assert.ok(verifiedAt.getTime() > receivedAt.getTime());
  commit();
  assert.equal((await pending).inserted, 4);
  assert.equal(settled, true);
});

test('unknown, conflicting, and missing asset references persist tenantless quarantine items', async () => {
  const missingPhoneMetadata = Buffer.from(JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'synthetic-waba-missing-phone', changes: [{ field: 'messages', value: {
      messages: [{ id: 'wamid.synthetic.missing-phone', timestamp: '1793980800', type: 'text' }],
      statuses: [{ id: 'wamid.synthetic.missing-phone', status: 'delivered', timestamp: '1793980801' }],
    } }] }],
  }), 'utf8');
  const scenarios = [
    { raw: envelope(), routes: [], reason: 'UNKNOWN_ASSET' },
    { routes: [
      { tenant_id: 'tenant-synthetic-a', app_configuration_id: 'config-synthetic-a', asset_id: 'asset-synthetic-a' },
      { tenant_id: 'tenant-synthetic-b', app_configuration_id: 'config-synthetic-b', asset_id: 'asset-synthetic-b' },
    ], raw: envelope(), reason: 'CONFLICTING_ASSET_OWNER' },
    { raw: missingPhoneMetadata, routes: [], reason: 'RESOURCE_REFERENCE_MISSING' },
  ];
  for (const { raw, routes, reason } of scenarios) {
    const inserted: unknown[][] = [];
    const manager = {
      async query(sql: string, parameters: unknown[] = []) {
        if (sql.includes('SELECT event_ref FROM ca_meta_webhook_events')) return [];
        if (sql.includes('SELECT asset.tenant_id')) return routes;
        if (sql.includes('INSERT INTO ca_meta_webhook_events')) { inserted.push(parameters); return []; }
        if (sql.includes('SELECT id, event_ref') && sql.includes('FOR UPDATE')) {
          const row = inserted[inserted.length - 1];
          return [{ id: row?.[0], event_ref: row?.[3] }];
        }
        return [];
      },
    };
    const dataSource = {
      manager,
      async transaction<T>(callback: (value: typeof manager) => Promise<T>) { return callback(manager); },
    };
    const repository = new MetaWebhookRepository({ async getDataSource() { return dataSource; } } as never);
    const item = parseMetaWebhookDelivery(raw).items[0];
    assert.ok(item);
    const result = await repository.persist({
      application: { configurationRef: 'synthetic-config', providerAppId: '1234567890', environment: 'test', appSecretRef: 'secret-ref', providerAppIdRef: 'app-ref' },
      items: [item], rawBody: raw, payload: protectedPayload('12345678-1234-4123-8123-123456789abc', raw),
      receivedAt: new Date(), signatureVerifiedAt: new Date(),
    });
    assert.equal(result.quarantined, 1);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0]?.[17], null);
    assert.equal(inserted[0]?.[18], null);
    assert.equal(inserted[0]?.[19], null);
    assert.equal(inserted[0]?.[20], 'QUARANTINED');
    assert.equal(inserted[0]?.[21], 'BLOCKED');
    assert.equal(inserted[0]?.[22], reason);
  }
});

test('concurrent redelivery acknowledges only after the unique-key winner is visible', async () => {
  const raw = envelope();
  const item = parseMetaWebhookDelivery(raw).items[0];
  assert.ok(item);
  let eventInsertCount = 0;
  let deliveryDeleteCount = 0;
  const manager = {
    async query(sql: string) {
      if (sql.includes('SELECT event_ref FROM ca_meta_webhook_events') && !sql.includes('FOR UPDATE')) return [];
      if (sql.includes('SELECT asset.tenant_id')) return [
        { tenant_id: 'tenant-synthetic-a', app_configuration_id: 'config-synthetic-a', asset_id: 'asset-synthetic-a' },
      ];
      if (sql.includes('INSERT INTO ca_meta_webhook_events')) { eventInsertCount += 1; return []; }
      if (sql.includes('SELECT id, event_ref') && sql.includes('FOR UPDATE')) return [{ id: 'winner-event-row', event_ref: item.eventRef }];
      if (sql.includes('DELETE FROM ca_meta_webhook_deliveries')) { deliveryDeleteCount += 1; return { affectedRows: 1 }; }
      return [];
    },
  };
  const dataSource = { manager, async transaction<T>(callback: (value: typeof manager) => Promise<T>) { return callback(manager); } };
  const repository = new MetaWebhookRepository({ async getDataSource() { return dataSource; } } as never);
  const result = await repository.persist({
    application: { configurationRef: 'synthetic-config', providerAppId: '1234567890', environment: 'test', appSecretRef: 'secret-ref', providerAppIdRef: 'app-ref' },
    items: [item], rawBody: raw, payload: protectedPayload('12345678-1234-4123-8123-123456789abc', raw),
    receivedAt: new Date(), signatureVerifiedAt: new Date(),
  });
  assert.equal(eventInsertCount, 1);
  assert.equal(deliveryDeleteCount, 1);
  assert.deepEqual(result, { received: 1, inserted: 0, duplicate: 1, quarantined: 0 });
});

test('database commit failure rejects ingress so the controller cannot acknowledge success', async () => {
  const secrets: MetaWebhookSecretProvider = {
    async verificationToken() { return verificationToken; },
    async appSecretVersions() { return [appSecret]; },
  };
  const protector: MetaWebhookPayloadProtector = {
    async protect(input) { return protectedPayload(input.reference, input.rawBody); },
    async unprotect(value) { return Buffer.from(value.ciphertext); },
  };
  const manager = { async query() { return []; } };
  const database = {
    manager,
    async transaction() { throw new Error('synthetic commit failure'); },
  };
  const repository = new MetaWebhookRepository({ async getDataSource() { return database; } } as never);
  const service = new MetaWebhookIngressService(
    new MetaWebhookConfigurationResolver([fakeProfile()], 'test'), secrets, protector, repository,
  );
  const raw = envelope();
  await assert.rejects(service.ingest({ appConfigRef: 'synthetic-config', rawBody: raw, signature: signature(raw) }), /commit failure/);
});

test('worker retries a local handler failure with a fenced lease and a safe error code', async () => {
  const raw = envelope();
  const parsed = parseMetaWebhookDelivery(raw);
  const locator = parsed.items[0]?.locator;
  assert.ok(locator);
  let finalized: unknown;
  const repository = {
    async claimNext() {
      return {
        id: 'item-synthetic-1', eventRef: 'a'.repeat(64), eventType: 'meta.webhook.message',
        eventKey: 'a'.repeat(64), schemaVersion: 1, itemKind: 'messages', providerTimestamp: null,
        providerMessageId: 'wamid.synthetic.1', providerStatus: null, providerStatusRank: null,
        statusLease: null,
        tenantId: 'tenant-synthetic-1', appConfigurationId: 'config-synthetic-1', assetId: 'asset-synthetic-1',
        attempt: 1, leaseVersion: 4, payload: protectedPayload('12345678-1234-4123-8123-123456789abc', raw), locator,
      };
    },
    async finalize(input: unknown) { finalized = input; },
  } as unknown as MetaWebhookRepository;
  const protector: MetaWebhookPayloadProtector = {
    async protect(input) { return protectedPayload(input.reference, input.rawBody); },
    async unprotect(value) { return Buffer.from(value.ciphertext); },
  };
  const worker = new MetaWebhookWorker(repository, protector, {
    async process() { throw new Error('synthetic provider body must not enter an error code'); },
  }, 'synthetic-worker-1');
  assert.equal(await worker.runOne(), true);
  assert.deepEqual(finalized, {
    eventId: 'item-synthetic-1', workerRef: 'synthetic-worker-1', leaseVersion: 4,
    state: 'RETRY_PENDING', safeErrorCode: 'DEPENDENCY_UNAVAILABLE',
    statusLease: null,
  });
});

test('worker passes the status fence to the local processor and releases its claim on finalize', async () => {
  const raw = envelope();
  const locator = parseMetaWebhookDelivery(raw).items[0]?.locator;
  assert.ok(locator);
  const statusLease = {
    tenantId: 'tenant-synthetic-1', appConfigurationId: 'config-synthetic-1', environment: 'test',
    assetId: 'asset-synthetic-1', providerMessageId: 'wamid.synthetic.1', workerRef: 'synthetic-worker-1',
    leaseToken: '12345678-1234-4123-8123-123456789abc', leaseVersion: 8,
    providerTimestamp: '2026-11-06T10:00:00.000Z', eventKey: 'b'.repeat(64),
  };
  let processorInput: unknown;
  let finalized: unknown;
  const repository = {
    async claimNext() {
      return {
        id: 'item-synthetic-status', eventRef: statusLease.eventKey, eventKey: statusLease.eventKey,
        schemaVersion: 1, eventType: 'meta.webhook.statuses', itemKind: 'statuses',
        providerTimestamp: statusLease.providerTimestamp, providerMessageId: statusLease.providerMessageId,
        providerStatus: 'delivered', providerStatusRank: 20,
        statusLease, tenantId: statusLease.tenantId, appConfigurationId: statusLease.appConfigurationId,
        assetId: statusLease.assetId, attempt: 1, leaseVersion: 3,
        payload: protectedPayload('12345678-1234-4123-8123-123456789abc', raw), locator,
      };
    },
    async finalize(input: unknown) { finalized = input; },
  } as unknown as MetaWebhookRepository;
  const protector: MetaWebhookPayloadProtector = {
    async protect(input) { return protectedPayload(input.reference, input.rawBody); },
    async unprotect(value) { return Buffer.from(value.ciphertext); },
  };
  const worker = new MetaWebhookWorker(repository, protector, {
    async process(input) { processorInput = input; return { kind: 'SUCCEEDED' }; },
  }, 'synthetic-worker-1');
  assert.equal(await worker.runOne(), true);
  assert.deepEqual((processorInput as { statusFence: unknown }).statusFence, {
    leaseVersion: 8, leaseToken: statusLease.leaseToken,
    eventKey: 'b'.repeat(64), providerTimestamp: statusLease.providerTimestamp,
  });
  assert.deepEqual(finalized, {
    eventId: 'item-synthetic-status', workerRef: 'synthetic-worker-1', leaseVersion: 3,
    state: 'PROCESSED', statusLease,
  });
});
