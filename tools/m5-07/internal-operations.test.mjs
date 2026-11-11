import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const localRequire = createRequire(import.meta.url);
localRequire('reflect-metadata');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const apiDist = process.env.M5_07_API_DIST;
assert.ok(apiDist && apiDist.startsWith(root), 'the focused runner must provide a temporary compiled API path');
const requireFromApi = createRequire(resolve(apiDist, 'app.module.js'));
const { ConfiguredServiceProofVerifier } = requireFromApi('./identity/service-proof.verifier.js');
const { ServiceTenantAuthorizationService } = requireFromApi('./identity/identity.service.js');
const { IdentityDeniedError } = requireFromApi('./identity/identity.errors.js');
const { InternalAssetOperationsService } = requireFromApi('./internal-operations/internal-asset-operations.service.js');
const {
  InternalAssetOperationIdempotencyConflictError,
  InternalAssetOperationInputError,
  InternalAssetOperationUnavailableError,
  parseInternalAssetOperation,
} = requireFromApi('./internal-operations/internal-operations.validation.js');
const { portalRequestSecurityMiddleware } = requireFromApi('./common/security/portal-request-security.js');
const { INTERNAL_ASSET_OPERATIONS_MIGRATION } = requireFromApi('./database/migrations/internal-asset-operations.js');

const TENANT_A = '10000000-0000-4000-8000-000000000001';
const TENANT_B = '10000000-0000-4000-8000-000000000002';
const PRINCIPAL_A = '20000000-0000-4000-8000-000000000001';
const ASSET_A = '30000000-0000-4000-8000-000000000001';
const ASSET_B = '30000000-0000-4000-8000-000000000002';
const OPERATION_ID = '40000000-0000-4000-8000-000000000001';
const PROOF_A = 'm5-service-proof-abcdefghijklmnopqrstuvwxyz-0123456789';
const PROOF_B = 'm5-service-proof-rotation-abcdefghijklmnopqrstuvwxyz-0123';
const MESSAGE_TEXT = 'fixture message body must never be persisted';
const IDEM = 'm5-07-idempotency-key-0001';
const HASH = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

function sendPayload(text = MESSAGE_TEXT) {
  return parseInternalAssetOperation({ operation: 'SEND_MESSAGE', recipientRef: '50000000-0000-4000-8000-000000000001',
    message: { kind: 'TEXT', text } });
}

class FakeOperationStore {
  rows = new Map();
  claims = 0;
  audit = [];

  async findByIdempotency(input) {
    const key = [input.tenantId, input.servicePrincipalId, input.assetId, input.operation, input.idempotencyKeyHash].join('|');
    const prior = this.rows.get(key);
    if (prior && prior.payloadHash !== input.payloadHash) throw new InternalAssetOperationIdempotencyConflictError();
    return prior;
  }

  async claim(input) {
    const key = [input.tenantId, input.servicePrincipalId, input.assetId, input.operation, input.idempotencyKeyHash].join('|');
    const prior = this.rows.get(key);
    if (prior) {
      if (prior.payloadHash !== input.payloadHash) throw new InternalAssetOperationIdempotencyConflictError();
      return { row: prior, isNew: false };
    }
    this.claims += 1;
    const row = Object.freeze({ operationId: input.operationId, tenantId: input.tenantId,
      servicePrincipalId: input.servicePrincipalId, assetId: input.assetId, operation: input.operation,
      payloadHash: input.payloadHash, status: 'UNKNOWN', createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z' });
    this.rows.set(key, row);
    this.audit.push({ status: 'UNKNOWN', reasonCode: 'OPERATION_ACCEPTED' });
    return { row, isNew: true };
  }

  async complete(input) {
    for (const [key, row] of this.rows) {
      if (row.operationId !== input.operationId) continue;
      const next = Object.freeze({ ...row, status: input.status, ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
        ...(input.providerReferenceHash ? { providerReferenceHash: input.providerReferenceHash } : {}),
        updatedAt: '2026-11-11T00:00:01.000Z' });
      this.rows.set(key, next);
      this.audit.push({ status: input.status, ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}) });
      return next;
    }
    throw new Error('synthetic-operation-row-missing');
  }

  async find(input) {
    return [...this.rows.values()].find((row) => row.operationId === input.operationId &&
      row.tenantId === input.tenantId && row.servicePrincipalId === input.servicePrincipalId);
  }
}

