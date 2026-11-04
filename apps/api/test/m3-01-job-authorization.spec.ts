import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import {
  isVerifiedJobExecutionContext,
  MysqlJobExecutionAuthorizationPort,
} from '../src/jobs/job-execution-authorization.js';
import type { ClaimedJob } from '../src/jobs/job-store.js';
import { canonicalJson, JOB_POLICIES, type JobType } from '../src/jobs/event-validation.js';
import type { IdentityRepository } from '../src/identity/identity.repository.js';
import { ServiceTenantAuthorizationService } from '../src/identity/identity.service.js';
import type { ServiceTenantGrant } from '../src/identity/identity.types.js';
import { WorkerServiceIdentityVerifier } from '../src/identity/identity.trust.js';

const tenantA = '00000000-0000-4000-8000-000000000001';
const tenantB = '00000000-0000-4000-8000-000000000002';
const principalId = '00000000-0000-4000-8000-000000000003';
const proof = 'synthetic-worker-proof-with-more-than-32-bytes';

function jobFor(type: JobType): ClaimedJob {
  const payload: ClaimedJob['payload'] = type === 'ASSET_REFRESH'
    ? { kind: 'ASSET_REFRESH', assetId: '00000000-0000-4000-8000-000000000004', appConfigurationId: '00000000-0000-4000-8000-000000000005', environment: 'test' }
    : type === 'ONBOARDING_STEP'
      ? { kind: 'ONBOARDING_STEP', onboardingRef: '00000000-0000-4000-8000-000000000009', stepRef: 'step-synthetic' }
      : type === 'PROJECTION_RECONCILE'
      ? { kind: 'PROJECTION_RECONCILE', projectionRef: 'projection-synthetic', sourceVersion: 1 }
      : type === 'HISTORY_SYNC'
        ? { kind: 'HISTORY_SYNC', checkpointRef: 'checkpoint-synthetic' }
        : { kind: 'OUTBOX_DELIVER', outboxEventRef: '00000000-0000-4000-8000-000000000008' };
  const resourceScopeRef = type === 'ASSET_REFRESH' ? 'asset-scope-synthetic'
    : type === 'ONBOARDING_STEP' ? 'onboarding-scope-synthetic' : 'reference-only-synthetic';
  return {
    id: '00000000-0000-4000-8000-000000000006',
    tenantId: tenantA,
    resourceScopeRef,
    type,
    lane: JOB_POLICIES[type].lane,
    effectMode: JOB_POLICIES[type].effectMode,
    payload,
    idempotencyKey: 'synthetic-idempotency-key',
    correlationId: 'synthetic-correlation-id',
    causationId: null,
    attempt: 1,
    maxAttempts: JOB_POLICIES[type].maxAttempts,
    claimToken: '00000000-0000-4000-8000-000000000007',
    workerRef: 'synthetic-worker:1',
    budgetStartedAt: '2026-11-04T00:00:00.000Z',
    createdAt: '2026-11-04T00:00:00.000Z',
  };
}

