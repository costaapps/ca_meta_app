import assert from 'node:assert/strict';
import test from 'node:test';
import type { CredentialExecutionContext, CredentialResolutionHandle } from '../src/credentials/credential-resolver.types.js';
import type { MetaAppConfiguration } from '../src/meta-config/meta-app-config.configuration.js';
import { META_CAPABILITY_MANIFEST, META_CAPABILITY_MANIFEST_VERSION, type MetaOperation } from '../src/meta-config/capability-manifest.js';
import { MetaAppConfigRegistry } from '../src/meta-config/meta-app-config.registry.js';
import { InMemoryMetaGraphMetrics, MetaGraphClient } from '../src/meta-graph/meta-graph.client.js';
import { MetaGraphTransportFailure } from '../src/meta-graph/meta-graph.transport.js';
import type { MetaGraphExecutionContext, MetaGraphInput, MetaGraphTransport, MetaGraphTransportRequest, MetaGraphTransportResponse } from '../src/meta-graph/meta-graph.types.js';

const TOKEN = 'synthetic-graph-token-never-return';
const tenantId = '00000000-0000-4000-8000-000000000001';
const appConfigurationId = '00000000-0000-4000-8000-000000000002';
const assetId = '00000000-0000-4000-8000-000000000004';
const providerObjectId = '554433221100';
const correlationId = '00000000-0000-4000-8000-000000000003';
const configRef = 'synthetic-coexistence-v1';

function fixtureProfile(status: 'VERIFIED' | 'NOT_CONFIRMED' = 'VERIFIED'): MetaAppConfiguration {
  const flowVariant = 'WHATSAPP_COEXISTENCE';
  const authVariant = 'WHATSAPP_BUSINESS_APP_ONBOARDING';
  const capabilityEvidence = META_CAPABILITY_MANIFEST.filter((entry) => entry.flowVariant === flowVariant && entry.authVariant === authVariant)
    .map((entry) => ({ operation: entry.operation, permissions: entry.candidatePermissions.map((permission) => ({
      permission, permissionStatus: 'CONFIRMED' as const, accessLevel: 'ADVANCED' as const,
      appReviewStatus: 'APPROVED' as const, sandboxStatus: 'PASSED' as const,
      approvalOwner: 'synthetic-fixture-owner', evidenceUrl: 'https://developers.facebook.com/docs/graph-api/overview/',
    })) }));
  return Object.freeze({
    configurationRef: configRef, environment: 'test', flowVariant, authVariant,
    providerAppIdRef: 'synthetic-provider-app-ref', providerAppId: '1234567890', publicConfigId: 'synthetic-public-config',
    appMode: 'DEVELOPMENT', appDomain: 'test.example.invalid', callbackUri: 'https://test.example.invalid/meta/callback',
    redirectAllowlist: Object.freeze(['https://test.example.invalid/meta/callback']),
    appSecretRef: 'vault://meta-app/test/synthetic/app-secret', tokenConfigurationRef: 'vault://meta-app/test/synthetic/token-config',
    capabilityManifestVersion: META_CAPABILITY_MANIFEST_VERSION, enabled: true,
    versions: Object.freeze({
      graphApi: Object.freeze({ value: 'v27.0', status,
        ...(status === 'VERIFIED' ? { evidenceUrl: 'https://developers.facebook.com/docs/graph-api/overview/', verifiedAt: '2026-11-06' } : {}) }),
      javascriptSdk: Object.freeze({ value: 'v24.0', status: 'VERIFIED' as const,
        evidenceUrl: 'https://developers.facebook.com/docs/javascript/quickstart/', verifiedAt: '2026-11-06' }),
      embeddedSignup: Object.freeze({ value: 'v1.0', status: 'VERIFIED' as const,
        evidenceUrl: 'https://developers.facebook.com/docs/whatsapp/embedded-signup/', verifiedAt: '2026-11-06' }),
    }),
    capabilityEvidence: Object.freeze(capabilityEvidence),
  });
}