function setup(options = {}) {
  const defaultScopes = ['META_CONNECTION_EXECUTE', 'CREDENTIAL_USE'];
  const proof = options.proof ?? PROOF_A;
  const tenant = options.tenant ?? TENANT_A;
  const assetId = options.assetId ?? ASSET_A;
  const appConfigurationId = options.appConfigurationId ?? '60000000-0000-4000-8000-000000000001';
  const flowVariant = options.flowVariant ?? 'WHATSAPP_EXCLUSIVE';
  const authVariant = options.authVariant ?? 'WHATSAPP_EMBEDDED_SIGNUP';
  const verifier = new ConfiguredServiceProofVerifier([{ principalId: PRINCIPAL_A, tenantId: tenant, credentialSha256: HASH(proof) }]);
  const authorization = new ServiceTenantAuthorizationService({
    async findServiceTenantGrant(principalId, tenantId) {
      if (principalId !== PRINCIPAL_A || tenantId !== tenant || options.grantRevoked) return undefined;
      return { tenantId, principalId, principalKind: 'SERVICE', principalStatus: 'ACTIVE', tenantStatus: 'ACTIVE', scopes: options.scopes ?? defaultScopes };
    },
  });
  const store = new FakeOperationStore();
  const calls = { resolver: 0, targetResolver: 0, adapter: 0, command: undefined, resolverContext: undefined, credentialHandle: undefined };
  const credentials = {
    async resolve(context) {
      calls.resolver += 1;
      calls.resolverContext = context;
      if (options.credentialDenied) throw new Error('synthetic-credential-grant-denied');
      return { handle: Object.freeze({ assetId: context.assetId, appConfigurationId: context.appConfigurationId }), status: 'READY' };
    },
  };
  const assets = {
    async findAuthorizedAsset(input) {
      if (options.assetMissing || input.assetId !== assetId) return undefined;
      return { tenantId: options.assetTenant ?? tenant, assetId, appConfigurationId,
        environment: 'test', flowVariant, authVariant, providerObjectId: `synthetic-provider-object-${assetId}` };
    },
  };
  const profile = { configurationRef: `synthetic-config-${appConfigurationId}`, flowVariant, authVariant, enabled: true };
  const registry = {
    resolve: () => options.configurationMissing ? undefined : profile,
    bootstrap: () => ({ profiles: [{ ...profile, capabilities: [
      { operation: 'SEND_MESSAGE', enabled: options.capabilityEnabled !== false },
      { operation: 'MANAGE_TEMPLATES', enabled: options.capabilityEnabled !== false },
      { operation: 'MANAGE_COMMENTS', enabled: options.capabilityEnabled !== false },
      { operation: 'READ_STATUS', enabled: options.capabilityEnabled !== false },
      { operation: 'SUBSCRIBE_WEBHOOKS', enabled: options.capabilityEnabled !== false },
    ] }] }),
  };
  const adapter = {
    get available() { return options.adapterAvailable !== false; },
    async execute(input) {
      calls.adapter += 1;
      calls.command = input.command;
      calls.credentialHandle = input.credentialHandle;
      if (options.adapterGate) {
        options.adapterGate.markStarted();
        await options.adapterGate.wait;
      }
      if (options.adapterThrows) throw new Error('synthetic-timeout-after-submit');
      const referenceHash = HASH('synthetic-provider-reference');
      return options.adapterOutcome ?? { status: 'SUCCEEDED', providerReferenceHash: referenceHash };
    },
  };
  const targets = {
    async resolveTarget(input) {
      calls.targetResolver += 1;
      if (options.targetDenied) return undefined;
      return input.targetKind === 'RECIPIENT' ? 'synthetic-recipient-ref' : 'synthetic-comment-ref';
    },
  };
  const service = new InternalAssetOperationsService(verifier, authorization, credentials, registry, assets, store, targets, adapter, { nodeEnv: 'test' });
  const request = (payload = sendPayload(), key = IDEM, requestedAssetId = assetId) => ({
    authorization: `Bearer ${proof}`, assetId: requestedAssetId, idempotencyKey: key, payload,
  });
  return { service, store, calls, request, verifier, tenant, proof, options, assetId, appConfigurationId, flowVariant, authVariant };
}