function authorizationFor(options: {
  readonly type?: JobType;
  readonly tenantId?: string;
  readonly activeClaim?: boolean;
  readonly assetExists?: boolean;
  readonly assetRelationship?: 'ACTIVE_VERIFIED' | 'MISSING' | 'REVOKED' | 'UNVERIFIED';
  readonly assetAuthorizationState?: 'ACTIVE' | 'PARTIAL' | 'REVOKED' | 'DISCONNECTED';
  readonly onboardingMembership?: 'ACTIVE_CONNECT' | 'REVOKED' | 'VIEWER';
  readonly scopes?: ServiceTenantGrant['scopes'];
} = {}) {
  const job = jobFor(options.type ?? 'ASSET_REFRESH');
  const payloadHash = createHash('sha256').update(canonicalJson(job.payload)).digest('hex');
  const activeRow = {
    id: job.id,
    tenant_id: options.tenantId ?? tenantA,
    job_type: job.type,
    lane: job.lane,
    effect_mode: job.effectMode,
    resource_scope_ref: job.resourceScopeRef,
    correlation_id: job.correlationId,
    causation_id: job.causationId,
    payload_hash: payloadHash,
    attempt: job.attempt,
    max_attempts: job.maxAttempts,
  };
  const statements: string[] = [];
  const database = {
    async getDataSource() {
      return {
        async query(sql: string, parameters?: unknown[]) {
          statements.push(sql);
          if (sql.includes('FROM ca_meta_jobs')) {
            const claimMatches = !!parameters && parameters.includes(job.id) &&
              parameters.includes(job.claimToken) && parameters.includes(job.workerRef);
            return options.activeClaim === false || !claimMatches ? [] : [activeRow];
          }
          if (sql.includes('FROM ca_meta_assets')) {
            const hasAuthorizationFence = sql.includes('JOIN ca_meta_asset_authorizations AS aa') &&
              sql.includes("aa.state = 'ACTIVE'") && sql.includes("aa.verification_state = 'VERIFIED'") &&
              sql.includes('JOIN ca_meta_authorizations AS auth') &&
              sql.includes("auth.authorization_state IN ('ACTIVE', 'PARTIAL')");
            const relationship = options.assetRelationship ?? 'ACTIVE_VERIFIED';
            const authorizationState = options.assetAuthorizationState ?? 'ACTIVE';
            const verifiedRelationship = relationship === 'ACTIVE_VERIFIED';
            const activeAuthorization = authorizationState === 'ACTIVE' || authorizationState === 'PARTIAL';
            return options.assetExists === false || !hasAuthorizationFence || !verifiedRelationship || !activeAuthorization
              ? [] : [{ id: job.payload.kind === 'ASSET_REFRESH' ? job.payload.assetId : '' }];
          }
          if (sql.includes('FROM ca_meta_onboarding_sessions')) {
            const hasMembershipFence = sql.includes('JOIN ca_meta_memberships AS m') &&
              sql.includes("m.status = 'ACTIVE'") && sql.includes("p.status = 'ACTIVE'") &&
              sql.includes("t.status = 'ACTIVE'") && sql.includes("JSON_QUOTE('owner')") &&
              sql.includes("JSON_QUOTE('admin')") && sql.includes("JSON_QUOTE('operator')") &&
              sql.includes('onboarding.expires_at > UTC_TIMESTAMP(6)');
            return options.onboardingMembership === 'ACTIVE_CONNECT' && hasMembershipFence
              ? [{ steps_json: JSON.stringify([{ id: 'step-synthetic' }]) }] : [];
          }
          return [];
        },
      };
    },
  } as unknown as DurableWorkDatabase;
  const grant: ServiceTenantGrant = {
    tenantId: tenantA,
    principalId,
    principalKind: 'SERVICE',
    principalStatus: 'ACTIVE',
    tenantStatus: 'ACTIVE',
    scopes: options.scopes ?? ['META_CONNECTION_EXECUTE'],
  };
  const repository = {
    async findServiceTenantGrant(principal: string, tenant: string) {
      return principal === principalId && tenant === tenantA ? grant : undefined;
    },
  } as unknown as IdentityRepository;
  const identity = new WorkerServiceIdentityVerifier([{
    principalId,
    credentialSha256: createHash('sha256').update(proof).digest('hex'),
  }]).verify(proof);
  if (!identity) throw new Error('Synthetic worker identity was not issued.');
  const services = new ServiceTenantAuthorizationService(repository);
  return { job, authorization: new MysqlJobExecutionAuthorizationPort(database, services, identity), statements };
}

test('job authorization derives tenant from the live claim, checks the service grant and verifies the backing asset', async () => {
  const { job, authorization } = authorizationFor();
  const context = await authorization.authorize(job);
  assert.ok(context);
  assert.equal(isVerifiedJobExecutionContext(context), true);
  assert.equal(context.jobId, job.id);
  assert.equal(context.tenantId, tenantA);
  assert.equal(context.principalId, principalId);
  assert.equal(context.resourceRef, '00000000-0000-4000-8000-000000000004');
  assert.equal('claimToken' in context, false);
});