function request(endpoint: string, operation: MetaOperation, extra: Record<string, unknown> = {}): MetaGraphInput {
  const context: MetaGraphExecutionContext = {
    tenantId, provider: 'META', appConfigurationId, environment: 'test', assetId, operation,
    flowVariant: 'WHATSAPP_COEXISTENCE', authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING', configurationRef: configRef, providerObjectId,
  };
  return { context, credentialHandle: Object.freeze({}) as CredentialResolutionHandle,
    credentialCapability: operation, operation, correlationId, resourceId: providerObjectId, endpoint, ...extra } as unknown as MetaGraphInput;
}

class FakeCredentials {
  readonly contexts: CredentialExecutionContext[] = [];
  callbacks = 0;
  async withCredentialForContext(_handle: CredentialResolutionHandle, expected: CredentialExecutionContext,
    execute: (secret: string) => Promise<void>): Promise<void> {
    this.contexts.push(expected); this.callbacks += 1; await execute(TOKEN);
  }
}

class SequenceTransport implements MetaGraphTransport {
  readonly calls: MetaGraphTransportRequest[] = [];
  constructor(private readonly replies: Array<MetaGraphTransportResponse | Error | (() => Promise<MetaGraphTransportResponse>)>) {}
  async send(input: MetaGraphTransportRequest): Promise<MetaGraphTransportResponse> {
    this.calls.push(input);
    const next = this.replies.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('synthetic transport fixture exhausted');
    return typeof next === 'function' ? await next() : next;
  }
}

function response(statusCode: number, body: unknown, headers: Record<string, string | undefined> = {}): MetaGraphTransportResponse {
  return { statusCode, headers, body: JSON.stringify(body) };
}
function client(transport: MetaGraphTransport, credentials = new FakeCredentials(), options: ConstructorParameters<typeof MetaGraphClient>[4] = {}) {
  const metrics = new InMemoryMetaGraphMetrics();
  const instance = new MetaGraphClient(new MetaAppConfigRegistry([fixtureProfile()]), credentials, transport, metrics, options);
  return { instance, credentials, metrics };
}

test('synthetic fixture mirrors a fully verified M4.01 profile while pending graph evidence stays blocked', () => {
  const flow = 'WHATSAPP_COEXISTENCE';
  const auth = 'WHATSAPP_BUSINESS_APP_ONBOARDING';
  const verified = new MetaAppConfigRegistry([fixtureProfile()]);
  const profile = verified.bootstrap().profiles.find((row) => row.flowVariant === flow && row.authVariant === auth);
  assert.equal(profile?.enabled, true);
  assert.equal(profile?.capabilities.find((row) => row.operation === 'ASSET_DISCOVERY')?.enabled, true);
  const statusCapability = profile?.capabilities.find((row) => row.operation === 'READ_STATUS');
  assert.equal(statusCapability?.enabled, false);
  assert.equal(statusCapability?.reasonCode, 'PERMISSION_MAPPING_NOT_CONFIRMED');
  assert.ok(verified.resolve(flow, auth, 'test'));

  const pending = new MetaAppConfigRegistry([fixtureProfile('NOT_CONFIRMED')]);
  assert.equal(pending.resolve(flow, auth, 'test'), undefined);
  assert.equal(pending.bootstrap().profiles.find((row) => row.flowVariant === flow && row.authVariant === auth)?.reasonCode,
    'VERSION_EVIDENCE_REQUIRED');
});