test('service proof rotation overlaps hashes; removing the old hash revokes it', async () => {
  const rotating = new ConfiguredServiceProofVerifier([
    { principalId: PRINCIPAL_A, tenantId: TENANT_A, credentialSha256: HASH(PROOF_A) },
    { principalId: PRINCIPAL_A, tenantId: TENANT_A, credentialSha256: HASH(PROOF_B) },
  ]);
  assert.equal((await rotating.verifyCredential(PROOF_A))?.tenantId, TENANT_A);
  assert.equal((await rotating.verifyCredential(PROOF_B))?.tenantId, TENANT_A);
  const afterRevocation = new ConfiguredServiceProofVerifier([
    { principalId: PRINCIPAL_A, tenantId: TENANT_A, credentialSha256: HASH(PROOF_B) },
  ]);
  assert.equal(await afterRevocation.verifyCredential(PROOF_A), undefined);
  assert.equal((await afterRevocation.verifyCredential(PROOF_B))?.principalId, PRINCIPAL_A);
});

test('proof verification is tenant-bound and a missing proof is rejected', async () => {
  const verifier = new ConfiguredServiceProofVerifier([{ principalId: PRINCIPAL_A, tenantId: TENANT_A, credentialSha256: HASH(PROOF_A) }]);
  assert.equal((await verifier.verifyCredential(PROOF_A))?.tenantId, TENANT_A);
  assert.equal(await verifier.verifyCredential(PROOF_B), undefined);
  assert.equal(await verifier.verifyCredential(undefined), undefined);
});

test('four flow/auth pairs resolve distinct M3.08 handles from tenant asset context', async () => {
  const cases = [
    ['FACEBOOK', 'FACEBOOK_LOGIN_FOR_BUSINESS'],
    ['INSTAGRAM', 'INSTAGRAM_VIA_FACEBOOK_LOGIN'],
    ['WHATSAPP_EXCLUSIVE', 'WHATSAPP_EMBEDDED_SIGNUP'],
    ['WHATSAPP_COEXISTENCE', 'WHATSAPP_BUSINESS_APP_ONBOARDING'],
  ];
  const states = cases.map(([flowVariant, authVariant], index) => setup({
    assetId: `30000000-0000-4000-8000-00000000000${index + 1}`,
    appConfigurationId: `60000000-0000-4000-8000-00000000000${index + 1}`,
    flowVariant,
    authVariant,
  }));
  const handles = [];
  for (let index = 0; index < states.length; index += 1) {
    const state = states[index];
    const result = await state.service.execute(state.request({ operation: 'READ_STATUS' }, `m5-flow-idempotency-${index}-0001`));
    assert.equal(result.status, 'SUCCEEDED');
    assert.deepEqual(state.calls.resolverContext, {
      tenantId: TENANT_A,
      provider: 'META',
      appConfigurationId: state.appConfigurationId,
      environment: 'test',
      assetId: state.assetId,
      operation: 'READ_STATUS',
    });
    assert.equal(state.calls.command.context.flowVariant, state.flowVariant);
    assert.equal(state.calls.command.context.authVariant, state.authVariant);
    assert.equal(state.calls.command.context.assetId, state.assetId);
    assert.equal(state.calls.credentialHandle.assetId, state.assetId);
    handles.push(state.calls.credentialHandle);
  }
  assert.equal(new Set(handles).size, 4);
});

test('closed operation payloads reject caller tenant, generic Graph URL and untyped fields', () => {
  assert.throws(() => parseInternalAssetOperation({ operation: 'SEND_MESSAGE', recipientRef: '50000000-0000-4000-8000-000000000001',
    message: { kind: 'TEXT', text: 'safe' }, tenantId: TENANT_B }), InternalAssetOperationInputError);
  assert.throws(() => parseInternalAssetOperation({ operation: 'GRAPH_REQUEST', url: 'https://graph.example/v1', method: 'POST' }), InternalAssetOperationInputError);
  assert.throws(() => parseInternalAssetOperation({ operation: 'MANAGE_TEMPLATES', action: 'CREATE', name: 'x', language: 'en',
    category: 'UTILITY', bodyText: 'text', token: 'not accepted' }), InternalAssetOperationInputError);
  assert.deepEqual(parseInternalAssetOperation({ operation: 'SEND_MESSAGE', recipientRef: '50000000-0000-4000-8000-000000000001',
    message: { kind: 'TEMPLATE', name: 'welcome', language: 'pt_BR', parameters: ['one', 'two'] } }).message.parameters, ['one', 'two']);
  assert.deepEqual(parseInternalAssetOperation({ operation: 'MANAGE_TEMPLATES', action: 'CREATE', name: 'welcome', language: 'pt_BR',
    category: 'UTILITY', bodyText: 'Hello {{1}}', exampleValues: ['World'] }).exampleValues, ['World']);
});

