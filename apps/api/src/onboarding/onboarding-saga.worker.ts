import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { ClaimedJob, JobOutcome } from '../jobs/job-store.js';
import type { JobHandler } from '../worker/durable-worker.js';
import type { OnboardingStep } from './onboarding-session.types.js';
import type { OnboardingFlowConfigurationResolver } from './onboarding-session.types.js';
import type { OnboardingCodeConsumer } from './onboarding-code-submission.store.js';
import { OnboardingSagaEffectError, type OnboardingSagaAdapter, type OnboardingSagaContext } from './onboarding-saga.types.js';

type Stage = 'authorization' | 'asset-verification' | 'subscription' | 'projection';
type StepStatus = OnboardingStep['status'];

export interface SagaRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly portal_session_id: string;
  readonly flow_variant: OnboardingSagaContext['flowVariant'];
  readonly auth_variant: string;
  readonly configuration_ref: string;
  readonly capability_manifest_version: string;
  readonly graph_api_version: string;
  readonly expires_at: string | Date;
  readonly status: string;
  readonly steps_json: string | Buffer | readonly OnboardingStep[];
  readonly saga_checkpoint_json: string | Buffer | Record<string, unknown>;
}

export interface SagaCheckpoint {
  readonly authorizationRef?: string;
  readonly verifiedAssetRefs?: readonly string[];
  readonly subscriptionRef?: string;
  readonly projectionRef?: string;
}

export interface OnboardingSagaSnapshot {
  readonly row: SagaRow;
  readonly steps: OnboardingStep[];
  readonly evidence: SagaCheckpoint;
}

export interface OnboardingSagaCheckpointInput {
  readonly tenantId: string;
  readonly onboardingId: string;
  readonly status: string;
  readonly readiness: 'READY' | 'PARTIAL' | 'UNKNOWN';
  readonly nextAction: 'WAIT' | 'CHECK_STATUS' | 'REAUTHORIZE' | 'RECONCILE' | 'RESUME' | 'RESOLVE_CONFLICT' | 'NONE';
  readonly stage: Stage;
  readonly stepStatus: StepStatus;
  readonly evidence?: SagaCheckpoint;
}

export interface OnboardingSagaCheckpointPort {
  read(tenantId: string, onboardingId: string): Promise<OnboardingSagaSnapshot | undefined>;
  checkpoint(input: OnboardingSagaCheckpointInput): Promise<void>;
  startExchange(tenantId: string, onboardingId: string): Promise<boolean>;
  canContinue(tenantId: string, onboardingId: string): Promise<boolean>;
}

const STEPS: readonly Stage[] = ['authorization', 'asset-verification', 'subscription', 'projection'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function decodeJson<T>(value: string | Buffer | T): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8')) as T;
  return value as T;
}

function validReference(value: string): boolean { return /^[A-Za-z0-9:_-]{1,128}$/.test(value); }

