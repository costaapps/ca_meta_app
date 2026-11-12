import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import type { DurableJobStore } from '../src/jobs/job-store.js';
import { OperationsActionService, type OperationsActionRequest, type SupportOperationsAuthorizationPort } from '../src/operations/operations-actions.service.js';
import { MysqlOperationsDiagnosticsRepository, OperationsDiagnosticsService, type OperationsDiagnosticsRepository } from '../src/operations/operations-diagnostics.service.js';
import { TenantAuthorizationService, TenantContextService, hashTenantContextReference } from '../src/identity/identity.service.js';
import type { IdentityRepository } from '../src/identity/identity.repository.js';
import { PortalSessionVerifier, type PortalSessionStore } from '../src/identity/identity.trust.js';
import type { MembershipRole, TenantMembership } from '../src/identity/identity.types.js';
import { IdentityDeniedError } from '../src/identity/identity.errors.js';
import { SupportDiagnosticService, type SupportAccessAuthorizationPort } from '../src/privacy/audit.service.js';

const tenantA = '10000000-0000-4000-8000-000000000001';
const tenantB = '20000000-0000-4000-8000-000000000002';
const deadLetterRef = '30000000-0000-4000-8000-000000000003';
const projectionScope = 'projection-scope-01';
const requestRef = () => randomUUID();

interface Fixture {
  readonly session: NonNullable<Awaited<ReturnType<PortalSessionVerifier['verify']>>>;
  readonly contextRef: string;
  readonly contexts: TenantContextService;
  readonly authorization: TenantAuthorizationService;
  readonly repository: IdentityRepository;
}

async function fixture(role: MembershipRole = 'operator', tenantId = tenantA): Promise<Fixture> {
  const contextRef = `context-reference-${tenantId}`;
  const principalId = 'operations-user-01';
  const repository: IdentityRepository = {
    async findPrincipalByIssuerSubject() { return undefined; },
    async findMembership(actorId, requestedTenant): Promise<TenantMembership | undefined> {
      if (actorId !== principalId || requestedTenant !== tenantId) return undefined;
      return { principalId, tenantId, principalKind: 'USER', principalStatus: 'ACTIVE', tenantStatus: 'ACTIVE',
        roles: [role], status: 'ACTIVE', version: 1 };
    },
    async listActiveMemberships() { return []; },
    async findServiceTenantGrant() { return undefined; },
    async findLegacyTenantMapping() { return undefined; },
  };
  const store: PortalSessionStore = {
    async findActiveBySecretHash() {
      return { sessionId: 'operations-session-01', principalId, tenantId, contextVersion: 1,
        contextRefHash: hashTenantContextReference(contextRef), csrfTokenHash: 'a'.repeat(64), entryMode: 'PORTAL_TOP_LEVEL' };
    },
  };
  const verifier = new PortalSessionVerifier(store);
  const session = await verifier.verify('session-cookie-secret-value-0123456789abcdef');
  assert.ok(session);
  return { session, contextRef, contexts: new TenantContextService(repository),
    authorization: new TenantAuthorizationService(repository), repository };
}

function readRepository(onRead: (tenantId: string) => void): OperationsDiagnosticsRepository {
  const read = async (tenantId: string) => { onRead(tenantId); };
  return {
    async readOnboarding(tenantId) { await read(tenantId); return { status: 'READY', readiness: 'READY', nextAction: 'REAUTHORIZE', observedAt: '2026-11-12T11:00:00.000Z' }; },
    async readCredentialHealth(tenantId) { await read(tenantId); return { state: 'HEALTHY', credentialStatus: 'ACTIVE', reasonCode: 'TOKEN_SECRET_SENTINEL', observedAt: '2026-11-12T11:00:00.000Z' }; },
    async readGrantCounts(tenantId) { await read(tenantId); return { totalCount: 0, grantedCount: 0, revokedCount: 0 }; },
    async readSubscription(tenantId) { await read(tenantId); return { state: 'ACTIVE', observedState: 'SUBSCRIBED', reasonCode: null, observedAt: '2026-11-12T11:00:00.000Z' }; },
    async readWebhook(tenantId) { await read(tenantId); return { state: 'PROCESSED', reasonCode: null, observedAt: '2026-11-12T11:00:00.000Z' }; },
    async readJobCounts(tenantId) { await read(tenantId); return { QUEUED: 1 }; },
    async readProjectionCounts(tenantId) { await read(tenantId); throw new Error('private database message payload'); },
  };
}