test('missing META_CONNECTION_EXECUTE or CREDENTIAL_USE grant denies before claiming an operation', async (t) => {
  for (const scopes of [['CREDENTIAL_USE'], ['META_CONNECTION_EXECUTE']]) {
    await t.test(scopes.join('+'), async () => {
      const state = setup({ scopes });
      await assert.rejects(state.service.execute(state.request()), IdentityDeniedError);
      assert.equal(state.store.claims, 0);
      assert.equal(state.calls.adapter, 0);
    });
  }
});

test('tenant and asset mismatch fail closed without creating an operation row', async (t) => {
  for (const options of [{ assetMissing: true }, { assetTenant: TENANT_B }]) {
    await t.test(JSON.stringify(options), async () => {
      const state = setup(options);
      await assert.rejects(state.service.execute(state.request()), InternalAssetOperationUnavailableError);
      assert.equal(state.store.claims, 0);
      assert.equal(state.calls.adapter, 0);
    });
  }
  const state = setup();
  await assert.rejects(state.service.execute(state.request(sendPayload(), IDEM, ASSET_B)), InternalAssetOperationUnavailableError);
});

test('disabled Meta operation or missing adapter gate does not claim work or report success', async (t) => {
  for (const options of [{ capabilityEnabled: false }, { adapterAvailable: false }, { configurationMissing: true }]) {
    await t.test(JSON.stringify(options), async () => {
      const state = setup(options);
      await assert.rejects(state.service.execute(state.request()), InternalAssetOperationUnavailableError);
      assert.equal(state.store.claims, 0);
      assert.equal(state.calls.adapter, 0);
    });
  }
});

test('unresolved tenant/asset-bound recipient reference fails before idempotency claim or adapter call', async () => {
  const state = setup({ targetDenied: true });
  await assert.rejects(state.service.execute(state.request()), InternalAssetOperationUnavailableError);
  assert.equal(state.calls.targetResolver, 1);
  assert.equal(state.store.claims, 0);
  assert.equal(state.calls.adapter, 0);
});

test('each supported typed operation performs one synthetic adapter call and replays without a second call', async (t) => {
  const payloads = [
    sendPayload(),
    parseInternalAssetOperation({ operation: 'MANAGE_TEMPLATES', action: 'LIST' }),
    parseInternalAssetOperation({ operation: 'MANAGE_TEMPLATES', action: 'CREATE', name: 'welcome', language: 'pt_BR', category: 'UTILITY', bodyText: 'Hello {{1}}', exampleValues: ['World'] }),
    parseInternalAssetOperation({ operation: 'MANAGE_COMMENTS', action: 'LIST' }),
    parseInternalAssetOperation({ operation: 'MANAGE_COMMENTS', action: 'REPLY', commentRef: '50000000-0000-4000-8000-000000000002', text: 'Synthetic reply' }),
    parseInternalAssetOperation({ operation: 'READ_STATUS' }),
    parseInternalAssetOperation({ operation: 'SUBSCRIBE_WEBHOOKS', action: 'READ' }),
    parseInternalAssetOperation({ operation: 'SUBSCRIBE_WEBHOOKS', action: 'RECONCILE' }),
  ];
  for (let index = 0; index < payloads.length; index += 1) {
    await t.test(payloads[index].operation + (payloads[index].action ? `/${payloads[index].action}` : ''), async () => {
      const state = setup();
      const key = `m5-supported-operation-${index}-0001`;
      const first = await state.service.execute(state.request(payloads[index], key));
      const replay = await state.service.execute(state.request(payloads[index], key));
      assert.equal(first.status, 'SUCCEEDED');
      assert.equal(replay.operationId, first.operationId);
      assert.equal(replay.status, 'SUCCEEDED');
      assert.equal(state.store.claims, 1);
      assert.equal(state.calls.adapter, 1);
      assert.equal(state.calls.resolver, 1);
      const needsTarget = payloads[index].operation === 'SEND_MESSAGE' ||
        (payloads[index].operation === 'MANAGE_COMMENTS' && payloads[index].action === 'REPLY');
      assert.equal(state.calls.targetResolver, needsTarget ? 1 : 0);
    });
  }
});