test('HTTP 200 Graph error normalizes safe type/code/subcode/trace and omits secrets and nested error details', async () => {
  const transport = new SequenceTransport([response(200, {
    error: { message: 'synthetic-provider-message-secret-marker', type: 'OAuthException', code: 190, error_subcode: 463,
      fbtrace_id: 'trace-safe-123', error: { message: 'nested-secret-marker' } },
    client_secret: 'synthetic-client-secret', input_token: 'synthetic-input-token', fb_exchange_token: 'synthetic-exchange-token',
    code: 'synthetic-code', headers: { authorization: TOKEN },
  })]);
  const runtime = client(transport);
  const result = await runtime.instance.execute(request('SEND_MESSAGE', 'SEND_MESSAGE', { body: { messaging_product: 'whatsapp', text: 'fixture' } }));
  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.error?.category, 'CREDENTIAL_REJECTED');
  assert.equal(result.error?.providerType, 'OAuthException');
  assert.equal(result.error?.providerCode, 190);
  assert.equal(result.error?.providerSubcode, 463);
  assert.equal(result.error?.traceId, 'trace-safe-123');
  assert.equal(result.ambiguous, false);
  assert.equal(JSON.stringify(result).includes('synthetic-provider-message-secret-marker'), false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes('nested-secret-marker'), false);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]?.host, 'graph.facebook.com');
  assert.equal(transport.calls[0]?.path, `/v27.0/${providerObjectId}/messages`);
  assert.equal(transport.calls[0]?.path.includes('access_token'), false);
  assert.notEqual(assetId, providerObjectId, 'internal tenant asset UUID and provider object ID are distinct');
  assert.equal(runtime.credentials.contexts[0]?.assetId, assetId);
  assert.equal(transport.calls[0]?.correlationId, correlationId);
  assert.equal(transport.calls[0]?.headers['authorization'], `Bearer ${TOKEN}`);
  assert.equal(runtime.credentials.callbacks, 1);
});

test('resource ID mismatch against the server-resolved provider object is rejected before credentials', async () => {
  const transport = new SequenceTransport([]);
  const runtime = client(transport);
  const input = request('ASSET_EDGE_LIST', 'ASSET_DISCOVERY', { edge: 'phone_numbers' });
  const mismatched = { ...input, resourceId: '998877665544' } as MetaGraphInput;
  const result = await runtime.instance.execute(mismatched);
  assert.equal(result.error?.category, 'REQUEST_INVALID');
  assert.equal(runtime.credentials.callbacks, 0);
  assert.equal(transport.calls.length, 0);
});

test('collect processes cursor pages with bounds and strips a token query from provider next URLs', async () => {
  const transport = new SequenceTransport([
    response(200, { data: [{ id: 'phone-1', access_token: 'secret-in-row', client_secret: 'synthetic-client-secret',
      input_token: 'synthetic-input-token', fb_exchange_token: 'synthetic-exchange-token', code: 'synthetic-code',
      headers: { authorization: 'secret' } }],
      paging: { next: `https://graph.facebook.com/v27.0/${providerObjectId}/phone_numbers?limit=10&fields=id%2Cdisplay_phone_number&since=123&after=cursor-2&access_token=provider-token-marker` } }),
    response(200, { data: [{ id: 'phone-2' }] }),
  ]);
  const runtime = client(transport);
  const result = await runtime.instance.collect(request('ASSET_EDGE_LIST', 'ASSET_DISCOVERY', { edge: 'phone_numbers', query: { limit: 10 } }));
  assert.equal(result.outcome, 'SUCCEEDED');
  assert.equal(JSON.stringify(result.data), JSON.stringify([{ id: 'phone-1' }, { id: 'phone-2' }]));
  assert.equal(transport.calls.length, 2);
  assert.ok(transport.calls[1]?.path.includes('after=cursor-2'));
  assert.ok(transport.calls[1]?.path.includes('fields=id%2Cdisplay_phone_number'));
  assert.ok(transport.calls[1]?.path.includes('since=123'));
  assert.equal(transport.calls[1]?.path.includes('access_token'), false);
  assert.ok(transport.calls.every((call) => call.host === 'graph.facebook.com'));
  assert.equal(runtime.credentials.callbacks, 1, 'the resolver handle covers every page in one use');
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('uses normalized provider usage headers as an optional conservative quota signal', async () => {
  const transport = new SequenceTransport([response(200, { id: 'first' }, { 'x-app-usage': '{"call_count":100}' })]);
  const runtime = client(transport, new FakeCredentials(), { maxRequestsPerAppWindow: 10, now: () => 20_000 });
  const input = request('ASSET_EDGE_LIST', 'ASSET_DISCOVERY', { edge: 'phone_numbers' });
  assert.equal((await runtime.instance.execute(input)).outcome, 'SUCCEEDED');
  const limited = await runtime.instance.execute(input);
  assert.equal(limited.error?.category, 'REQUEST_BUDGET_EXHAUSTED');
  assert.equal(transport.calls.length, 1);
});

test('hostile next URL is rejected before any follow-up credential transmission', async () => {
  const transport = new SequenceTransport([response(200, { data: [{ id: 'phone-1' }],
    paging: { next: `https://evil.example/v27.0/${providerObjectId}/phone_numbers?after=hostile` } })]);
  const runtime = client(transport);
  const result = await runtime.instance.collect(request('ASSET_EDGE_LIST', 'ASSET_DISCOVERY', { edge: 'phone_numbers' }));
  assert.equal(result.outcome, 'PARTIAL');
  assert.equal(result.error?.category, 'PAGINATION_INVALID');
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]?.host, 'graph.facebook.com');
  assert.equal(runtime.credentials.callbacks, 1);
});

