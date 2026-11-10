import assert from 'node:assert/strict';
import test from 'node:test';
import type { MetaSubscriptionActor } from '../src/meta-subscriptions/meta-subscriptions.types.js';
import type { MetaSubscriptionService } from '../src/meta-subscriptions/meta-subscription.service.js';
import { MysqlMetaSubscriptionCatalog } from '../src/meta-subscriptions/mysql-meta-subscription.catalog.js';
import { MysqlMetaSubscriptionStore } from '../src/meta-subscriptions/mysql-meta-subscription.store.js';
import type { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { FacebookPageSelectionService } from '../src/meta-facebook/facebook-page-selection.service.js';
import { collectCompletePageSet, FacebookPagesOnboardingAdapter } from '../src/meta-facebook/facebook-pages-onboarding.adapter.js';
import { facebookPageCapabilitySnapshot, type FacebookManagedPage, type FacebookPageAssetStore,
  type FacebookPageProjectionPort, type FacebookPageSelectionContext, type FacebookPagesContext,
  type FacebookPagesProvider } from '../src/meta-facebook/facebook-pages.types.js';

const TENANT = '20000000-0000-4000-8000-000000000001';
const CONFIG = '20000000-0000-4000-8000-000000000002';
const AUTHORIZATION = '20000000-0000-4000-8000-000000000003';
const PAGE_A = '20000000-0000-4000-8000-000000000004';
const PAGE_B = '20000000-0000-4000-8000-000000000005';
const CORRELATION = '20000000-0000-4000-8000-000000000006';

function context(): FacebookPagesContext {
  return Object.freeze({ tenantId: TENANT, onboardingId: '20000000-0000-4000-8000-000000000007',
    flowVariant: 'FACEBOOK_LOGIN', authVariant: 'FACEBOOK_LOGIN_FOR_BUSINESS', configurationRef: 'facebook-test-config',
    principalId: '20000000-0000-4000-8000-000000000008', portalSessionId: '20000000-0000-4000-8000-000000000009',
    correlationId: CORRELATION, graphApiVersion: 'v1.0', capabilityManifestVersion: 'test' });
}

function page(id: string, pageAccessToken: string, tasks: readonly string[] = ['MANAGE']) : FacebookManagedPage {
  return Object.freeze({ id, name: `Page ${id.slice(-1)}`, pageAccessToken, tasks: Object.freeze([...tasks]) });
}

function adapter(input: { readonly provider: FacebookPagesProvider; readonly assets: FacebookPageAssetStore;
  readonly listSelectedAssets?: MetaSubscriptionService['listSelectedAssets'];
  readonly projection?: FacebookPageProjectionPort }) {
  const subscription = { listSelectedAssets: input.listSelectedAssets ?? (async () => Object.freeze([])),
    reconcile: async () => ({ state: 'PARTIAL', desiredState: 'SUBSCRIBED', observedState: 'UNKNOWN', version: 0 }) };
  return new FacebookPagesOnboardingAdapter(input.provider, input.assets, subscription as unknown as Pick<MetaSubscriptionService, 'reconcile' | 'listSelectedAssets'>,
    async () => undefined, input.projection ?? { publish: async () => undefined }, () => 'test');
}

test('Facebook discovery follows every cursor before persisting per-Page credentials', async () => {
  const providerCalls: Array<string | null> = [];
  const observedPages: FacebookManagedPage[] = [];
  const provider: FacebookPagesProvider = {
    exchangeAndStoreAuthorization: async () => ({ authorizationRef: AUTHORIZATION, grantedScopes: ['pages_show_list'], observedAt: '2026-11-10T12:00:00Z' }),
    listManagedPages: async ({ after }) => {
      providerCalls.push(after);
      return after === null
        ? { outcome: 'SUCCEEDED', pages: [page('101', 'page-token-alpha')], nextCursor: 'cursor-1' }
        : { outcome: 'SUCCEEDED', pages: [page('202', 'page-token-beta')], nextCursor: null };
    },
  };
  const assets: FacebookPageAssetStore = { persistCompletePageSet: async ({ pages }) => {
    observedPages.push(...pages);
    return Object.freeze([{ providerPageId: '101', assetRef: PAGE_A }, { providerPageId: '202', assetRef: PAGE_B }]);
  } };
  const sut = adapter({ provider, assets });
  const authorization = await sut.exchangeAuthorizationCode({ ...context(), code: 'single-use-code',
    idempotencyKey: 'onboarding:authorization', signal: new AbortController().signal });
  assert.deepEqual(authorization, { authorizationRef: AUTHORIZATION });
  const discovered = await sut.discoverAndPersistAssets({ ...context(), authorizationRef: authorization.authorizationRef,
    idempotencyKey: 'onboarding:asset-verification', signal: new AbortController().signal });
  assert.deepEqual(providerCalls, [null, 'cursor-1']);
  assert.deepEqual(discovered.assetRefs, [PAGE_A, PAGE_B]);
  assert.deepEqual(observedPages.map((item) => item.pageAccessToken), ['page-token-alpha', 'page-token-beta']);
  assert.equal(JSON.stringify(discovered).includes('page-token'), false, 'Page credentials are never returned in saga evidence.');
});

test('zero Pages is an empty recoverable result and does not persist fake authorization assets', async () => {
  let persistCalls = 0;
  const provider: FacebookPagesProvider = {
    exchangeAndStoreAuthorization: async () => ({ authorizationRef: AUTHORIZATION, grantedScopes: [], observedAt: '2026-11-10T12:00:00Z' }),
    listManagedPages: async () => ({ outcome: 'SUCCEEDED', pages: [], nextCursor: null }),
  };
  const assets: FacebookPageAssetStore = { persistCompletePageSet: async () => { persistCalls += 1; return []; } };
  const result = await adapter({ provider, assets }).discoverAndPersistAssets({ ...context(), authorizationRef: AUTHORIZATION,
    idempotencyKey: 'onboarding:asset-verification', signal: new AbortController().signal });
  assert.deepEqual(result.assetRefs, []);
  assert.equal(persistCalls, 0);
});

test('incomplete pagination and duplicate cursors fail before any Page token reaches persistence', async () => {
  let persistCalls = 0;
  const provider: FacebookPagesProvider = {
    exchangeAndStoreAuthorization: async () => ({ authorizationRef: AUTHORIZATION, grantedScopes: [], observedAt: '2026-11-10T12:00:00Z' }),
    listManagedPages: async ({ after }) => after === null
      ? { outcome: 'SUCCEEDED', pages: [page('101', 'page-token-alpha')], nextCursor: 'cursor-1' }
      : { outcome: 'PARTIAL', pages: [page('202', 'page-token-beta')], nextCursor: 'cursor-2' },
  };
  const assets: FacebookPageAssetStore = { persistCompletePageSet: async () => { persistCalls += 1; return []; } };
  await assert.rejects(adapter({ provider, assets }).discoverAndPersistAssets({ ...context(), authorizationRef: AUTHORIZATION,
    idempotencyKey: 'onboarding:asset-verification', signal: new AbortController().signal }));
  assert.equal(persistCalls, 0);

  let calls = 0;
  await assert.rejects(collectCompletePageSet({ listManagedPages: async ({ after }) => {
    calls += 1;
    return { outcome: 'SUCCEEDED', pages: [page(String(calls), `page-token-${calls}`)], nextCursor: 'same-cursor' };
  } }, context(), AUTHORIZATION, new AbortController().signal));
  assert.equal(calls, 2, 'cursor replay stops before a third request');
});

test('Page tasks never grant message or comment capability', () => {
  const snapshot = facebookPageCapabilitySnapshot(PAGE_A, ['MANAGE', 'CREATE_CONTENT', 'MODERATE']);
  assert.deepEqual({ read: snapshot.readPageStatus, messages: snapshot.readMessages,
    comments: snapshot.replyToComments, send: snapshot.sendMessages },
  { read: false, messages: false, comments: false, send: false });
  assert.equal(snapshot.reasonCode, 'PERMISSION_MAPPING_NOT_CONFIRMED');
});

test('M4.11 catalog resolves only an exact Facebook Page authorization context', async () => {
  const row = { authorization_id: AUTHORIZATION, authorization_state: 'ACTIVE', flow_variant: 'FACEBOOK',
    auth_variant: 'FACEBOOK_LOGIN_FOR_BUSINESS', asset_id: PAGE_A, asset_kind: 'FACEBOOK_PAGE', external_id: '101',
    asset_state: 'ACTIVE', verification_state: 'VERIFIED', credential_id: '20000000-0000-4000-8000-000000000010',
    asset_version: 3, authorization_version: 2 };
  let queryCount = 0;
  const database = { getDataSource: async () => ({ query: async () => { queryCount += 1; return [row]; } }) } as unknown as DurableWorkDatabase;
  const catalog = new MysqlMetaSubscriptionCatalog(database);
  const result = await catalog.resolveByAsset({ tenantId: TENANT, appConfigurationId: CONFIG, environment: 'test',
    assetId: PAGE_A, authorizationId: AUTHORIZATION });
  assert.equal(result?.kind, 'FACEBOOK_PAGE');
  assert.equal(result?.flowVariant, 'FACEBOOK');
  assert.equal(result?.authVariant, 'FACEBOOK_LOGIN_FOR_BUSINESS');
  assert.equal(result?.sourceAssetId, PAGE_A);
  assert.equal(result?.targetAssetId, PAGE_A);
  assert.equal(queryCount, 2, 'the catalog verifies both the scoped source and its exact target row');

  const wrongVariant = { ...row, flow_variant: 'INSTAGRAM', auth_variant: 'INSTAGRAM_LOGIN' };
  const wrongDatabase = { getDataSource: async () => ({ query: async () => [wrongVariant] }) } as unknown as DurableWorkDatabase;
  const rejected = await new MysqlMetaSubscriptionCatalog(wrongDatabase).resolveByAsset({ tenantId: TENANT,
    appConfigurationId: CONFIG, environment: 'test', assetId: PAGE_A, authorizationId: AUTHORIZATION });
  assert.equal(rejected, undefined);
});

test('M4.11 selected-Page lookup uses the exact Facebook authorization and tenant scope', async () => {
  let statement = '';
  let parameters: readonly unknown[] = [];
  const database = { getDataSource: async () => ({ query: async (sql: string, params: readonly unknown[]) => {
    statement = sql; parameters = params;
    return [{ assetId: PAGE_A, targetAssetId: PAGE_A, authorizationId: AUTHORIZATION, desiredFields: '[]' }];
  } }) } as unknown as DurableWorkDatabase;
  const selected = await new MysqlMetaSubscriptionStore(database).listSelectedAssets({ tenantId: TENANT,
    appConfigurationId: CONFIG, environment: 'test', authorizationId: AUTHORIZATION, assetKind: 'FACEBOOK_PAGE',
    correlationId: CORRELATION });
  assert.deepEqual(selected, [{ assetId: PAGE_A, targetAssetId: PAGE_A, authorizationId: AUTHORIZATION, desiredFields: [] }]);
  assert.match(statement, /source_asset\.asset_kind = 'FACEBOOK_PAGE'/);
  assert.match(statement, /auth\.flow_variant = 'FACEBOOK'/);
  assert.match(statement, /auth\.auth_variant = 'FACEBOOK_LOGIN_FOR_BUSINESS'/);
  assert.equal(parameters[1], TENANT);
  assert.equal(parameters[2], CONFIG);
  assert.equal(parameters[4], AUTHORIZATION);
});

test('Page selection persists only exact Page assets through M4.11 service and does not select other flows', async () => {
  const calls: string[] = [];
  const selected = new Set<string>();
  const subscriptions = {
    listSelectedAssets: async (query: { readonly assetKind: string }) => {
      assert.equal(query.assetKind, 'FACEBOOK_PAGE');
      return Object.freeze([...selected].map((assetId) => ({ assetId, targetAssetId: assetId,
        authorizationId: AUTHORIZATION, desiredFields: Object.freeze([]) })));
    },
    connect: async (request: { readonly assetId: string }) => {
      calls.push(`connect:${request.assetId}`); selected.add(request.assetId);
      return { state: 'PARTIAL', desiredState: 'SUBSCRIBED', observedState: 'UNKNOWN', version: 1,
        reasonCode: 'PAGE_SUBSCRIPTION_NOT_CONFIRMED' };
    },
    disconnect: async (request: { readonly assetId: string }) => {
      calls.push(`disconnect:${request.assetId}`); selected.delete(request.assetId);
      return { state: 'MANUAL_ACTION_REQUIRED', desiredState: 'UNSUBSCRIBED', observedState: 'UNKNOWN', version: 2,
        reasonCode: 'REMOTE_UNSUBSCRIBE_NOT_CONFIRMED' };
    },
  };
  selected.add(PAGE_A);
  const selection: FacebookPageSelectionContext = { tenantId: TENANT, authorizationRef: AUTHORIZATION,
    appConfigurationRef: CONFIG, environment: 'test', correlationId: CORRELATION };
  const result = await new FacebookPageSelectionService(subscriptions as unknown as Pick<MetaSubscriptionService,
    'connect' | 'reconcile' | 'disconnect' | 'listSelectedAssets'>).replaceSelection({ ...selection, selectedAssetRefs: [PAGE_B] },
      {} as MetaSubscriptionActor);
  assert.deepEqual(calls, [`connect:${PAGE_B}`, `disconnect:${PAGE_A}`]);
  assert.deepEqual(result.selectedAssetRefs, [PAGE_B]);
  assert.equal(result.readiness, 'PARTIAL');
  assert.equal(selected.has(PAGE_A), false);
  assert.equal(selected.has(PAGE_B), true);
});
