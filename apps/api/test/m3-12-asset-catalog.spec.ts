import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AssetCatalogService, AssetCatalogInputError, AssetRefreshUnavailableError } from '../src/meta-assets/asset-catalog.service.js';
import { AssetRefreshCoordinator } from '../src/meta-assets/asset-refresh.service.js';
import type {
  AssetCapabilityEvidence,
  AssetCatalogReadModel,
  AssetCatalogPageQuery,
  ConnectionCatalogPageQuery,
  ConnectionCatalogReadModel,
} from '../src/meta-assets/meta-assets.types.js';
import { MysqlMetaAssetsRepository } from '../src/meta-assets/mysql-meta-assets.repository.js';
import type { MetaAssetsRepository } from '../src/meta-assets/mysql-meta-assets.repository.js';
import { IdentityDeniedError } from '../src/identity/identity.errors.js';
import { PortalSessionVerifier, type VerifiedPortalSession } from '../src/identity/identity.trust.js';
import { TenantAuthorizationService, TenantContextService, hashTenantContextReference } from '../src/identity/identity.service.js';
import type { AuthorizedTenantScope, MembershipRole } from '../src/identity/identity.types.js';
import type { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import type { DurableJobStore } from '../src/jobs/job-store.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const secondTenantId = '00000000-0000-4000-8000-000000000007';
const assetId = '00000000-0000-4000-8000-000000000002';
const appConfigurationId = '00000000-0000-4000-8000-000000000003';
const contextRef = 'synthetic-tenant-context-reference-0001';

function capabilityEvidence(input: {
  flowVariant: AssetCapabilityEvidence['flowVariant'];
  authVariant: AssetCapabilityEvidence['authVariant'];
  grant: string;
  tokenHealth?: AssetCapabilityEvidence['tokenHealth'];
  tokenHealthObservedAt?: string;
  tokenExpiresAt?: string | null;
  tokenExpiryState?: AssetCapabilityEvidence['tokenExpiryState'];
  tokenExpiryObservedAt?: string;
  dataAccessExpiresAt?: string | null;
  dataAccessExpiryObservedAt?: string;
}): AssetCapabilityEvidence {
  const freshObservedAt = new Date(Date.now() - 1_000).toISOString();
  return {
    flowVariant: input.flowVariant,
    authVariant: input.authVariant,
    authorizationState: 'ACTIVE',
    assetAuthorizationState: 'ACTIVE',
    verificationState: 'VERIFIED',
    verifiedAt: freshObservedAt,
    verificationSource: 'META_API',
    tokenHealth: input.tokenHealth ?? 'HEALTHY',
    tokenHealthSource: 'META_API',
    tokenHealthObservedAt: input.tokenHealthObservedAt ?? freshObservedAt,
    tokenExpiryState: input.tokenExpiryState ?? 'KNOWN',
    tokenExpiresAt: input.tokenExpiresAt === undefined ? new Date(Date.now() + 3_600_000).toISOString() : input.tokenExpiresAt,
    tokenExpirySource: 'META_API',
    tokenExpiryObservedAt: input.tokenExpiryObservedAt ?? freshObservedAt,
    dataAccessExpiresAt: input.dataAccessExpiresAt === undefined ? new Date(Date.now() + 3_600_000).toISOString() : input.dataAccessExpiresAt,
    dataAccessExpirySource: 'META_API',
    dataAccessExpiryObservedAt: input.dataAccessExpiryObservedAt ?? freshObservedAt,
    subscriptionState: 'UNKNOWN',
    projectionState: 'UNKNOWN',
    grantNames: [input.grant],
  };
}

async function sessionFor(tenant: string = tenantId): Promise<VerifiedPortalSession> {
  const verifier = new PortalSessionVerifier({
    async findActiveBySecretHash() {
      return {
        sessionId: '00000000-0000-4000-8000-000000000004', principalId: '00000000-0000-4000-8000-000000000005',
        tenantId: tenant, contextVersion: 1, contextRefHash: hashTenantContextReference(contextRef),
        csrfTokenHash: 'a'.repeat(64), entryMode: 'PORTAL_TOP_LEVEL' as const,
      };
    },
  });
  const session = await verifier.verify('synthetic-session-secret-value-000000000001');
  assert.ok(session);
  return session;
}

function asset(overrides: Partial<AssetCatalogReadModel> = {}): AssetCatalogReadModel {
  return {
    assetRef: assetId, appConfigurationId, kind: 'WHATSAPP_PHONE_NUMBER', status: 'ACTIVE',
    authorizationStatus: 'VERIFIED', observedAt: '2026-11-01T12:00:00.000Z',
    lastVerifiedAt: '2026-11-01T12:00:00.000Z', verificationSource: 'META_API', stale: false,
    diagnostics: {
      onboardingStatus: 'UNKNOWN', onboardingReadiness: 'UNKNOWN', onboardingNextAction: 'UNKNOWN',
      tokenHealth: 'UNKNOWN', tokenHealthObservedAt: null, metaState: 'UNKNOWN', metaObservedAt: null,
      subscriptionState: 'UNKNOWN', projectionState: 'UNKNOWN',
    },
    capabilityEvidence: [], reauthorizationRequired: false, ...overrides,
  };
}

function setup(options: { roles?: readonly MembershipRole[]; adapter?: object; assets?: readonly AssetCatalogReadModel[];
  flowApps?: readonly { appConfigurationRef: string; environment: 'test' }[];
  connection?: ConnectionCatalogReadModel } = {}) {
  const roles = options.roles ?? ['operator'];
  const readQueries: AssetCatalogPageQuery[] = [];
  const connectionQueries: ConnectionCatalogPageQuery[] = [];
  let refreshLookups = 0;
  const repository = {
    async listAssetCatalog(query: AssetCatalogPageQuery) {
      readQueries.push(query);
      return { items: options.assets ?? [], nextCursor: null };
    },
    async findAssetCatalog() { refreshLookups += 1; return asset(); },
    async listConnectionCatalog(query: ConnectionCatalogPageQuery) {
      connectionQueries.push(query);
      return { items: [], nextCursor: null };
    },
    async findConnectionCatalog() { return options.connection; },
    async listFlowCatalogApps() { return { items: options.flowApps ?? [], truncated: false }; },
  } as unknown as MetaAssetsRepository;
  const contexts = {
    async resolveCurrent(session: VerifiedPortalSession) {
      return { tenantId: session.tenantId, roles, principalId: session.principalId } as AuthorizedTenantScope;
    },
  } as unknown as TenantContextService;
  const authorization = {
    async authorize(_scope: AuthorizedTenantScope, operation: string) {
      if (roles.includes('viewer') && operation !== 'RESOURCE_READ') throw new IdentityDeniedError();
    },
  } as unknown as TenantAuthorizationService;
  const coordinator = new AssetRefreshCoordinator({} as DurableWorkDatabase, {} as DurableJobStore,
    options.adapter as never);
  const service = new AssetCatalogService(repository, contexts, authorization, 'test', coordinator, new Set());
  return { service, readQueries, connectionQueries, get refreshLookups() { return refreshLookups; } };
}

test('catalog rejects forged sessions and viewer access stays read-only', async () => {
  const { service } = setup({ roles: ['viewer'] });
  await assert.rejects(service.listFlows({} as VerifiedPortalSession, contextRef, 'request-synthetic'), IdentityDeniedError);
  const session = await sessionFor();
  const flows = await service.listFlows(session, contextRef, 'request-synthetic');
  assert.deepEqual(flows.items.map((item) => item.variant), [
    'FACEBOOK', 'INSTAGRAM', 'WHATSAPP_EXCLUSIVE', 'WHATSAPP_COEXISTENCE',
  ]);
  assert.ok(flows.items.every((item) => item.enabled === false));
  assert.ok(flows.items.every((item) => item.availability === 'CONFIGURATION_MISSING'));
  assert.ok(flows.items.every((item) => item.prerequisites.tenantFeatureFlag === 'UNKNOWN'));
  const configured = setup({ flowApps: [{ appConfigurationRef: appConfigurationId, environment: 'test' }] });
  const configuredFlows = await configured.service.listFlows(session, contextRef, 'request-synthetic');
  assert.equal(configuredFlows.items.length, 4);
  assert.ok(configuredFlows.items.every((item) => item.appConfigurationRef === appConfigurationId));
  assert.ok(configuredFlows.items.every((item) => item.availability === 'ADAPTER_UNAVAILABLE'));
  await assert.rejects(service.refreshAsset(session, contextRef, assetId, 'request-synthetic'), IdentityDeniedError);
});

test('asset cursor is strictly parsed and every catalog read carries the server-resolved tenant', async () => {
  const { service, readQueries } = setup();
  const session = await sessionFor();
  await assert.rejects(service.listAssets(session, contextRef, { limit: 50, cursor: 'forged-cursor!' }, 'request-synthetic'), AssetCatalogInputError);
  assert.equal(readQueries.length, 0);
  await service.listAssets(session, contextRef, { limit: 50, cursor: Buffer.from(assetId).toString('base64url'), channel: 'WHATSAPP', status: 'ACTIVE' }, 'request-synthetic');
  assert.equal(readQueries.length, 1);
  assert.equal(readQueries[0]?.tenantId, tenantId);
  assert.equal(readQueries[0]?.cursor, assetId);
  assert.equal(readQueries[0]?.channel, 'WHATSAPP');
  assert.equal(readQueries[0]?.status, 'ACTIVE');
  await service.listAssets(await sessionFor(secondTenantId), contextRef, { limit: 50 }, 'request-synthetic');
  assert.equal(readQueries[1]?.tenantId, secondTenantId, 'tenant B uses its own server-resolved scope');
});

test('connection list uses the same protected tenant scope and bounded filters', async () => {
  const { service, connectionQueries } = setup({ roles: ['viewer'] });
  await service.listConnections(await sessionFor(), contextRef, {
    limit: 20, channel: 'INSTAGRAM', number: '+15555550123', status: 'PARTIAL',
  }, 'request-synthetic');
  assert.equal(connectionQueries[0]?.tenantId, tenantId);
  assert.equal(connectionQueries[0]?.limit, 20);
  assert.equal(connectionQueries[0]?.channel, 'INSTAGRAM');
  assert.equal(connectionQueries[0]?.number, '+15555550123');
  assert.equal(connectionQueries[0]?.status, 'PARTIAL');
});

test('refresh fails closed without a configured adapter and does not open a queue path', async () => {
  const { service, refreshLookups } = setup();
  await assert.rejects(service.refreshAsset(await sessionFor(), contextRef, assetId, 'request-synthetic'), AssetRefreshUnavailableError);
  assert.equal(refreshLookups, 1, 'resource existence is checked within the tenant before returning unavailable');
});

test('asset response is an explicit allowlist and does not serialize provider or secret fields', async () => {
  const unsafe = { ...asset(), accessToken: 'synthetic-secret-never-return', providerPayload: { id: 'raw-provider-object' } } as AssetCatalogReadModel;
  const { service } = setup({ assets: [unsafe] });
  const result = await service.listAssets(await sessionFor(), contextRef, { limit: 50 }, 'request-synthetic');
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('synthetic-secret-never-return'), false);
  assert.equal(serialized.includes('raw-provider-object'), false);
  assert.equal(result.items[0]?.lastVerifiedAt, '2026-11-01T12:00:00.000Z');
  assert.equal(result.items[0]?.verificationSource, 'META_API');
  assert.equal(result.items[0]?.diagnostics.onboardingStatus, 'UNKNOWN');
  assert.deepEqual(result.items[0]?.capabilities, {
    canSend: false, canManageTemplates: false, canSubscribe: false, canReauthorize: false, canDisconnect: false,
  });
});