test('429 uses bounded Retry-After and a finite GET retry budget', async () => {
  const delays: number[] = [];
  const transport = new SequenceTransport([
    { statusCode: 429, headers: { 'retry-after': '999', 'content-type': 'text/html' }, body: '<html>synthetic throttled body</html>' },
    response(200, { data: [{ id: 'phone-1' }] }),
  ]);
  const runtime = client(transport, new FakeCredentials(), { sleep: async (ms) => { delays.push(ms); }, random: () => 0 });
  const result = await runtime.instance.collect(request('ASSET_EDGE_LIST', 'ASSET_DISCOVERY', { edge: 'phone_numbers' }));
  assert.equal(result.outcome, 'SUCCEEDED');
  assert.equal(result.attempts, 2);
  assert.equal(result.retries, 1);
  assert.deepEqual(delays, [30_000]);
  assert.equal(transport.calls.length, 2);

  const exhaustedTransport = new SequenceTransport(Array.from({ length: 3 }, () => ({
    statusCode: 429, headers: { 'content-type': 'text/html' }, body: '<html>synthetic throttled body</html>',
  })));
  const exhausted = client(exhaustedTransport, new FakeCredentials(), { sleep: async () => {}, random: () => 0 });
  const exhaustedResult = await exhausted.instance.execute(request('ASSET_EDGE_LIST', 'ASSET_DISCOVERY', { edge: 'phone_numbers' }));
  assert.equal(exhaustedResult.error?.category, 'RATE_LIMITED');
  assert.equal(exhaustedResult.retryable, true);
  assert.equal(exhaustedResult.attempts, 3);
  assert.equal(exhaustedResult.retries, 2);
});