test('MySQL read model uses tenant parameters and selects only approved metadata', async () => {
  const statements: Array<{ readonly sql: string; readonly params: unknown[] }> = [];
  const database = {
    async getDataSource() {
      return { async query(sql: string, params: unknown[] = []) {
        statements.push({ sql, params });
        if (sql.includes('ca_meta_onboarding_sessions')) return [{ status: 'READY', readiness: 'READY', next_action: 'NONE', observed_at: '2026-11-12T11:00:00.000Z' }];
        if (sql.includes('ca_meta_credentials')) return [{ state: 'HEALTHY', credential_status: 'ACTIVE', reason_code: null, observed_at: '2026-11-12T11:00:00.000Z' }];
        if (sql.includes('ca_meta_authorization_scopes')) return [{ total_count: 1, granted_count: 1, revoked_count: 0 }];
        if (sql.includes('ca_meta_subscription_targets')) return [{ state: 'ACTIVE', observed_state: 'SUBSCRIBED', reason_code: null, observed_at: '2026-11-12T11:00:00.000Z' }];
        if (sql.includes('ca_meta_webhook_events')) return [{ state: 'PROCESSED', reason_code: null, observed_at: '2026-11-12T11:00:00.000Z' }];
        if (sql.includes('ca_meta_jobs')) return [{ job_status: 'QUEUED', count: 2 }];
        if (sql.includes('ca_meta_legacy_projection_checkpoints')) return [{ state: 'PENDING', count: 3 }];
        return [];
      } };
    },
  } as never;
  const repository = new MysqlOperationsDiagnosticsRepository(database);
  await Promise.all([repository.readOnboarding(tenantA), repository.readCredentialHealth(tenantA),
    repository.readGrantCounts(tenantA), repository.readSubscription(tenantA), repository.readWebhook(tenantA),
    repository.readJobCounts(tenantA), repository.readProjectionCounts(tenantA)]);
  assert.equal(statements.length, 7);
  for (const statement of statements) {
    assert.deepEqual(statement.params, [tenantA]);
    assert.match(statement.sql, /WHERE[\s\S]*tenant_id = \?/i);
    assert.doesNotMatch(statement.sql, /payload|message|access.?token|app.?secret|provider.?object.?id|graph.?url/i);
  }
});

test('diagnostics read uses the verified tenant, strips unsafe values and keeps missing projection explicit', async () => {
  const auth = await fixture('viewer');
  const queriedTenants: string[] = [];
  const service = new OperationsDiagnosticsService(readRepository((tenant) => queriedTenants.push(tenant)), auth.authorization,
    () => new Date('2026-11-12T11:01:00.000Z'));
  const scope = await auth.contexts.resolveCurrent(auth.session, auth.contextRef);
  const result = await service.read(scope, requestRef());

  assert.equal(queriedTenants.length, 7);
  assert.ok(queriedTenants.every((tenant) => tenant === tenantA));
  assert.equal(result.grants.state, 'UNKNOWN');
  assert.equal(result.projection.state, 'UNKNOWN');
  assert.equal(result.projection.reasonCode, 'PROJECTION_RUNTIME_NOT_CONFIGURED');
  assert.equal(result.projection.pendingCount, null);
  assert.equal(result.projection.lagSeconds, null);
  assert.equal(result.nextAction, 'WAIT_FOR_PROCESSING');
  assert.equal(result.onboarding.nextAction, 'REQUEST_REAUTHORIZATION');
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('TOKEN_SECRET_SENTINEL'), false);
  assert.equal(serialized.includes('payload'), false);

  await assert.rejects(() => service.read({ tenantId: tenantB } as never, requestRef()), IdentityDeniedError);
  assert.ok(queriedTenants.every((tenant) => tenant !== tenantB));
});