test('completed idempotent replay survives changed execution gates after current tenant/asset revalidation', async () => {
  const state = setup();
  const original = await state.service.execute(state.request());
  const previous = { resolver: state.calls.resolver, targetResolver: state.calls.targetResolver, adapter: state.calls.adapter };

  state.options.scopes = ['META_CONNECTION_EXECUTE'];
  state.options.capabilityEnabled = false;
  state.options.configurationMissing = true;
  state.options.adapterAvailable = false;
  state.options.targetDenied = true;

  const replay = await state.service.execute(state.request());
  assert.equal(replay.operationId, original.operationId);
  assert.equal(replay.status, 'SUCCEEDED');
  assert.equal(state.calls.resolver, previous.resolver);
  assert.equal(state.calls.targetResolver, previous.targetResolver);
  assert.equal(state.calls.adapter, previous.adapter);
  assert.equal(state.store.claims, 1);
  await assert.rejects(
    state.service.execute(state.request(sendPayload('different replay body'))),
    InternalAssetOperationIdempotencyConflictError,
  );
  assert.equal(state.calls.adapter, previous.adapter);
});

test('concurrent identical requests produce one adapter execution and replay one operationId', async () => {
  const state = setup();
  const [first, second] = await Promise.all([state.service.execute(state.request()), state.service.execute(state.request())]);
  assert.equal(state.calls.adapter, 1);
  assert.equal(state.store.claims, 1);
  assert.equal(first.operationId, second.operationId);
  assert.equal(first.status, 'SUCCEEDED');
  // A duplicate arriving while the first send is still in flight observes the
  // ledger's initial UNKNOWN state. The status route can later return terminal state.
  assert.ok(['UNKNOWN', 'SUCCEEDED'].includes(second.status));
  const completedReplay = await state.service.execute(state.request());
  assert.equal(completedReplay.operationId, first.operationId);
  assert.equal(completedReplay.status, 'SUCCEEDED');
  await assert.rejects(state.service.execute(state.request(sendPayload('different body'))), InternalAssetOperationIdempotencyConflictError);
  assert.equal(state.calls.adapter, 1);
});

test('concurrent UNKNOWN observation transitions to terminal on the same operationId', async () => {
  let signalStarted;
  let releaseAdapter;
  const adapterGate = {
    started: new Promise((resolve) => { signalStarted = resolve; }),
    wait: new Promise((resolve) => { releaseAdapter = resolve; }),
    markStarted() { signalStarted(); },
  };
  const state = setup({ adapterGate });
  const originalPromise = state.service.execute(state.request());
  await adapterGate.started;

  const inFlightReplay = await state.service.execute(state.request());
  assert.equal(inFlightReplay.status, 'UNKNOWN');
  assert.equal(state.calls.adapter, 1);

  releaseAdapter();
  const completed = await originalPromise;
  assert.equal(completed.status, 'SUCCEEDED');
  assert.equal(completed.operationId, inFlightReplay.operationId);

  const terminalReplay = await state.service.execute(state.request());
  assert.equal(terminalReplay.status, 'SUCCEEDED');
  assert.equal(terminalReplay.operationId, inFlightReplay.operationId);
  assert.equal(state.store.claims, 1);
  assert.equal(state.calls.adapter, 1);
});

test('ambiguous adapter result stays UNKNOWN and the same key is never resent', async () => {
  const state = setup({ adapterThrows: true });
  const first = await state.service.execute(state.request());
  const replay = await state.service.execute(state.request());
  assert.equal(first.status, 'UNKNOWN');
  assert.equal(first.operationId, replay.operationId);
  assert.equal(replay.status, 'UNKNOWN');
  assert.equal(state.calls.adapter, 1);
  const row = await state.store.find({ operationId: first.operationId, tenantId: TENANT_A, servicePrincipalId: PRINCIPAL_A });
  assert.equal(row.reasonCode, 'PROVIDER_RESULT_UNKNOWN');
});