test('classifies permission, invalid request and exhausted transient GET responses', async () => {
  const unauthorized = client(new SequenceTransport([{
    statusCode: 401, headers: { 'content-type': 'text/html' }, body: '<html>synthetic-auth-secret-marker nested-auth-marker</html>',
  }]));
  const unauthorizedResult = await unauthorized.instance.execute(request('ASSET_EDGE_LIST', 'ASSET_DISCOVERY', { edge: 'phone_numbers' }));
  assert.equal(unauthorizedResult.httpStatus, 401);
  assert.equal(unauthorizedResult.error?.category, 'CREDENTIAL_REJECTED');
  assert.equal(unauthorizedResult.error?.recommendedAction, 'REAUTHENTICATE');
  assert.equal(JSON.stringify(unauthorizedResult).includes('synthetic-auth-secret-marker'), false);
  assert.equal(JSON.stringify(unauthorizedResult).includes('nested-auth-marker'), false);
  assert.equal(JSON.stringify(unauthorizedResult).includes(TOKEN), false);

  const permission = client(new SequenceTransport([{
    statusCode: 403, headers: { 'content-type': 'text/html' }, body: '<html>synthetic permission response</html>',
  }]));
  const permissionResult = await permission.instance.execute(request('ASSET_EDGE_LIST', 'ASSET_DISCOVERY', { edge: 'phone_numbers' }));
  assert.equal(permissionResult.error?.category, 'PERMISSION_REQUIRED');
  assert.equal(permissionResult.retryable, false);
  assert.equal(JSON.stringify(permissionResult).includes('synthetic permission response'), false);

  const invalid = client(new SequenceTransport([{
    statusCode: 400, headers: { 'content-type': 'text/html' }, body: '<html>synthetic invalid request</html>',
  }]));
  const invalidResult = await invalid.instance.execute(request('ASSET_EDGE_LIST', 'ASSET_DISCOVERY', { edge: 'phone_numbers' }));
  assert.equal(invalidResult.error?.category, 'INVALID_REQUEST');
  assert.equal(JSON.stringify(invalidResult).includes('synthetic invalid request'), false);

  const transient = client(new SequenceTransport([
    response(503, { error: { type: 'Exception', code: 1 } }),
    response(503, { error: { type: 'Exception', code: 1 } }),
    response(503, { error: { type: 'Exception', code: 1 } }),
  ]), new FakeCredentials(), { sleep: async () => {}, random: () => 0 });
  const transientResult = await transient.instance.execute(request('ASSET_EDGE_LIST', 'ASSET_DISCOVERY', { edge: 'phone_numbers' }));
  assert.equal(transientResult.error?.category, 'TRANSIENT_PROVIDER_FAILURE');
  assert.equal(transientResult.retryable, true);
  assert.equal(transientResult.attempts, 3);
  assert.equal(transientResult.retries, 2);
});

test('POST HTTP 5xx is ambiguous and never automatically retried', async () => {
  const transport = new SequenceTransport([response(500, { error: { type: 'Exception', code: 1 } })]);
  const runtime = client(transport);
  const result = await runtime.instance.execute(request('SEND_MESSAGE', 'SEND_MESSAGE', { body: { fixture: true } }));
  assert.equal(result.outcome, 'UNKNOWN');
  assert.equal(result.error?.category, 'AMBIGUOUS_POST');
  assert.equal(result.ambiguous, true);
  assert.equal(result.attempts, 1);
  assert.equal(transport.calls.length, 1);
});

test('non-JSON HTTP 500 is transient for exhausted GET retries and ambiguous for POST', async () => {
  const htmlFailure: MetaGraphTransportResponse = {
    statusCode: 500, headers: { 'content-type': 'text/html' }, body: '<html>synthetic upstream error</html>',
  };
  const getTransport = new SequenceTransport([htmlFailure, htmlFailure, htmlFailure]);
  const getRuntime = client(getTransport, new FakeCredentials(), { sleep: async () => {}, random: () => 0 });
  const getResult = await getRuntime.instance.execute(request('ASSET_EDGE_LIST', 'ASSET_DISCOVERY', { edge: 'phone_numbers' }));
  assert.equal(getResult.outcome, 'FAILED');
  assert.equal(getResult.error?.category, 'TRANSIENT_PROVIDER_FAILURE');
  assert.equal(getResult.retryable, true);
  assert.equal(getResult.attempts, 3);
  assert.equal(getResult.retries, 2);
  assert.equal(JSON.stringify(getResult).includes('synthetic upstream error'), false);

  const postTransport = new SequenceTransport([htmlFailure]);
  const postRuntime = client(postTransport);
  const postResult = await postRuntime.instance.execute(request('SEND_MESSAGE', 'SEND_MESSAGE', { body: { fixture: true } }));
  assert.equal(postResult.outcome, 'UNKNOWN');
  assert.equal(postResult.error?.category, 'AMBIGUOUS_POST');
  assert.equal(postResult.retryable, false);
  assert.equal(postResult.ambiguous, true);
  assert.equal(postResult.attempts, 1);
  assert.equal(postTransport.calls.length, 1);
});

