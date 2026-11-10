import type { EntityManager } from 'typeorm';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { DurableJobStore, EnqueuedJob } from '../jobs/job-store.js';
import { IdentityDeniedError } from '../identity/identity.errors.js';
import { isVerifiedPortalSession, type VerifiedPortalSession } from '../identity/identity.trust.js';
import { TenantAuthorizationService, TenantContextService } from '../identity/identity.service.js';
import { hashOnboardingValue, OnboardingConfigurationUnavailableError, type OnboardingFlowConfigurationResolver,
  type OnboardingSessionStore, type OnboardingStoredRecord } from './onboarding-session.types.js';
import type { OnboardingSagaAdapter } from './onboarding-saga.types.js';
import { assertOwnedOnboardingSagaEvidence, assertSafeOnboardingSagaEvidence,
  type OnboardingSagaEvidenceContext, type OnboardingSagaEvidenceValues } from './onboarding-saga-evidence.js';

export const ONBOARDING_SAGA_RECOVERY_STORE = Symbol('ONBOARDING_SAGA_RECOVERY_STORE');

export type OnboardingSagaStage = 'authorization' | 'asset-verification' | 'subscription' | 'projection';
export type OnboardingRecoveryAction = 'RESUME' | 'RECONCILE';

export class OnboardingRecoveryConflictError extends Error {
  constructor() { super('The requested onboarding recovery action is not currently available.'); this.name = 'OnboardingRecoveryConflictError'; }
}

export class OnboardingRecoveryNotFoundError extends Error {
  constructor() { super('The onboarding session is unavailable.'); this.name = 'OnboardingRecoveryNotFoundError'; }
}

export interface QueueOnboardingRecoveryInput {
  readonly record: OnboardingStoredRecord;
  readonly principalId: string;
  readonly portalSessionId: string;
  readonly stage: OnboardingSagaStage;
  readonly action: OnboardingRecoveryAction;
  readonly idempotencyKey: string;
}

export interface OnboardingSagaRecoveryStore {
  queue(input: QueueOnboardingRecoveryInput): Promise<EnqueuedJob>;
}

interface LockedSessionRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly portal_session_id: string;
  readonly configuration_ref: string;
  readonly flow_variant: OnboardingStoredRecord['flowVariant'];
  readonly auth_variant: string;
  readonly provider_app_id: string;
  readonly provider_environment: string;
  readonly capability_manifest_version: string;
  readonly graph_api_version: string;
  readonly status: string;
  readonly steps_json: string | Buffer | readonly { readonly name: string; readonly status: string }[];
  readonly saga_checkpoint_json: string | Buffer | Record<string, unknown>;
}

interface RecoveryStep { readonly name: OnboardingSagaStage; readonly status: string; }

function decodeJson<T>(value: string | Buffer | T): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8')) as T;
  return value as T;
}

function recoverySteps(value: LockedSessionRow['steps_json']): RecoveryStep[] {
  const stages: readonly OnboardingSagaStage[] = ['authorization', 'asset-verification', 'subscription', 'projection'];
  const parsed = decodeJson<unknown>(value);
  if (!Array.isArray(parsed) || parsed.length !== stages.length || !parsed.every((step) =>
    typeof step?.name === 'string' && stages.includes(step.name) &&
    ['PENDING', 'RUNNING', 'SUCCEEDED', 'RETRY_PENDING', 'FAILED', 'UNKNOWN', 'SKIPPED'].includes(step.status))) {
    throw new OnboardingRecoveryConflictError();
  }
  return parsed as RecoveryStep[];
}

function recoveryEvidence(value: LockedSessionRow['saga_checkpoint_json']): Record<string, unknown> {
  const parsed = decodeJson<Record<string, unknown>>(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    Object.keys(parsed).some((key) => !['authorizationRef', 'verifiedAssetRefs', 'subscriptionRef', 'projectionRef'].includes(key))) {
    throw new OnboardingRecoveryConflictError();
  }
  return parsed;
}

function jobIdempotencyKey(input: QueueOnboardingRecoveryInput): string {
  if (!/^[a-f0-9]{64}$/.test(input.idempotencyKey)) throw new OnboardingRecoveryConflictError();
  return `onboarding-recovery:${input.idempotencyKey}`;
}

function jobPayload(input: QueueOnboardingRecoveryInput) {
  return Object.freeze({ kind: 'ONBOARDING_STEP' as const, onboardingRef: input.record.id,
    stepRef: input.stage, ...(input.action === 'RECONCILE' ? { operation: 'RECONCILE' as const } : {}) });
}

export class MysqlOnboardingSagaRecoveryStore implements OnboardingSagaRecoveryStore {
  constructor(private readonly database: DurableWorkDatabase, private readonly jobs: DurableJobStore) {}