test('diagnostic export demands a current SUPPORT role grant, audits before reading and redacts payload markers', async () => {
  const events: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  const audit = { async record(event: Record<string, unknown>) { order.push('audit'); events.push(event); return requestRef(); } } as never;
  let reads = 0;
  const validSupport: SupportAccessAuthorizationPort = {
    async authorize(input) { return { ...input, role: 'SUPPORT', expiresAt: new Date(Date.now() + 30_000).toISOString() }; },
  };
  const service = new SupportDiagnosticService(audit, validSupport);
  const output = await service.read({ tenantId: tenantA, actorRef: 'support-agent-01', targetRef: tenantA, reasonCode: 'INCIDENT' },
    requestRef(), async () => {
      reads += 1;
    order.push('read');
      return { state: 'UNKNOWN', credentialHealth: { state: 'UNKNOWN', reasonCode: 'STATUS_NOT_OBSERVED' },
        message: 'M5_10_MESSAGE_SENTINEL', accessToken: 'M5_10_TOKEN_SENTINEL', payload: { text: 'private payload' } };
    });
  assert.equal(reads, 1);
  assert.deepEqual(order, ['audit', 'read']);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.action, 'SUPPORT_DIAGNOSTIC_ACCESS');
  assert.deepEqual(events[0]?.safeDiff, { reasonCode: 'INCIDENT' });
  assert.equal(JSON.stringify(output).includes('M5_10_MESSAGE_SENTINEL'), false);
  assert.equal(JSON.stringify(output).includes('M5_10_TOKEN_SENTINEL'), false);
  assert.equal(JSON.stringify(output).includes('private payload'), false);
  assert.deepEqual((output as { credentialHealth?: unknown }).credentialHealth,
    { state: 'UNKNOWN', reasonCode: 'STATUS_NOT_OBSERVED' }, 'safe credential health status remains in the export');

  const wrongRole: SupportAccessAuthorizationPort = {
    async authorize(input) { return { ...input, role: 'admin' as 'SUPPORT', expiresAt: new Date(Date.now() + 30_000).toISOString() }; },
  };
  await assert.rejects(() => new SupportDiagnosticService(audit, wrongRole).read({
    tenantId: tenantA, actorRef: 'support-agent-01', targetRef: tenantA, reasonCode: 'INCIDENT',
  }, requestRef(), async () => { reads += 1; return {}; }), /support diagnostic access denied/i);
  assert.equal(reads, 1, 'denied support access is rejected before diagnostics are read');
  const longGrant: SupportAccessAuthorizationPort = {
    async authorize(input) { return { ...input, role: 'SUPPORT', expiresAt: new Date(Date.now() + 16 * 60_000).toISOString() }; },
  };
  await assert.rejects(() => new SupportDiagnosticService(audit, longGrant).read({
    tenantId: tenantA, actorRef: 'support-agent-01', targetRef: tenantA, reasonCode: 'INCIDENT',
  }, requestRef(), async () => { reads += 1; return {}; }), /support diagnostic access denied/i);
  assert.equal(reads, 1, 'support grants over fifteen minutes are rejected before diagnostics are read');
});

