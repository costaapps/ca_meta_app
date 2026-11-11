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
const { ConfiguredServiceCredentialVerifier } = requireFromApi('./identity/configured-service-credential.verifier.js');
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
  const allowedScopes = options.scopes ?? ['META_CONNECTION_EXECUTE', 'CREDENTIAL_USE'];
  const proof = options.proof ?? PROOF_A;
  const tenant = options.tenant ?? TENANT_A;
  const verifier = new ConfiguredServiceCredentialVerifier([{ principalId: PRINCIPAL_A, tenantId: tenant, credentialSha256: HASH(proof) }]);
  const authorization = new ServiceTenantAuthorizationService({
    async findServiceTenantGrant(principalId, tenantId) {
      if (principalId !== PRINCIPAL_A || tenantId !== tenant || options.grantRevoked) return undefined;
      return { tenantId, principalId, principalKind: 'SERVICE', principalStatus: 'ACTIVE', tenantStatus: 'ACTIVE', scopes: allowedScopes };
    },
  });
  const store = new FakeOperationStore();
  const calls = { resolver: 0, targetResolver: 0, adapter: 0, command: undefined, resolverContext: undefined };
  const credentials = {
    async resolve(context) {
      calls.resolver += 1;
      calls.resolverContext = context;
      if (options.credentialDenied) throw new Error('synthetic-credential-grant-denied');
      return { handle: Object.freeze({}), status: 'READY' };
    },
  };
  const assets = {
    async findAuthorizedAsset(input) {
      if (options.assetMissing || input.assetId !== ASSET_A) return undefined;
      return { tenantId: options.assetTenant ?? tenant, assetId: ASSET_A, appConfigurationId: '60000000-0000-4000-8000-000000000001',
        environment: 'test', flowVariant: 'WHATSAPP_EXCLUSIVE', authVariant: 'WHATSAPP_EMBEDDED_SIGNUP', providerObjectId: 'synthetic-provider-object' };
    },
  };
  const capabilityEnabled = options.capabilityEnabled !== false;
  const profile = { configurationRef: 'synthetic-config', flowVariant: 'WHATSAPP_EXCLUSIVE', authVariant: 'WHATSAPP_EMBEDDED_SIGNUP', enabled: true };
  const registry = {
    resolve: () => options.configurationMissing ? undefined : profile,
    bootstrap: () => ({ profiles: [{ ...profile, capabilities: [
      { operation: 'SEND_MESSAGE', enabled: capabilityEnabled },
      { operation: 'MANAGE_TEMPLATES', enabled: capabilityEnabled },
      { operation: 'MANAGE_COMMENTS', enabled: capabilityEnabled },
      { operation: 'READ_STATUS', enabled: capabilityEnabled },
      { operation: 'SUBSCRIBE_WEBHOOKS', enabled: capabilityEnabled },
    ] }] }),
  };
  const adapter = {
    available: options.adapterAvailable !== false,
    async execute(input) {
      calls.adapter += 1;
      calls.command = input.command;
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
  const request = (payload = sendPayload(), key = IDEM, assetId = ASSET_A) => ({
    authorization: `Bearer ${proof}`, assetId, idempotencyKey: key, payload,
  });
  return { service, store, calls, request, verifier, tenant, proof };
}

test('service proof rotation overlaps hashes; removing the old hash revokes it', async () => {
  const rotating = new ConfiguredServiceCredentialVerifier([
    { principalId: PRINCIPAL_A, tenantId: TENANT_A, credentialSha256: HASH(PROOF_A) },
    { principalId: PRINCIPAL_A, tenantId: TENANT_A, credentialSha256: HASH(PROOF_B) },
  ]);
  assert.equal((await rotating.verifyCredential(PROOF_A))?.tenantId, TENANT_A);
  assert.equal((await rotating.verifyCredential(PROOF_B))?.tenantId, TENANT_A);
  const afterRevocation = new ConfiguredServiceCredentialVerifier([
    { principalId: PRINCIPAL_A, tenantId: TENANT_A, credentialSha256: HASH(PROOF_B) },
  ]);
  assert.equal(await afterRevocation.verifyCredential(PROOF_A), undefined);
  assert.equal((await afterRevocation.verifyCredential(PROOF_B))?.principalId, PRINCIPAL_A);
});

test('proof verification is tenant-bound and a missing proof is rejected', async () => {
  const verifier = new ConfiguredServiceCredentialVerifier([{ principalId: PRINCIPAL_A, tenantId: TENANT_A, credentialSha256: HASH(PROOF_A) }]);
  assert.equal((await verifier.verifyCredential(PROOF_A))?.tenantId, TENANT_A);
  assert.equal(await verifier.verifyCredential(PROOF_B), undefined);
  assert.equal(await verifier.verifyCredential(undefined), undefined);
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
  const exact = await run(`/internal/v1/assets/${ASSET_A}/operations`);
  assert.equal(exact.continued, true);
  const extra = await run(`/internal/v1/assets/${ASSET_A}/operations/other`);
  assert.equal(extra.continued, false);
  assert.equal(extra.statusCode, 403);
  const prefixed = await run(`/api/v1/internal/v1/assets/${ASSET_A}/operations`);
  assert.equal(prefixed.continued, false);
  assert.equal(prefixed.statusCode, 403);
  const browserOrigin = await run(`/internal/v1/assets/${ASSET_A}/operations`, 'https://evil.example');
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
  assert.ok(consumerMap.consumers.some((consumer) => consumer.id === 'whatsapp-template-create' &&
    consumer.typedOperation.operation === 'MANAGE_TEMPLATES'));
  assert.ok(consumerMap.consumers.some((consumer) => consumer.id === 'whatsapp-template-notification-send' &&
    consumer.typedOperation.operation === 'SEND_MESSAGE'));
  assert.ok(consumerMap.consumers.every((consumer) => consumer.migrationState !== 'MIGRATED'));
});