test('capabilities require a supported auth variant and healthy token evidence', async () => {
  const instagramPageLogin = asset({
    kind: 'INSTAGRAM_BUSINESS_ACCOUNT',
    capabilityEvidence: [capabilityEvidence({
      flowVariant: 'INSTAGRAM', authVariant: 'FACEBOOK_LOGIN_FOR_BUSINESS', grant: 'instagram_business_manage_messages',
    })],
  });
  const instagramLogin = asset({
    kind: 'INSTAGRAM_BUSINESS_ACCOUNT',
    capabilityEvidence: [capabilityEvidence({
      flowVariant: 'INSTAGRAM', authVariant: 'INSTAGRAM_LOGIN', grant: 'instagram_business_manage_messages',
    })],
  });
  const expiredInstagramLogin = asset({
    kind: 'INSTAGRAM_BUSINESS_ACCOUNT',
    capabilityEvidence: [capabilityEvidence({
      flowVariant: 'INSTAGRAM', authVariant: 'INSTAGRAM_LOGIN', grant: 'instagram_business_manage_messages', tokenHealth: 'EXPIRED',
    })],
  });
  const staleInstagramLogin = asset({
    kind: 'INSTAGRAM_BUSINESS_ACCOUNT',
    capabilityEvidence: [capabilityEvidence({
      flowVariant: 'INSTAGRAM', authVariant: 'INSTAGRAM_LOGIN', grant: 'instagram_business_manage_messages',
      tokenHealthObservedAt: new Date(Date.now() - 3_600_001).toISOString(),
    })],
  });
  const expiredAccessInstagramLogin = asset({
    kind: 'INSTAGRAM_BUSINESS_ACCOUNT',
    capabilityEvidence: [capabilityEvidence({
      flowVariant: 'INSTAGRAM', authVariant: 'INSTAGRAM_LOGIN', grant: 'instagram_business_manage_messages',
      dataAccessExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    })],
  });
  const staleExpiryInstagramLogin = asset({
    kind: 'INSTAGRAM_BUSINESS_ACCOUNT',
    capabilityEvidence: [capabilityEvidence({
      flowVariant: 'INSTAGRAM', authVariant: 'INSTAGRAM_LOGIN', grant: 'instagram_business_manage_messages',
      tokenExpiryObservedAt: new Date(Date.now() - 3_600_001).toISOString(),
    })],
  });
  const expiredTokenInstagramLogin = asset({
    kind: 'INSTAGRAM_BUSINESS_ACCOUNT',
    capabilityEvidence: [capabilityEvidence({
      flowVariant: 'INSTAGRAM', authVariant: 'INSTAGRAM_LOGIN', grant: 'instagram_business_manage_messages',
      tokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    })],
  });
  const phoneNumber = asset({
    kind: 'WHATSAPP_PHONE_NUMBER',
    capabilityEvidence: [capabilityEvidence({
      flowVariant: 'WHATSAPP_EXCLUSIVE', authVariant: 'WHATSAPP_EMBEDDED_SIGNUP', grant: 'whatsapp_business_messaging',
    })],
  });
  const noExpiryInstagramLogin = asset({
    kind: 'INSTAGRAM_BUSINESS_ACCOUNT',
    capabilityEvidence: [capabilityEvidence({
      flowVariant: 'INSTAGRAM', authVariant: 'INSTAGRAM_LOGIN', grant: 'instagram_business_manage_messages',
      tokenExpiryState: 'PROVIDER_NO_EXPIRY', tokenExpiresAt: null,
    })],
  });
  const whatsappBusinessAccount = asset({
    kind: 'WHATSAPP_BUSINESS_ACCOUNT',
    capabilityEvidence: [capabilityEvidence({
      flowVariant: 'WHATSAPP_EXCLUSIVE', authVariant: 'WHATSAPP_EMBEDDED_SIGNUP', grant: 'whatsapp_business_messaging',
    })],
  });
  const coexistence = asset({
    kind: 'WHATSAPP_BUSINESS_ACCOUNT',
    capabilityEvidence: [capabilityEvidence({
      flowVariant: 'WHATSAPP_COEXISTENCE', authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING', grant: 'whatsapp_business_management',
    })],
  });
  const page = asset({
    kind: 'FACEBOOK_PAGE',
    capabilityEvidence: [capabilityEvidence({
      flowVariant: 'FACEBOOK', authVariant: 'FACEBOOK_LOGIN_FOR_BUSINESS', grant: 'pages_manage_metadata',
    })],
  });
  const { service } = setup({ assets: [instagramPageLogin, instagramLogin, expiredInstagramLogin, staleInstagramLogin,
    expiredAccessInstagramLogin, staleExpiryInstagramLogin, expiredTokenInstagramLogin, phoneNumber, noExpiryInstagramLogin,
    whatsappBusinessAccount, coexistence, page] });
  const result = await service.listAssets(await sessionFor(), contextRef, { limit: 50 }, 'request-synthetic');
  assert.equal(result.items[0]?.capabilities.canSend, false, 'Facebook Login evidence cannot transfer to Instagram Login');
  assert.equal(result.items[1]?.capabilities.canSend, true, 'documented Instagram Login evidence can inform the advisory flag');
  assert.equal(result.items[2]?.capabilities.canSend, false, 'expired credentials cannot produce a positive capability');
  assert.equal(result.items[3]?.capabilities.canSend, false, 'stale health observations cannot produce a positive capability');
  assert.equal(result.items[4]?.capabilities.canSend, false, 'expired data access cannot produce a positive capability');
  assert.equal(result.items[5]?.capabilities.canSend, false, 'stale token-expiry observations cannot produce a positive capability');
  assert.equal(result.items[6]?.capabilities.canSend, false, 'expired tokens cannot produce a positive capability');
  assert.equal(result.items[7]?.capabilities.canSend, true, 'WhatsApp send maps to a verified phone number');
  assert.equal(result.items[8]?.capabilities.canSend, true, 'fresh provider-declared no-expiry evidence is accepted');
  assert.equal(result.items[9]?.capabilities.canSend, false, 'a WABA parent is not a send target');
  assert.equal(result.items[10]?.capabilities.canManageTemplates, false, 'Coexistence template mapping remains unconfirmed');
  assert.equal(result.items[11]?.capabilities.canSubscribe, false, 'Facebook subscription mapping remains unconfirmed');
});