function replayHarness(effectMode: 'SAFE_RETRY' | 'AMBIGUOUS') {
  const scopeReads: Array<readonly unknown[]> = [];
  const replayAudits: unknown[][] = [];
  const enqueued = new Map<string, string>();
  let enqueueCalls = 0;
  const source = {
    async query(sql: string, params: unknown[]) {
      if (sql.includes('SELECT job.resource_scope_ref')) {
        scopeReads.push(params);
        return [{ resource_scope_ref: projectionScope }];
      }
      return [];
    },
    async transaction<T>(work: (manager: { query(sql: string, params?: unknown[]): Promise<unknown> }) => Promise<T>): Promise<T> {
      return work({
        async query(sql: string, params: unknown[] = []) {
          if (sql.includes('SELECT id FROM ca_meta_tenants')) return [{ id: tenantA }];
          if (sql.includes('FROM ca_meta_job_dead_letters dl')) return [{ id: '40000000-0000-4000-8000-000000000004',
            job_type: 'PROJECTION_RECONCILE', effect_mode: effectMode, resource_scope_ref: projectionScope,
            correlation_id: '50000000-0000-4000-8000-000000000005',
            payload_json: JSON.stringify({ kind: 'PROJECTION_RECONCILE', projectionRef: projectionScope, sourceVersion: 1 }) }];
          if (sql.includes('INSERT INTO ca_meta_replay_audit')) { replayAudits.push(params); return { affectedRows: 1 }; }
          return { affectedRows: 1 };
        },
      });
    },
  };
  const database = { async getDataSource() { return source; } } as unknown as DurableWorkDatabase;
  const jobs = {
    async enqueueWithin(_manager: unknown, input: { idempotencyKey: string }) {
      enqueueCalls += 1;
      const current = enqueued.get(input.idempotencyKey);
      if (current) return { id: current, duplicate: true };
      const id = '60000000-0000-4000-8000-000000000006';
      enqueued.set(input.idempotencyKey, id);
      return { id, duplicate: false };
    },
  } as unknown as DurableJobStore;
  return { database, jobs, scopeReads, replayAudits, get enqueueCalls() { return enqueueCalls; } };
}

function actionService(input: {
  readonly auth: Fixture;
  readonly database: DurableWorkDatabase;
  readonly jobs: DurableJobStore;
  readonly support: SupportOperationsAuthorizationPort;
  readonly events: Array<Record<string, unknown>>;
}) {
  const audit = { async record(event: Record<string, unknown>) { input.events.push(event); return requestRef(); } } as never;
  return new OperationsActionService(input.auth.contexts, input.auth.authorization, {} as never, {} as never, {} as never,
    input.database, input.jobs, input.support, audit);
}

const replayAction: OperationsActionRequest = { action: 'REPLAY_JOB', resourceRef: deadLetterRef, reasonCode: 'INCIDENT' };