test('job authorization denies stale claims, tenant substitution, missing resource rows and missing service grants', async () => {
  const stale = authorizationFor({ activeClaim: false });
  assert.equal(await stale.authorization.authorize(stale.job), undefined);

  const original = authorizationFor();
  assert.equal(await original.authorization.authorize({ ...original.job, claimToken: 'forged-claim-token' }), undefined);
  assert.equal(await original.authorization.authorize({
    ...original.job,
    payload: { ...original.job.payload, assetId: '00000000-0000-4000-8000-000000000099' },
  }), undefined);

  const substituted = authorizationFor({ tenantId: tenantB });
  assert.equal(await substituted.authorization.authorize(substituted.job), undefined);

  const missingAsset = authorizationFor({ assetExists: false });
  assert.equal(await missingAsset.authorization.authorize(missingAsset.job), undefined);

  const missingScope = authorizationFor({ scopes: ['TENANT_RESOURCE_READ'] });
  assert.equal(await missingScope.authorization.authorize(missingScope.job), undefined);
});

test('asset refresh requires an active verified asset authorization and a currently usable authorization', async () => {
  for (const relationship of ['MISSING', 'REVOKED', 'UNVERIFIED'] as const) {
    const candidate = authorizationFor({ assetRelationship: relationship });
    assert.equal(await candidate.authorization.authorize(candidate.job), undefined);
  }
  for (const state of ['REVOKED', 'DISCONNECTED'] as const) {
    const candidate = authorizationFor({ assetAuthorizationState: state });
    assert.equal(await candidate.authorization.authorize(candidate.job), undefined);
  }

  const active = authorizationFor();
  assert.ok(await active.authorization.authorize(active.job));
  const assetQuery = active.statements.find((sql) => sql.includes('FROM ca_meta_assets'));
  assert.ok(assetQuery?.includes('JOIN ca_meta_asset_authorizations AS aa'));
  assert.ok(assetQuery?.includes("aa.state = 'ACTIVE'"));
  assert.ok(assetQuery?.includes("aa.verification_state = 'VERIFIED'"));
  assert.ok(assetQuery?.includes('JOIN ca_meta_authorizations AS auth'));
  assert.ok(assetQuery?.includes("auth.authorization_state IN ('ACTIVE', 'PARTIAL')"));
});

test('onboarding jobs recheck the persisted initiator current CONNECT membership', async () => {
  const active = authorizationFor({ type: 'ONBOARDING_STEP', onboardingMembership: 'ACTIVE_CONNECT' });
  assert.ok(await active.authorization.authorize(active.job));
  const onboardingQuery = active.statements.find((sql) => sql.includes('FROM ca_meta_onboarding_sessions'));
  assert.ok(onboardingQuery?.includes('JOIN ca_meta_memberships AS m'));
  assert.ok(onboardingQuery?.includes("m.status = 'ACTIVE'"));
  assert.ok(onboardingQuery?.includes("JSON_QUOTE('owner')"));
  assert.ok(onboardingQuery?.includes("JSON_QUOTE('admin')"));
  assert.ok(onboardingQuery?.includes("JSON_QUOTE('operator')"));

  for (const membership of ['REVOKED', 'VIEWER'] as const) {
    const candidate = authorizationFor({ type: 'ONBOARDING_STEP', onboardingMembership: membership });
    assert.equal(await candidate.authorization.authorize(candidate.job), undefined);
  }
});

test('reference-only projection and history jobs are denied until a tenant-owned resource mapping exists', async () => {
  for (const type of ['PROJECTION_RECONCILE', 'HISTORY_SYNC', 'OUTBOX_DELIVER'] as const) {
    const { authorization } = authorizationFor({ type });
    const job = jobFor(type);
    assert.equal(await authorization.authorize(job), undefined);
  }
});