test('reauthorization reflects M3.09 open impacts in exact tenant, environment, authorization and asset scope', async () => {
  const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
  const database = {
    async getDataSource() {
      return {
        async query(sql: string, params: readonly unknown[] = []) {
          statements.push({ sql, params });
          if (statements.length === 1) return [{
            id: assetId,
            app_configuration_id: appConfigurationId,
            asset_kind: 'WHATSAPP_PHONE_NUMBER',
            status: 'ACTIVE',
            authorization_status: 'VERIFIED',
            observed_at: new Date().toISOString(),
            last_verified_at: new Date().toISOString(),
            reauthorization_required: 1,
          }];
          return [];
        },
      };
    },
  } as unknown as DurableWorkDatabase;
  const repository = new MysqlMetaAssetsRepository(database, {} as never, {} as never);
  const page = await repository.listAssetCatalog({ tenantId, environment: 'test', limit: 10 });
  assert.equal(page.items[0]?.reauthorizationRequired, true);
  assert.equal(statements.length, 2, 'catalog uses one page query and one batched evidence query, with no per-asset reauth query');
  const query = statements[0]?.sql ?? '';
  assert.match(query, /ca_meta_credential_reauth_impacts/i);
  assert.match(query, /intent\.status IN \('PENDING', 'ACKNOWLEDGED'\)/i);
  assert.match(query, /impact\.tenant_id = a\.tenant_id/i);
  assert.match(query, /impact\.asset_id = a\.id/i);
  assert.match(query, /impact\.authorization_id = aa\.authorization_id/i);
  assert.match(query, /impact\.environment = a\.environment/i);
  assert.deepEqual(statements[0]?.params.slice(0, 2), [tenantId, 'test']);
});