test('synthetic audit, idempotency ledger, and API response exclude raw proof and message text', async () => {
  const state = setup();
  const result = await state.service.execute(state.request());
  const safeMetadata = JSON.stringify({ result, rows: [...state.store.rows.values()], audit: state.store.audit });
  assert.equal(safeMetadata.includes(PROOF_A), false);
  assert.equal(safeMetadata.includes(MESSAGE_TEXT), false);
  assert.equal(safeMetadata.includes('synthetic-provider-reference'), false);
  assert.match(safeMetadata, /"status":"SUCCEEDED"/);
});

test('internal POST bypass is limited to the exact machine path and absent Origin', async (t) => {
  const middleware = portalRequestSecurityMiddleware({ allowedOrigins: ['https://api.example.test'] }, undefined);
  async function run(path, origin) {
    let continued = false;
    let statusCode;
    const request = { method: 'POST', path, protocol: 'https', headers: { ...(origin ? { origin } : {}) }, get: () => 'api.example.test' };
    const response = { setHeader() {}, vary() {}, status(code) { statusCode = code; return this; }, json() { return this; }, end() { return this; } };
    await middleware(request, response, () => { continued = true; });
    return { continued, statusCode };
  }
  const exact = await run(`/internal/v2/assets/${ASSET_A}/operations`);
  assert.equal(exact.continued, true);
  const legacyV1 = await run(`/internal/v1/assets/${ASSET_A}/operations`);
  assert.equal(legacyV1.continued, false, 'frozen v1 proposal is not an alias for the new v2 service-proof route');
  assert.equal(legacyV1.statusCode, 403);
  const extra = await run(`/internal/v2/assets/${ASSET_A}/operations/other`);
  assert.equal(extra.continued, false);
  assert.equal(extra.statusCode, 403);
  const prefixed = await run(`/api/v1/internal/v2/assets/${ASSET_A}/operations`);
  assert.equal(prefixed.continued, false);
  assert.equal(prefixed.statusCode, 403);
  const browserOrigin = await run(`/internal/v2/assets/${ASSET_A}/operations`, 'https://evil.example');
  assert.equal(browserOrigin.continued, false);
  assert.equal(browserOrigin.statusCode, 403);
});

test('migration ledger stores hashes/metadata only and registers schema version 21', () => {
  assert.equal(INTERNAL_ASSET_OPERATIONS_MIGRATION.schemaVersion, 21);
  const ddl = INTERNAL_ASSET_OPERATIONS_MIGRATION.steps.map((step) => step.sql).join('\n');
  assert.match(ddl, /idempotency_key_hash/);
  assert.match(ddl, /request_hash/);
  assert.match(ddl, /provider_reference_hash/);
  assert.doesNotMatch(ddl, /payload_json|access_token|credential_secret/i);
});

test('source-derived consumer map keeps external callers unconfirmed and all legacy consumers unmigrated', () => {
  const consumerMap = JSON.parse(readFileSync(new URL('./consumer-map.json', import.meta.url), 'utf8'));
  assert.equal(consumerMap.externalConsumerInventory, 'NOT_CONFIRMED');
  assert.equal(consumerMap.providerTraffic, 'NOT_TESTED');
  assert.match(consumerMap.activationInvariant, /company.*provider IDs alone never select/i);
  assert.ok(consumerMap.consumers.length >= 8);
  for (const consumer of consumerMap.consumers) {
    for (const field of consumerMap.consumerFields) {
      assert.ok(Object.hasOwn(consumer, field), `${consumer.id} is missing ${field}`);
      if (field !== 'typedOperation') assert.ok(consumer[field], `${consumer.id} has an empty ${field}`);
    }
    assert.ok(['NOT_MIGRATED', 'NOT_CONFIRMED'].includes(consumer.migrationState));
    assert.match(consumer.activationCondition, /principal|tenant|inventory/i);
    assert.doesNotMatch(consumer.owner, /backend[\\/](?:connect|connect_old)\.php/i);
  }
  assert.ok(consumerMap.consumers.some((consumer) => consumer.id === 'whatsapp-template-create' &&
    consumer.typedOperation.operation === 'MANAGE_TEMPLATES' && consumer.assetResolution && consumer.authContext));
  assert.ok(consumerMap.consumers.some((consumer) => consumer.id === 'whatsapp-notification-template-send' &&
    consumer.typedOperation.operation === 'SEND_MESSAGE' && /replay/i.test(consumer.equivalenceTest)));
  assert.ok(consumerMap.consumers.some((consumer) => consumer.id === 'facebook-comment-reply' && /commentRef resolver/i.test(consumer.blockReason)));
});
