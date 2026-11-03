import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AssetCatalogService, AssetCatalogInputError, AssetRefreshUnavailableError } from '../src/meta-assets/asset-catalog.service.js';
import { AssetRefreshCoordinator } from '../src/meta-assets/asset-refresh.service.js';
import type { AssetCatalogReadModel, AssetCatalogPageQuery, ConnectionCatalogPageQuery } from '../src/meta-assets/meta-assets.types.js';
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
    authorizationStatus: 'VERIFIED', observedAt: '2026-11-01T12:00:00.000Z', stale: false,
    capabilityEvidence: [], reauthorizationRequired: false, ...overrides,
  };
}

function setup(options: { roles?: readonly MembershipRole[]; adapter?: object; assets?: readonly AssetCatalogReadModel[] } = {}) {
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
    async findConnectionCatalog() { return undefined; },
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
  assert.equal(flows.items.length, 5);
  assert.ok(flows.items.every((item) => item.enabled === false));
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
  assert.deepEqual(result.items[0]?.capabilities, {
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