test('reauthorization capability is limited to operators with an open M3.09 intent', async () => {
  const pending = asset({ reauthorizationRequired: true });
  const operator = setup({ assets: [pending] });
  const operatorPage = await operator.service.listAssets(await sessionFor(), contextRef, { limit: 10 }, 'request-synthetic');
  assert.equal(operatorPage.items[0]?.capabilities.canReauthorize, true);

  const viewer = setup({ roles: ['viewer'], assets: [pending] });
  const viewerPage = await viewer.service.listAssets(await sessionFor(), contextRef, { limit: 10 }, 'request-synthetic');
  assert.equal(viewerPage.items[0]?.capabilities.canReauthorize, false);
});

test('connection detail preserves stale evidence and keeps viewer capabilities read-only', async () => {
  const staleAsset = asset({
    status: 'STALE', authorizationStatus: 'UNKNOWN', stale: true,
    lastVerifiedAt: '2026-10-30T11:00:00.000Z',
  });
  const diagnostics = {
    onboardingStatus: 'UNKNOWN' as const,
    onboardingReadiness: 'UNKNOWN' as const,
    onboardingNextAction: 'UNKNOWN' as const,
    tokenHealth: 'UNKNOWN' as const,
    tokenHealthObservedAt: null,
    metaState: 'UNKNOWN' as const,
    metaObservedAt: null,
    subscriptionState: 'UNKNOWN' as const,
    projectionState: 'UNKNOWN' as const,
  };
  const { service } = setup({ roles: ['viewer'], connection: {
    connectionRef: appConfigurationId,
    flowVariant: 'WHATSAPP_COEXISTENCE',
    status: 'PARTIAL',
    readiness: 'UNKNOWN',
    observedAt: '2026-11-01T12:00:00.000Z',
    lastVerifiedAt: '2026-10-30T11:00:00.000Z',
    verificationSource: 'SIGNED_WEBHOOK',
    stale: true,
    assetCount: 1,
    diagnostics,
    assets: [staleAsset],
  } });
  const result = await service.getConnection(await sessionFor(), contextRef, appConfigurationId, 'request-synthetic');
  assert.ok(result);
  assert.equal(result.flowVariant, 'WHATSAPP_COEXISTENCE');
  assert.equal(result.status, 'PARTIAL', 'staleness does not become a disconnect claim');
  assert.equal(result.lastVerifiedAt, '2026-10-30T11:00:00.000Z');
  assert.equal(result.verificationSource, 'SIGNED_WEBHOOK');
  assert.equal(result.assets[0]?.status, 'STALE');
  assert.equal(result.assets[0]?.lastVerifiedAt, '2026-10-30T11:00:00.000Z');
  assert.equal(result.assets[0]?.verificationSource, 'META_API');
  assert.deepEqual(result.assets[0]?.capabilities, {
    canSend: false, canManageTemplates: false, canSubscribe: false, canReauthorize: false, canDisconnect: false,
  });
});