  async queue(input: QueueOnboardingRecoveryInput): Promise<EnqueuedJob> {
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction('READ COMMITTED', async (manager) => {
      const idempotencyKey = jobIdempotencyKey(input);
      const job = {
        tenantId: input.record.tenantId,
        type: 'ONBOARDING_STEP' as const,
        idempotencyKey,
        correlationId: input.record.id,
        causationId: input.record.id,
        resourceScopeRef: input.record.id,
        payload: jobPayload(input),
      };

      await assertCurrentActor(manager, input);
      const prior = await manager.query(
        `SELECT id FROM ca_meta_jobs WHERE tenant_id = ? AND job_type = 'ONBOARDING_STEP'
         AND idempotency_key = ? LIMIT 1 FOR UPDATE`, [input.record.tenantId, idempotencyKey],
      ) as Array<{ id: string }>;
      if (prior.length > 0) return enqueueRecoveryJob(this.jobs, manager, job);

      const rows = await manager.query(
        `SELECT id, tenant_id, principal_id, portal_session_id, configuration_ref, flow_variant, auth_variant,
                provider_app_id, provider_environment,
                capability_manifest_version, graph_api_version, status, steps_json, saga_checkpoint_json
         FROM ca_meta_onboarding_sessions
         WHERE tenant_id = ? AND id = ? AND principal_id = ? AND portal_session_id = ?
           AND expires_at > UTC_TIMESTAMP(6) AND status NOT IN ('CANCELLED', 'EXPIRED', 'FAILED', 'READY')
         LIMIT 1 FOR UPDATE`,
        [input.record.tenantId, input.record.id, input.principalId, input.portalSessionId],
      ) as LockedSessionRow[];
      const row = rows[0];
      if (!row || row.configuration_ref !== input.record.configurationRef || row.provider_app_id !== input.record.providerAppId ||
        row.provider_environment !== input.record.providerEnvironment || row.auth_variant !== input.record.authVariant ||
        row.capability_manifest_version !== input.record.capabilityManifestVersion ||
        row.graph_api_version !== input.record.graphApiVersion) throw new OnboardingRecoveryNotFoundError();
      const evidence = recoveryEvidence(row.saga_checkpoint_json);
      const evidenceContext: OnboardingSagaEvidenceContext = { tenantId: row.tenant_id, onboardingId: row.id,
        configurationRef: row.configuration_ref, providerAppId: row.provider_app_id,
        providerEnvironment: row.provider_environment, flowVariant: row.flow_variant, authVariant: row.auth_variant };
      try { await assertOwnedOnboardingSagaEvidence(manager, evidence as OnboardingSagaEvidenceValues, evidenceContext); } catch {
        throw new OnboardingRecoveryConflictError();
      }

      const activeJobs = await manager.query(
        `SELECT id FROM ca_meta_jobs WHERE tenant_id = ? AND job_type = 'ONBOARDING_STEP'
         AND resource_scope_ref = ? AND status IN ('QUEUED', 'RETRY_PENDING', 'RUNNING') LIMIT 1 FOR UPDATE`,
        [input.record.tenantId, input.record.id],
      ) as Array<{ id: string }>;
      if (activeJobs.length > 0) throw new OnboardingRecoveryConflictError();

      const steps = recoverySteps(row.steps_json);
      const targetIndex = steps.findIndex((step) => step.name === input.stage);
      if (targetIndex < 0) throw new OnboardingRecoveryConflictError();
      const target = steps[targetIndex];
      if (!target) throw new OnboardingRecoveryConflictError();

      let nextSteps = steps;
      if (input.action === 'RESUME') {
        if (input.stage === 'authorization' || target.status !== 'RETRY_PENDING') throw new OnboardingRecoveryConflictError();
        assertResumePrerequisites(input.stage, evidence, evidenceContext);
        nextSteps = steps.map((step) => step.name === input.stage ? { ...step, status: 'PENDING' } : step);
      } else {
        if (target.status !== 'UNKNOWN' && target.status !== 'RUNNING') throw new OnboardingRecoveryConflictError();
        nextSteps = steps.map((step) => step.name === input.stage ? { ...step, status: 'RUNNING' } : step);
      }

      await manager.query(
        `UPDATE ca_meta_onboarding_sessions SET status = 'PROVISIONING', readiness = 'UNKNOWN', steps_json = ?,
           next_action = ?, last_updated_at = UTC_TIMESTAMP(6), version = version + 1
         WHERE tenant_id = ? AND id = ? AND expires_at > UTC_TIMESTAMP(6)
           AND status NOT IN ('CANCELLED', 'EXPIRED', 'FAILED', 'READY')`,
        [JSON.stringify(nextSteps), input.action === 'RECONCILE' ? 'RECONCILE' : 'WAIT', input.record.tenantId, input.record.id],
      );
      return enqueueRecoveryJob(this.jobs, manager, job);
    });
  }
}

async function enqueueRecoveryJob(jobs: DurableJobStore, manager: EntityManager, job: {
  readonly tenantId: string; readonly type: 'ONBOARDING_STEP'; readonly idempotencyKey: string;
  readonly correlationId: string; readonly causationId: string; readonly resourceScopeRef: string;
  readonly payload: ReturnType<typeof jobPayload>;
}): Promise<EnqueuedJob> {
  try {
    return await jobs.enqueueWithin(manager, job);
  } catch (error) {
    if (error instanceof Error && error.message === 'Idempotency key conflicts with an existing job.') {
      throw new OnboardingRecoveryConflictError();
    }
    throw error;
  }
}