test('POST 2xx with empty, HTML or non-object JSON body is UNKNOWN and never leaks body markers', async () => {
  const responses: MetaGraphTransportResponse[] = [
    { statusCode: 200, headers: {}, body: '' },
    { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<html>synthetic-post-body-secret-marker</html>' },
    { statusCode: 200, headers: { 'content-type': 'application/json' }, body: '[]' },
  ];
  for (const response of responses) {
    const transport = new SequenceTransport([response]);
    const runtime = client(transport);
    const result = await runtime.instance.execute(request('SEND_MESSAGE', 'SEND_MESSAGE', { body: { fixture: true } }));
    assert.equal(result.outcome, 'UNKNOWN');
    assert.equal(result.error?.category, 'AMBIGUOUS_POST');
    assert.equal(result.retryable, false);
    assert.equal(result.ambiguous, true);
    assert.equal(result.attempts, 1);
    assert.equal(result.retries, 0);
    assert.equal(JSON.stringify(result).includes('synthetic-post-body-secret-marker'), false);
    assert.equal(transport.calls.length, 1);
  }
});

test('oversized response fails reads and leaves POST outcome ambiguous without retry', async () => {
  const oversized = response(200, { id: 'x'.repeat(1_200) });
  const getTransport = new SequenceTransport([oversized]);
  const getRuntime = client(getTransport, new FakeCredentials(), { maxResponseBytes: 1_024 });
  const getResult = await getRuntime.instance.execute(request('ASSET_EDGE_LIST', 'ASSET_DISCOVERY', { edge: 'phone_numbers' }));
  assert.equal(getResult.outcome, 'FAILED');
  assert.equal(getResult.error?.category, 'RESPONSE_TOO_LARGE');
  assert.equal(getResult.retryable, false);
  assert.equal(getResult.attempts, 1);
  assert.equal(getTransport.calls.length, 1);

  const postTransport = new SequenceTransport([oversized]);
  const postRuntime = client(postTransport, new FakeCredentials(), { maxResponseBytes: 1_024 });
  const postResult = await postRuntime.instance.execute(request('SEND_MESSAGE', 'SEND_MESSAGE', { body: { fixture: true } }));
  assert.equal(postResult.outcome, 'UNKNOWN');
  assert.equal(postResult.error?.category, 'AMBIGUOUS_POST');
  assert.equal(postResult.ambiguous, true);
  assert.equal(postResult.attempts, 1);
  assert.equal(postTransport.calls.length, 1);
});

test('ambiguous POST timeout is UNKNOWN and never resent', async () => {
  const transport = new SequenceTransport([new Error(`timeout ${TOKEN}`)]);
  const runtime = client(transport);
  const result = await runtime.instance.execute(request('SEND_MESSAGE', 'SEND_MESSAGE', { body: { recipient: { id: 'synthetic-user' }, message: { text: 'fixture' } } }));
  assert.equal(result.outcome, 'UNKNOWN');
  assert.equal(result.error?.category, 'AMBIGUOUS_POST');
  assert.equal(result.retryable, false);
  assert.equal(result.ambiguous, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.retries, 0);
  assert.equal(transport.calls.length, 1);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});


test('rejects arbitrary URL-shaped endpoint input before resolving a credential handle', async () => {
  const runtime = client(new SequenceTransport([]));
  const untrusted = { ...request('RAW_URL', 'ASSET_DISCOVERY'), url: 'https://evil.example/v27.0/me', host: 'evil.example' } as unknown as MetaGraphInput;
  const result = await runtime.instance.execute(untrusted);
  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.error?.category, 'REQUEST_INVALID');
  assert.equal(runtime.credentials.callbacks, 0);
});