test('refresh admissions coalesce active tenant+asset jobs under the tenant transaction lock', async () => {
  let activeId: string | undefined;
  let enqueueCount = 0;
  const manager = {
    async query(sql: string) {
      if (sql.includes('FROM ca_meta_tenants')) return [{ id: tenantId }];
      if (sql.includes('FROM ca_meta_jobs')) return activeId ? [{ id: activeId }] : [];
      throw new Error('Unexpected synthetic SQL in test.');
    },
  };
  const database = {
    async getDataSource() {
      return { async transaction<T>(run: (managerValue: typeof manager) => Promise<T>) { return run(manager); } };
    },
  } as unknown as DurableWorkDatabase;
  const jobs = {
    async enqueueWithin() {
      enqueueCount += 1;
      activeId = '00000000-0000-4000-8000-000000000006';
      return { id: activeId, duplicate: false };
    },
  } as unknown as DurableJobStore;
  const adapter = { async refresh() {} };
  const coordinator = new AssetRefreshCoordinator(database, jobs, adapter);
  const input = { tenantId, assetId, appConfigurationId, environment: 'test' as const, requestId: 'request-synthetic' };
  const first = await coordinator.enqueue(input);
  const second = await coordinator.enqueue(input);
  assert.equal(enqueueCount, 1);
  assert.equal(first.jobId, second.jobId);
});