function timestamp(value: string | Date): number {
  if (value instanceof Date) return value.getTime();
  return new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`).getTime();
}

function makeSteps(value: SagaRow['steps_json']): OnboardingStep[] {
  const parsed = decodeJson<unknown>(value);
  if (!Array.isArray(parsed) || parsed.length > 32 || !parsed.every((step) => typeof step?.name === 'string' &&
    STEPS.includes(step.name as Stage) && ['PENDING', 'RUNNING', 'SUCCEEDED', 'RETRY_PENDING', 'FAILED', 'UNKNOWN', 'SKIPPED'].includes(step.status))) {
    throw new Error('Onboarding saga checkpoints are malformed.');
  }
  return parsed.map((step) => ({ name: step.name, status: step.status })) as OnboardingStep[];
}

function makeCheckpoint(value: SagaRow['saga_checkpoint_json']): SagaCheckpoint {
  const parsed = decodeJson<Record<string, unknown>>(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    Object.keys(parsed).some((key) => !['authorizationRef', 'verifiedAssetRefs', 'subscriptionRef', 'projectionRef'].includes(key))) {
    throw new Error('Onboarding saga evidence is malformed.');
  }
  return parsed as SagaCheckpoint;
}

export class MysqlOnboardingSagaCheckpoints implements OnboardingSagaCheckpointPort {
  constructor(private readonly database: DurableWorkDatabase) {}

  async read(tenantId: string, onboardingId: string): Promise<{ readonly row: SagaRow; readonly steps: OnboardingStep[]; readonly evidence: SagaCheckpoint } | undefined> {
    const dataSource = await this.database.getDataSource();
    const rows = await dataSource.query(
      `SELECT id, tenant_id, principal_id, portal_session_id, flow_variant, auth_variant, configuration_ref,
              capability_manifest_version, graph_api_version, expires_at, status, steps_json, saga_checkpoint_json
       FROM ca_meta_onboarding_sessions WHERE tenant_id = ? AND id = ? LIMIT 1`, [tenantId, onboardingId],
    ) as SagaRow[];
    const row = rows[0];
    if (!row) return undefined;
    return Object.freeze({ row, steps: makeSteps(row.steps_json), evidence: makeCheckpoint(row.saga_checkpoint_json) });
  }

  async checkpoint(input: {
    readonly tenantId: string; readonly onboardingId: string; readonly status: string;
    readonly readiness: 'READY' | 'PARTIAL' | 'UNKNOWN'; readonly nextAction: 'WAIT' | 'CHECK_STATUS' | 'REAUTHORIZE' | 'RECONCILE' | 'RESUME' | 'RESOLVE_CONFLICT' | 'NONE';
    readonly stage: Stage; readonly stepStatus: StepStatus; readonly evidence?: SagaCheckpoint;
  }): Promise<void> {
    const dataSource = await this.database.getDataSource();
    await dataSource.transaction('READ COMMITTED', async (manager) => {
      const rows = await manager.query(
        `SELECT steps_json, saga_checkpoint_json FROM ca_meta_onboarding_sessions
         WHERE tenant_id = ? AND id = ? LIMIT 1 FOR UPDATE`, [input.tenantId, input.onboardingId],
      ) as Array<{ steps_json: SagaRow['steps_json']; saga_checkpoint_json: SagaRow['saga_checkpoint_json'] }>;
      const row = rows[0];
      if (!row) throw new Error('Onboarding saga target is unavailable.');
      const steps = makeSteps(row.steps_json);
      const index = steps.findIndex((step) => step.name === input.stage);
      if (index < 0) throw new Error('Onboarding saga stage is missing.');
      steps[index] = Object.freeze({ name: input.stage, status: input.stepStatus });
      const currentEvidence = makeCheckpoint(row.saga_checkpoint_json);
      const mergedEvidence = Object.freeze({ ...currentEvidence, ...input.evidence });
      assertSafeEvidence(mergedEvidence);
      await manager.query(
        `UPDATE ca_meta_onboarding_sessions
         SET status = ?, readiness = ?, steps_json = ?, saga_checkpoint_json = ?, next_action = ?,
             last_updated_at = UTC_TIMESTAMP(6), version = version + 1
         WHERE tenant_id = ? AND id = ? AND expires_at > UTC_TIMESTAMP(6)
           AND status NOT IN ('CANCELLED', 'EXPIRED', 'FAILED')`,
        [input.status, input.readiness, JSON.stringify(steps), JSON.stringify(mergedEvidence), input.nextAction,
          input.tenantId, input.onboardingId],
      );
    });
  }

  async startExchange(tenantId: string, onboardingId: string): Promise<boolean> {
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction('READ COMMITTED', async (manager) => {
      const rows = await manager.query(
        `SELECT s.steps_json FROM ca_meta_onboarding_sessions s
         INNER JOIN ca_meta_onboarding_codes c ON c.tenant_id = s.tenant_id AND c.onboarding_id = s.id
         WHERE s.tenant_id = ? AND s.id = ? AND s.status IN ('CODE_RECEIVED', 'PARTIAL')
           AND s.expires_at > UTC_TIMESTAMP(6) AND c.consumed_at IS NULL
           AND c.expires_at > UTC_TIMESTAMP(6) LIMIT 1 FOR UPDATE`, [tenantId, onboardingId],
      ) as Array<{ steps_json: SagaRow['steps_json'] }>;
      const row = rows[0];
      if (!row) return false;
      const steps = makeSteps(row.steps_json);
      const index = steps.findIndex((step) => step.name === 'authorization');
      if (index < 0 || !['PENDING', 'RETRY_PENDING'].includes(steps[index]?.status ?? '')) return false;
      steps[index] = Object.freeze({ name: 'authorization', status: 'RUNNING' });
      await manager.query(
        `UPDATE ca_meta_onboarding_sessions SET status = 'EXCHANGING', steps_json = ?, next_action = 'WAIT',
           last_updated_at = UTC_TIMESTAMP(6), version = version + 1
         WHERE tenant_id = ? AND id = ? AND status IN ('CODE_RECEIVED', 'PARTIAL') AND expires_at > UTC_TIMESTAMP(6)`,
        [JSON.stringify(steps), tenantId, onboardingId],
      );
      return true;
    });
  }

  async canContinue(tenantId: string, onboardingId: string): Promise<boolean> {
    const dataSource = await this.database.getDataSource();
    const rows = await dataSource.query(
      `SELECT s.id FROM ca_meta_onboarding_sessions s
       INNER JOIN ca_meta_tenants t ON t.id = s.tenant_id AND t.status = 'ACTIVE'
       INNER JOIN ca_meta_principals p ON p.id = s.principal_id AND p.kind = 'USER' AND p.status = 'ACTIVE'
       INNER JOIN ca_meta_portal_sessions ps ON ps.id = s.portal_session_id AND ps.principal_id = s.principal_id
         AND ps.tenant_id = s.tenant_id
         AND ps.revoked_at IS NULL AND ps.idle_expires_at > UTC_TIMESTAMP(6)
         AND ps.absolute_expires_at > UTC_TIMESTAMP(6)
       INNER JOIN ca_meta_memberships m ON m.tenant_id = s.tenant_id AND m.principal_id = s.principal_id
         AND m.principal_kind = 'USER' AND m.status = 'ACTIVE'
         AND (JSON_CONTAINS(m.roles, JSON_QUOTE('owner')) OR JSON_CONTAINS(m.roles, JSON_QUOTE('admin'))
           OR JSON_CONTAINS(m.roles, JSON_QUOTE('operator')))
       WHERE s.tenant_id = ? AND s.id = ? AND s.expires_at > UTC_TIMESTAMP(6)
         AND s.status NOT IN ('CANCELLED', 'EXPIRED', 'FAILED') LIMIT 1`,
      [tenantId, onboardingId],
    ) as Array<{ id: string }>;
    return rows.length === 1;
  }
}

function assertSafeEvidence(evidence: SagaCheckpoint): void {
  if (evidence.authorizationRef !== undefined && !validReference(evidence.authorizationRef)) throw new Error('Unsafe authorization evidence reference.');
  if (evidence.subscriptionRef !== undefined && !validReference(evidence.subscriptionRef)) throw new Error('Unsafe subscription evidence reference.');
  if (evidence.projectionRef !== undefined && !validReference(evidence.projectionRef)) throw new Error('Unsafe projection evidence reference.');
  if (evidence.verifiedAssetRefs !== undefined && (evidence.verifiedAssetRefs.length < 1 || evidence.verifiedAssetRefs.length > 100 ||
    new Set(evidence.verifiedAssetRefs).size !== evidence.verifiedAssetRefs.length || !evidence.verifiedAssetRefs.every((ref) => UUID.test(ref)))) {
    throw new Error('Unsafe verified asset evidence.');
  }
}

/** All provider effects execute between short durable checkpoints, never inside a database transaction. */
export function createOnboardingSagaHandler(
  database: DurableWorkDatabase,
  codes: OnboardingCodeConsumer,
  adapter: OnboardingSagaAdapter,
  checkpointPort?: OnboardingSagaCheckpointPort,
  configurations?: OnboardingFlowConfigurationResolver,
): JobHandler {
  const repository = checkpointPort ?? new MysqlOnboardingSagaCheckpoints(database);
  const run = async (job: ClaimedJob, signal: AbortSignal): Promise<JobOutcome> => {
    if (job.payload.kind !== 'ONBOARDING_STEP' || !STEPS.includes(job.payload.stepRef as Stage)) {
      return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
    }
    const onboardingId = job.payload.onboardingRef;
    let current = await repository.read(job.tenantId, onboardingId);
    if (!current || timestamp(current.row.expires_at) <= Date.now()) {
      return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
    }
    try { assertSafeEvidence(current.evidence); } catch {
      return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
    }
    if (current.row.status === 'CANCELLED' || current.row.status === 'EXPIRED' ||
      current.row.status === 'FAILED' || current.row.status === 'READY') {
      return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
    }

    if (configurations && !configurationMatches(configurations, current.row)) {
      await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: job.payload.stepRef as Stage,
        stepStatus: 'FAILED', status: 'PROVISIONING', readiness: 'UNKNOWN', nextAction: 'RESOLVE_CONFLICT' });
      return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
    }

    if (job.payload.operation === 'RECONCILE') {
      const stage = job.payload.stepRef as Stage;
      const stepStatus = current.steps.find((step) => step.name === stage)?.status;
      if ((stepStatus !== 'UNKNOWN' && stepStatus !== 'RUNNING') || !adapter.reconcileStage) {
        return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
      }
      if (!await repository.canContinue(job.tenantId, onboardingId) || !effectAllowed(configurations, current.row)) {
        return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
      }
      const context: OnboardingSagaContext = Object.freeze({ tenantId: job.tenantId, onboardingId,
        flowVariant: current.row.flow_variant, authVariant: current.row.auth_variant,
        configurationRef: current.row.configuration_ref, principalId: current.row.principal_id,
        portalSessionId: current.row.portal_session_id, correlationId: job.correlationId,
        capabilityManifestVersion: current.row.capability_manifest_version, graphApiVersion: current.row.graph_api_version });
      let disposition: 'APPLIED' | 'NO_EFFECT' | 'UNKNOWN' = 'UNKNOWN';
      let reconciledEvidence: SagaCheckpoint | undefined;
      try {
        // The principal, portal session, membership and config are checked again immediately before the read-only reconciliation call.
        if (!await repository.canContinue(job.tenantId, onboardingId) || !effectAllowed(configurations, current.row)) {
          return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
        }
        const result = await adapter.reconcileStage({ ...context, stage, evidence: current.evidence,
          idempotencyKey: `${onboardingId}:${stage}:reconcile`, signal });
        disposition = result.disposition;
        if (result.disposition === 'APPLIED') reconciledEvidence = result.evidence;
      } catch {
        disposition = 'UNKNOWN';
      }
      if (disposition === 'UNKNOWN') {
        await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage, stepStatus: 'UNKNOWN',
          status: 'PROVISIONING', readiness: 'UNKNOWN', nextAction: 'RECONCILE' });
        return { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' };
      }
      if (disposition === 'NO_EFFECT') {
        const authorizationStage = stage === 'authorization';
        await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage,
          stepStatus: authorizationStage ? 'FAILED' : 'RETRY_PENDING', status: 'PARTIAL', readiness: 'PARTIAL',
          nextAction: authorizationStage ? 'REAUTHORIZE' : 'RESUME' });
        return { kind: 'SUCCEEDED' };
      }
      const evidence = reconciledEvidence && stageEvidence(stage, reconciledEvidence);
      if (!evidence) {
        await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage, stepStatus: 'UNKNOWN',
          status: 'PROVISIONING', readiness: 'UNKNOWN', nextAction: 'RECONCILE' });
        return { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' };
      }
      await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage, stepStatus: 'SUCCEEDED',
        status: 'PROVISIONING', readiness: 'UNKNOWN', nextAction: 'WAIT', evidence });
      const { operation: _operation, ...payload } = job.payload;
      void _operation;
      return run({ ...job, payload }, signal);
    }

    let authorizationRef = current.evidence.authorizationRef;
    if (!authorizationRef) {
      if (!await repository.canContinue(job.tenantId, onboardingId)) {
        await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'authorization', stepStatus: 'FAILED',
          status: 'PARTIAL', readiness: 'PARTIAL', nextAction: 'REAUTHORIZE' });
        return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
      }
      if (!job.payload.codeRef || !await repository.startExchange(job.tenantId, onboardingId)) {
        await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'authorization', stepStatus: 'UNKNOWN',
          status: 'PARTIAL', readiness: 'PARTIAL', nextAction: 'REAUTHORIZE' });
        return { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' };
      }
      current = await repository.read(job.tenantId, onboardingId);
      if (!current) return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
      const consumed = await codes.consumeOnce({ tenantId: job.tenantId, onboardingId, codeRef: job.payload.codeRef });
      if (!consumed) {
        await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'authorization', stepStatus: 'FAILED',
          status: 'PARTIAL', readiness: 'PARTIAL', nextAction: 'REAUTHORIZE' });
        return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
      }
      const context: OnboardingSagaContext = Object.freeze({ ...consumed.context, correlationId: job.correlationId,
        capabilityManifestVersion: current.row.capability_manifest_version, graphApiVersion: current.row.graph_api_version });
      if (!effectAllowed(configurations, current.row)) {
        await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'authorization', stepStatus: 'FAILED',
          status: 'PROVISIONING', readiness: 'UNKNOWN', nextAction: 'RESOLVE_CONFLICT' });
        return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
      }
      if (!await repository.canContinue(job.tenantId, onboardingId)) {
        await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'authorization', stepStatus: 'FAILED',
          status: 'PARTIAL', readiness: 'PARTIAL', nextAction: 'REAUTHORIZE' });
        return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
      }
      try {
        const exchanged = await adapter.exchangeAuthorizationCode({ ...context, code: consumed.code,
          idempotencyKey: `${onboardingId}:authorization`, signal });
        if (!validReference(exchanged.authorizationRef)) throw new Error('Unverified authorization reference.');
        authorizationRef = exchanged.authorizationRef;
        await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'authorization', stepStatus: 'SUCCEEDED',
          status: 'EXCHANGING', readiness: 'UNKNOWN', nextAction: 'WAIT', evidence: { authorizationRef } });
      } catch (error) {
        if (error instanceof OnboardingSagaEffectError && error.disposition === 'NO_EFFECT') {
          await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'authorization', stepStatus: 'FAILED',
            status: 'PARTIAL', readiness: 'PARTIAL', nextAction: 'REAUTHORIZE' });
          return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
        }
        await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'authorization', stepStatus: 'UNKNOWN',
          status: 'PROVISIONING', readiness: 'UNKNOWN', nextAction: 'RECONCILE' });
        return { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' };
      }
    }

    current = await repository.read(job.tenantId, onboardingId);
    if (!current || !authorizationRef) return { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' };
    const baseContext: OnboardingSagaContext = Object.freeze({ tenantId: job.tenantId, onboardingId,
      flowVariant: current.row.flow_variant, authVariant: current.row.auth_variant,
      configurationRef: current.row.configuration_ref, principalId: current.row.principal_id,
      portalSessionId: current.row.portal_session_id, correlationId: job.correlationId,
      capabilityManifestVersion: current.row.capability_manifest_version, graphApiVersion: current.row.graph_api_version });

    let assetRefs = current.evidence.verifiedAssetRefs;
    if (!assetRefs) {
      if (!stageIsPending(current.steps, 'asset-verification')) return { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' };
      if (!await repository.canContinue(job.tenantId, onboardingId)) {
        await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'asset-verification', stepStatus: 'FAILED',
          status: 'PARTIAL', readiness: 'PARTIAL', nextAction: 'REAUTHORIZE' });
        return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
      }
      await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'asset-verification', stepStatus: 'RUNNING',
        status: 'EXCHANGING', readiness: 'UNKNOWN', nextAction: 'WAIT' });
      try {
        if (!effectAllowed(configurations, current.row)) {
          await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'asset-verification', stepStatus: 'FAILED',
            status: 'PROVISIONING', readiness: 'UNKNOWN', nextAction: 'RESOLVE_CONFLICT' });
          return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
        }
        if (!await repository.canContinue(job.tenantId, onboardingId)) {
          await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'asset-verification', stepStatus: 'FAILED',
            status: 'PARTIAL', readiness: 'PARTIAL', nextAction: 'REAUTHORIZE' });
          return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
        }
        const discovery = await adapter.discoverAndPersistAssets({ ...baseContext, authorizationRef,
          idempotencyKey: `${onboardingId}:asset-verification`, signal });
        assetRefs = discovery.assetRefs;
        if (!Array.isArray(assetRefs) || assetRefs.length === 0) {
          await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'asset-verification', stepStatus: 'FAILED',
            status: 'PARTIAL', readiness: 'PARTIAL', nextAction: 'REAUTHORIZE' });
          return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
        }
        assertSafeEvidence({ verifiedAssetRefs: assetRefs });
        await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'asset-verification', stepStatus: 'SUCCEEDED',
          status: 'ASSETS_VERIFIED', readiness: 'UNKNOWN', nextAction: 'WAIT', evidence: { verifiedAssetRefs: assetRefs } });
      } catch (error) {
        if (error instanceof OnboardingSagaEffectError && error.disposition === 'NO_EFFECT') {
          const automaticRetriesExhausted = job.attempt >= job.maxAttempts;
          await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'asset-verification', stepStatus: 'RETRY_PENDING',
            status: 'PARTIAL', readiness: 'PARTIAL', nextAction: automaticRetriesExhausted ? 'RESUME' : 'CHECK_STATUS' });
          return automaticRetriesExhausted ? { kind: 'SUCCEEDED' } :
            { kind: 'RETRYABLE_FAILURE', safeErrorCode: 'DEPENDENCY_UNAVAILABLE' };
        }
        await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'asset-verification', stepStatus: 'UNKNOWN',
          status: 'PROVISIONING', readiness: 'UNKNOWN', nextAction: 'RECONCILE' });
        return { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' };
      }
    }

    current = await repository.read(job.tenantId, onboardingId);
    if (!current || !assetRefs || assetRefs.length === 0) return { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' };
    let subscriptionRef = current.evidence.subscriptionRef;
    if (!subscriptionRef) {
      if (!await stageIsPending(current.steps, 'subscription')) return { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' };
      if (!await repository.canContinue(job.tenantId, onboardingId)) {
        await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'subscription', stepStatus: 'FAILED',
          status: 'PARTIAL', readiness: 'PARTIAL', nextAction: 'REAUTHORIZE' });
        return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
      }
      await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'subscription', stepStatus: 'RUNNING',
        status: 'PROVISIONING', readiness: 'UNKNOWN', nextAction: 'WAIT' });
      try {
        if (!effectAllowed(configurations, current.row)) {
          await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'subscription', stepStatus: 'FAILED',
            status: 'PROVISIONING', readiness: 'UNKNOWN', nextAction: 'RESOLVE_CONFLICT' });
          return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
        }
        if (!await repository.canContinue(job.tenantId, onboardingId)) {
          await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'subscription', stepStatus: 'FAILED',
            status: 'PARTIAL', readiness: 'PARTIAL', nextAction: 'REAUTHORIZE' });
          return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
        }
        const subscription = await adapter.ensureSubscriptions({ ...baseContext, authorizationRef, assetRefs,
          idempotencyKey: `${onboardingId}:subscription`, signal });
        if (!validReference(subscription.subscriptionRef)) throw new Error('Unverified subscription reference.');
        subscriptionRef = subscription.subscriptionRef;
        await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'subscription', stepStatus: 'SUCCEEDED',
          status: 'PROVISIONING', readiness: 'UNKNOWN', nextAction: 'WAIT', evidence: { subscriptionRef } });
      } catch (error) {
        if (error instanceof OnboardingSagaEffectError && error.disposition === 'NO_EFFECT') {
          const automaticRetriesExhausted = job.attempt >= job.maxAttempts;
          await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'subscription', stepStatus: 'RETRY_PENDING',
            status: 'PARTIAL', readiness: 'PARTIAL', nextAction: automaticRetriesExhausted ? 'RESUME' : 'CHECK_STATUS' });
          return automaticRetriesExhausted ? { kind: 'SUCCEEDED' } :
            { kind: 'RETRYABLE_FAILURE', safeErrorCode: 'DEPENDENCY_UNAVAILABLE' };
        }
        await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'subscription', stepStatus: 'UNKNOWN',
          status: 'PROVISIONING', readiness: 'UNKNOWN', nextAction: 'RECONCILE' });
        return { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' };
      }
    }

    current = await repository.read(job.tenantId, onboardingId);
    if (!current || !subscriptionRef) return { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' };
    let projectionRef = current.evidence.projectionRef;
    if (!projectionRef) {
      if (!await stageIsPending(current.steps, 'projection')) return { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' };
      if (!await repository.canContinue(job.tenantId, onboardingId)) {
        await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'projection', stepStatus: 'FAILED',
          status: 'PARTIAL', readiness: 'PARTIAL', nextAction: 'REAUTHORIZE' });
        return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
      }
      await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'projection', stepStatus: 'RUNNING',
        status: 'PROVISIONING', readiness: 'UNKNOWN', nextAction: 'WAIT' });
      try {
        if (!effectAllowed(configurations, current.row)) {
          await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'projection', stepStatus: 'FAILED',
            status: 'PROVISIONING', readiness: 'UNKNOWN', nextAction: 'RESOLVE_CONFLICT' });
          return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
        }
        if (!await repository.canContinue(job.tenantId, onboardingId)) {
          await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'projection', stepStatus: 'FAILED',
            status: 'PARTIAL', readiness: 'PARTIAL', nextAction: 'REAUTHORIZE' });
          return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
        }
        const projection = await adapter.publishProjection({ ...baseContext, authorizationRef, assetRefs, subscriptionRef,
          idempotencyKey: `${onboardingId}:projection`, signal });
        if (!validReference(projection.projectionRef)) throw new Error('Unverified projection reference.');
        projectionRef = projection.projectionRef;
      } catch (error) {
        if (error instanceof OnboardingSagaEffectError && error.disposition === 'NO_EFFECT') {
          const automaticRetriesExhausted = job.attempt >= job.maxAttempts;
          await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'projection', stepStatus: 'RETRY_PENDING',
            status: 'PARTIAL', readiness: 'PARTIAL', nextAction: automaticRetriesExhausted ? 'RESUME' : 'CHECK_STATUS' });
          return automaticRetriesExhausted ? { kind: 'SUCCEEDED' } :
            { kind: 'RETRYABLE_FAILURE', safeErrorCode: 'DEPENDENCY_UNAVAILABLE' };
        }
        await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'projection', stepStatus: 'UNKNOWN',
          status: 'PROVISIONING', readiness: 'UNKNOWN', nextAction: 'RECONCILE' });
        return { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' };
      }
      await repository.checkpoint({ tenantId: job.tenantId, onboardingId, stage: 'projection', stepStatus: 'SUCCEEDED',
        status: 'READY', readiness: 'READY', nextAction: 'NONE', evidence: { projectionRef } });
    }
    return { kind: 'SUCCEEDED' };
  };
  return run;
}

function stageEvidence(stage: Stage, evidence: SagaCheckpoint): SagaCheckpoint | undefined {
  switch (stage) {
    case 'authorization':
      if (typeof evidence.authorizationRef !== 'string' || !validReference(evidence.authorizationRef)) return undefined;
      return { authorizationRef: evidence.authorizationRef };
    case 'asset-verification':
      if (!Array.isArray(evidence.verifiedAssetRefs)) return undefined;
      try { assertSafeEvidence({ verifiedAssetRefs: evidence.verifiedAssetRefs }); } catch { return undefined; }
      return { verifiedAssetRefs: evidence.verifiedAssetRefs };
    case 'subscription':
      if (typeof evidence.subscriptionRef !== 'string' || !validReference(evidence.subscriptionRef)) return undefined;
      return { subscriptionRef: evidence.subscriptionRef };
    case 'projection':
      if (typeof evidence.projectionRef !== 'string' || !validReference(evidence.projectionRef)) return undefined;
      return { projectionRef: evidence.projectionRef };
  }
}

function configurationMatches(configurations: OnboardingFlowConfigurationResolver, row: SagaRow): boolean {
  const current = configurations.resolve(row.flow_variant);
  return !!current && current.configurationRef === row.configuration_ref && current.authVariant === row.auth_variant &&
    current.capabilityManifestVersion === row.capability_manifest_version && current.graphApiVersion === row.graph_api_version;
}

function effectAllowed(configurations: OnboardingFlowConfigurationResolver | undefined, row: SagaRow): boolean {
  return configurations === undefined || configurationMatches(configurations, row);
}

function stageIsPending(steps: readonly OnboardingStep[], stage: Stage): boolean {
  return steps.find((step) => step.name === stage)?.status === 'PENDING' ||
    steps.find((step) => step.name === stage)?.status === 'RETRY_PENDING';
}