test('replay requires tenant membership and SUPPORT grant; eligible replay is deterministic and ambiguous work is refused', async () => {
  const deniedAuth = await fixture('operator');
  let getDataSourceCalls = 0;
  const neverDatabase = { async getDataSource() { getDataSourceCalls += 1; throw new Error('must not read'); } } as unknown as DurableWorkDatabase;
  const neverJobs = {} as DurableJobStore;
  const deniedService = actionService({ auth: deniedAuth, database: neverDatabase, jobs: neverJobs,
    support: { async authorize() { return null; } }, events: [] });
  const baseInput = { session: deniedAuth.session, tenantContextRef: deniedAuth.contextRef,
    idempotencyKey: 'operations-action-00000001', requestId: requestRef(), action: replayAction };
  const denied = await deniedService.execute(baseInput);
  assert.equal(denied.outcome, 'UNAVAILABLE');
  assert.equal(denied.reasonCode, 'SUPPORT_ROLE_NOT_CONFIRMED');
  assert.equal(getDataSourceCalls, 0);

  const viewer = await fixture('viewer');
  const viewerService = actionService({ auth: viewer, database: neverDatabase, jobs: neverJobs,
    support: { async authorize() { throw new Error('support authorization must not run'); } }, events: [] });
  await assert.rejects(() => viewerService.execute({ ...baseInput, session: viewer.session,
    tenantContextRef: viewer.contextRef, requestId: requestRef() }), IdentityDeniedError);
  assert.equal(getDataSourceCalls, 0);

  const supportGrant: SupportOperationsAuthorizationPort = {
    async authorize(request) { return { ...request, role: 'SUPPORT', authorizationRef: 'support-grant-01',
      expiresAt: new Date(Date.now() + 30_000).toISOString() }; },
  };
  const authorized = await fixture('operator');
  const safeReplay = replayHarness('SAFE_RETRY');
  const events: Array<Record<string, unknown>> = [];
  const safeService = actionService({ auth: authorized, database: safeReplay.database, jobs: safeReplay.jobs,
    support: supportGrant, events });
  const first = await safeService.execute({ ...baseInput, session: authorized.session, tenantContextRef: authorized.contextRef,
    requestId: requestRef() });
  const second = await safeService.execute({ ...baseInput, session: authorized.session, tenantContextRef: authorized.contextRef,
    requestId: requestRef() });
  assert.equal(first.outcome, 'ACCEPTED');
  assert.equal(first.reasonCode, 'REPLAY_ENQUEUED');
  assert.equal(second.outcome, 'DUPLICATE');
  assert.equal(second.reasonCode, 'REPLAY_DUPLICATE');
  assert.equal(safeReplay.enqueueCalls, 2);
  assert.ok(safeReplay.scopeReads.every((params) => params[0] === tenantA && params[1] === deadLetterRef));
  assert.ok(safeReplay.replayAudits.length === 2);
  assert.ok(events.every((event) => event.action === 'SUPPORT_DIAGNOSTIC_ACCESS'));

  const ambiguous = replayHarness('AMBIGUOUS');
  const ambiguousService = actionService({ auth: authorized, database: ambiguous.database, jobs: ambiguous.jobs,
    support: supportGrant, events: [] });
  const refused = await ambiguousService.execute({ ...baseInput, session: authorized.session,
    tenantContextRef: authorized.contextRef, requestId: requestRef() });
  assert.equal(refused.outcome, 'REJECTED');
  assert.equal(refused.reasonCode, 'AMBIGUOUS_EFFECT_NOT_REPLAYABLE');
  assert.equal(ambiguous.enqueueCalls, 0, 'ambiguous provider outcomes never get a new job');
});

test('tenant refresh action stays audited and unavailable until identity confirmation is trusted', async () => {
  let refreshCalls = 0;
  for (const role of ['owner', 'admin', 'operator'] as const) {
    const auth = await fixture(role);
    const events: Array<Record<string, unknown>> = [];
    const audit = { async record(event: Record<string, unknown>) { events.push(event); return requestRef(); } } as never;
    const service = new OperationsActionService(auth.contexts, auth.authorization,
      { async refreshAsset() { refreshCalls += 1; return { jobId: requestRef() }; } } as never,
      {} as never, {} as never, {} as never, {} as never, undefined, audit);
    const result = await service.execute({ session: auth.session, tenantContextRef: auth.contextRef,
      idempotencyKey: `operations-action-${role}-0001`, requestId: requestRef(),
      action: { action: 'REVALIDATE', resourceRef: deadLetterRef, reasonCode: 'CUSTOMER_REQUEST' } });
    assert.equal(result.outcome, 'UNAVAILABLE');
    assert.equal(result.reasonCode, 'TENANT_IDENTITY_NOT_CONFIRMED');
    assert.equal(events.length, 1, `${role} action attempt is recorded before it is disabled`);
  }
  const viewer = await fixture('viewer');
  const viewerService = new OperationsActionService(viewer.contexts, viewer.authorization, {} as never,
    {} as never, {} as never, {} as never, {} as never);
  await assert.rejects(() => viewerService.execute({ session: viewer.session, tenantContextRef: viewer.contextRef,
    idempotencyKey: 'operations-action-viewer-001', requestId: requestRef(),
    action: { action: 'REVALIDATE', resourceRef: deadLetterRef, reasonCode: 'CUSTOMER_REQUEST' } }), IdentityDeniedError);
  assert.equal(refreshCalls, 0);
});