test('requires the exact operation capability and verified configured Graph version before credential resolution', async () => {
  const transport = new SequenceTransport([]);
  const credentials = new FakeCredentials();
  const disabledRuntime = client(transport, credentials);
  const disabled = await disabledRuntime.instance.execute(request('OBJECT_READ', 'READ_STATUS'));
  assert.equal(disabled.error?.category, 'CAPABILITY_DISABLED');
  assert.equal(credentials.callbacks, 0);

  const unverifiedCredentials = new FakeCredentials();
  const unverified = new MetaGraphClient(new MetaAppConfigRegistry([fixtureProfile('NOT_CONFIRMED')]), unverifiedCredentials,
    transport, new InMemoryMetaGraphMetrics());
  const missingVersion = await unverified.execute(request('ASSET_EDGE_LIST', 'ASSET_DISCOVERY', { edge: 'phone_numbers' }));
  assert.equal(missingVersion.error?.category, 'CONFIGURATION_UNAVAILABLE');
  assert.equal(unverifiedCredentials.callbacks, 0);
  assert.equal(transport.calls.length, 0);
});

test('passes separate connection, header, read and overall timeouts; a POST read timeout remains ambiguous', async () => {
  const transport = new SequenceTransport([new MetaGraphTransportFailure('READ_TIMEOUT')]);
  const runtime = client(transport, new FakeCredentials(), {
    connectTimeoutMs: 300, headersTimeoutMs: 700, readTimeoutMs: 1_100, overallTimeoutMs: 2_500,
  });
  const result = await runtime.instance.execute(request('SEND_MESSAGE', 'SEND_MESSAGE', { body: { fixture: true } }));
  assert.equal(result.outcome, 'UNKNOWN');
  assert.equal(result.error?.category, 'AMBIGUOUS_POST');
  assert.equal(result.error?.timeoutPhase, 'READ');
  assert.equal(result.ambiguous, true);
  assert.equal(transport.calls[0]?.connectTimeoutMs, 300);
  assert.equal(transport.calls[0]?.headersTimeoutMs, 700);
  assert.equal(transport.calls[0]?.readTimeoutMs, 1_100);
  assert.equal(transport.calls[0]?.overallTimeoutMs, 2_500);
  assert.equal(transport.calls.length, 1);

  for (const [phase, kind] of [['CONNECT', 'CONNECT_TIMEOUT'], ['READ', 'READ_TIMEOUT']] as const) {
    const timeoutTransport = new SequenceTransport(Array.from({ length: 3 }, () => new MetaGraphTransportFailure(kind)));
    const timeoutRuntime = client(timeoutTransport, new FakeCredentials(), { sleep: async () => {}, random: () => 0 });
    const timeoutResult = await timeoutRuntime.instance.execute(request('ASSET_EDGE_LIST', 'ASSET_DISCOVERY', { edge: 'phone_numbers' }));
    assert.equal(timeoutResult.error?.category, 'NETWORK_ERROR');
    assert.equal(timeoutResult.error?.timeoutPhase, phase);
    assert.equal(timeoutResult.retryable, true);
    assert.equal(timeoutResult.attempts, 3);
    assert.equal(timeoutResult.retries, 2);
  }
});