async function assertCurrentActor(manager: EntityManager, input: QueueOnboardingRecoveryInput): Promise<void> {
  const rows = await manager.query(
    `SELECT m.principal_id, ps.id AS portal_session_id
     FROM ca_meta_memberships m
     INNER JOIN ca_meta_principals p ON p.id = m.principal_id AND p.kind = 'USER' AND p.status = 'ACTIVE'
     INNER JOIN ca_meta_tenants t ON t.id = m.tenant_id AND t.status = 'ACTIVE'
     INNER JOIN ca_meta_portal_sessions ps ON ps.id = ? AND ps.principal_id = m.principal_id AND ps.tenant_id = m.tenant_id
       AND ps.revoked_at IS NULL AND ps.idle_expires_at > UTC_TIMESTAMP(6)
       AND ps.absolute_expires_at > UTC_TIMESTAMP(6)
     WHERE m.tenant_id = ? AND m.principal_id = ? AND m.principal_kind = 'USER' AND m.status = 'ACTIVE'
       AND (JSON_CONTAINS(m.roles, JSON_QUOTE('owner')) OR JSON_CONTAINS(m.roles, JSON_QUOTE('admin'))
         OR JSON_CONTAINS(m.roles, JSON_QUOTE('operator')))
     LIMIT 1 FOR UPDATE`,
    [input.portalSessionId, input.record.tenantId, input.principalId],
  ) as Array<{ principal_id: string; portal_session_id: string }>;
  if (rows.length !== 1 || rows[0]?.principal_id !== input.principalId ||
    rows[0]?.portal_session_id !== input.portalSessionId) throw new OnboardingRecoveryNotFoundError();
}

function assertResumePrerequisites(
  stage: OnboardingSagaStage,
  evidence: Record<string, unknown>,
  context: OnboardingSagaEvidenceContext,
): void {
  assertSafeOnboardingSagaEvidence(evidence as OnboardingSagaEvidenceValues, context);
  const assetRefs = evidence.verifiedAssetRefs;
  const hasAssets = Array.isArray(assetRefs) && assetRefs.length > 0;
  if (stage !== 'authorization' && typeof evidence.authorizationRef !== 'string') throw new OnboardingRecoveryConflictError();
  if (stage === 'projection' && (!hasAssets || typeof evidence.subscriptionRef !== 'string')) throw new OnboardingRecoveryConflictError();
  if (stage === 'subscription' && !hasAssets) throw new OnboardingRecoveryConflictError();
}

export class OnboardingSagaRecoveryService {
  constructor(
    private readonly sessions: OnboardingSessionStore,
    private readonly contexts: TenantContextService,
    private readonly authorization: TenantAuthorizationService,
    private readonly configurations: OnboardingFlowConfigurationResolver,
    private readonly recovery: OnboardingSagaRecoveryStore,
    private readonly adapter: OnboardingSagaAdapter | undefined,
) {}

  async request(
    session: VerifiedPortalSession,
    tenantContextRef: string,
    onboardingId: string,
    idempotencyKey: string,
    action: OnboardingRecoveryAction,
    stage: OnboardingSagaStage,
  ): Promise<EnqueuedJob> {
    if (!isVerifiedPortalSession(session)) throw new IdentityDeniedError();
    if (!/^[A-Za-z0-9._~-]{16,128}$/.test(idempotencyKey) || !/^[A-Za-z0-9_-]{1,128}$/.test(onboardingId)) {
      throw new OnboardingRecoveryConflictError();
    }
    const scope = await this.contexts.resolveCurrent(session, tenantContextRef);
    await this.authorization.authorize(scope, 'CONNECT', scope.tenantId);
    const record = await this.sessions.findForSession(onboardingId, session.sessionId, session.principalId);
    if (!record || record.tenantId !== scope.tenantId || record.expiresAt.getTime() <= Date.now() ||
      ['CANCELLED', 'EXPIRED', 'FAILED', 'READY'].includes(record.status)) throw new OnboardingRecoveryNotFoundError();

    const current = this.configurations.resolve(record.flowVariant);
    if (!current || current.configurationRef !== record.configurationRef || current.providerAppId !== record.providerAppId ||
      current.providerEnvironment !== record.providerEnvironment || current.authVariant !== record.authVariant ||
      current.capabilityManifestVersion !== record.capabilityManifestVersion || current.graphApiVersion !== record.graphApiVersion) {
      throw new OnboardingConfigurationUnavailableError();
    }
    if (!this.adapter || (action === 'RECONCILE' && !this.adapter.reconcileStage)) {
      throw new OnboardingConfigurationUnavailableError();
    }
    return this.recovery.queue({ record, principalId: session.principalId, portalSessionId: session.sessionId,
      stage, action, idempotencyKey: hashOnboardingValue(idempotencyKey) });
  }
}