test('circular cursors stop and maximum page count returns a resumable checkpoint', async () => {
  const circularTransport = new SequenceTransport([
    response(200, { data: [{ id: 'one' }], paging: { next: `https://graph.facebook.com/v27.0/${providerObjectId}/phone_numbers?after=cursor-2` } }),
    response(200, { data: [{ id: 'two' }], paging: { next: `https://graph.facebook.com/v27.0/${providerObjectId}/phone_numbers?after=cursor-2` } }),
  ]);
  const circular = await client(circularTransport).instance.collect(request('ASSET_EDGE_LIST', 'ASSET_DISCOVERY', { edge: 'phone_numbers' }));
  assert.equal(circular.outcome, 'PARTIAL');
  assert.equal(circular.error?.category, 'PAGINATION_LOOP');
  assert.equal(circularTransport.calls.length, 2);

  const boundedTransport = new SequenceTransport([response(200, { data: [{ id: 'one' }],
    paging: { next: `https://graph.facebook.com/v27.0/${providerObjectId}/phone_numbers?after=cursor-resume` } })]);
  const boundedClient = client(boundedTransport, new FakeCredentials(), { maxPages: 1 });
  const bounded = await boundedClient.instance.collect(request('ASSET_EDGE_LIST', 'ASSET_DISCOVERY', { edge: 'phone_numbers' }));
  assert.equal(bounded.outcome, 'PARTIAL');
  assert.equal(bounded.error?.category, 'LIMIT_REACHED');
  assert.deepEqual(bounded.checkpoint, { after: 'cursor-resume', pagesProcessed: 1, itemsProcessed: 1 });
  assert.equal(boundedTransport.calls.length, 1);
});

test('enforces per-tenant/app request quota and emits only low-cardinality metric labels', async () => {
  const transport = new SequenceTransport([response(200, { id: 'first' })]);
  const runtime = client(transport, new FakeCredentials(), { maxRequestsPerAppWindow: 1, now: () => 10_000 });
  const input = request('ASSET_EDGE_LIST', 'ASSET_DISCOVERY', { edge: 'phone_numbers' });
  assert.equal((await runtime.instance.execute(input)).outcome, 'SUCCEEDED');
  const limited = await runtime.instance.execute(input);
  assert.equal(limited.error?.category, 'REQUEST_BUDGET_EXHAUSTED');
  assert.equal(limited.retryable, true);
  assert.equal(transport.calls.length, 1);
  const metrics = JSON.stringify(runtime.metrics.snapshot());
  assert.ok(metrics.includes('ASSET_DISCOVERY|WHATSAPP_COEXISTENCE|test|SUCCEEDED|NONE'));
  assert.ok(metrics.includes('REQUEST_BUDGET_EXHAUSTED'));
  assert.equal(metrics.includes(tenantId), false);
  assert.equal(metrics.includes(appConfigurationId), false);
});

test('enforces concurrent requests per tenant/app without queueing a storm', async () => {
  let release: ((value: MetaGraphTransportResponse) => void) | undefined;
  const transport = new SequenceTransport([() => new Promise<MetaGraphTransportResponse>((resolve) => { release = resolve; })]);
  const runtime = client(transport, new FakeCredentials(), { maxConcurrencyPerApp: 1 });
  const input = request('SEND_MESSAGE', 'SEND_MESSAGE', { body: { fixture: true } });
  const first = runtime.instance.execute(input);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(transport.calls.length, 1);
  const second = await runtime.instance.execute(input);
  assert.equal(second.error?.category, 'BUSY');
  assert.equal(second.retryable, true);
  assert.equal(transport.calls.length, 1);
  release?.(response(200, { id: 'provider-result' }));
  assert.equal((await first).outcome, 'SUCCEEDED');
});

test('rejects request bodies that contain token or header fields before credential resolution', async () => {
  const runtime = client(new SequenceTransport([]));
  const bad = request('SEND_MESSAGE', 'SEND_MESSAGE', { body: { input_token: 'synthetic-input-token', headers: { authorization: TOKEN } } });
  const result = await runtime.instance.execute(bad);
  assert.equal(result.error?.category, 'REQUEST_INVALID');
  assert.equal(runtime.credentials.callbacks, 0);
});
