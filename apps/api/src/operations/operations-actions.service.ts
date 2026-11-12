import { IdentityDeniedError } from '../identity/identity.errors.js';
import { isAuthorizedTenantScope, TenantAuthorizationService, TenantContextService } from '../identity/identity.service.js';
import type { AuthorizedTenantScope } from '../identity/identity.types.js';
import type { VerifiedPortalSession } from '../identity/identity.trust.js';
import type { AssetCatalogService } from '../meta-assets/asset-catalog.service.js';
import { AssetRefreshUnavailableError } from '../meta-assets/asset-refresh.service.js';
import type { ConnectionLifecycleService } from '../meta-lifecycle/connection-lifecycle.service.js';
import { ConnectionLifecycleConfigurationUnavailableError } from '../meta-lifecycle/connection-lifecycle.service.js';
import type { OnboardingSagaRecoveryService } from '../onboarding/onboarding-saga-recovery.js';
import { OnboardingConfigurationUnavailableError } from '../onboarding/onboarding-session.types.js';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { DurableJobStore } from '../jobs/job-store.js';
import { ReplayDryRunService, type ReplayAuthorizationPort, type ReplayAuthorizationRequest, type ReplayRequestResult } from '../jobs/replay-dry-run.js';
import type { AuditEventWriter, SupportReasonCode } from '../privacy/audit.service.js';

export type OperationsActionName = 'REVALIDATE' | 'RESUME_STAGE' | 'RECONCILE_SUBSCRIPTION' | 'REQUEST_REAUTH' | 'REPLAY_JOB';
export type OperationsReasonCode = SupportReasonCode;
export type OperationsRecoveryStage = 'authorization' | 'asset-verification' | 'subscription' | 'projection';

export type OperationsActionRequest =
  | { readonly action: 'REVALIDATE'; readonly resourceRef: string; readonly reasonCode: OperationsReasonCode }
  | { readonly action: 'RESUME_STAGE'; readonly resourceRef: string; readonly stage: OperationsRecoveryStage; readonly reasonCode: OperationsReasonCode }
  | { readonly action: 'RECONCILE_SUBSCRIPTION'; readonly resourceRef: string; readonly reasonCode: OperationsReasonCode }
  | { readonly action: 'REQUEST_REAUTH'; readonly resourceRef: string; readonly reasonCode: OperationsReasonCode }
  | { readonly action: 'REPLAY_JOB'; readonly resourceRef: string; readonly reasonCode: OperationsReasonCode };

export interface OperationsActionResult {
  readonly action: OperationsActionName;
  readonly outcome: 'ACCEPTED' | 'DUPLICATE' | 'UNAVAILABLE' | 'REJECTED';
  readonly reasonCode: string;
  readonly requestId: string;
  readonly operationRef: string | null;
}

export interface SupportOperationsAuthorizationRequest {
  readonly tenantId: string;
  readonly actorRef: string;
  readonly targetRef: string;
  readonly action: 'RECONCILE_SUBSCRIPTION' | 'REPLAY_JOB';
  readonly reasonCode: OperationsReasonCode;
}

export interface SupportOperationsAuthorizationGrant extends SupportOperationsAuthorizationRequest {
  readonly role: 'SUPPORT';
  readonly authorizationRef: string;
  readonly expiresAt: string;
}

export interface SupportOperationsAuthorizationPort {
  authorize(input: SupportOperationsAuthorizationRequest): Promise<SupportOperationsAuthorizationGrant | null>;
}

export interface OperationsTenantIdentityAuthorizationPort {
  isConfirmed(scope: AuthorizedTenantScope): Promise<boolean>;
}

/** The current portal session has no trusted company display label; tenant writes stay disabled. */
export class FailClosedOperationsTenantIdentityAuthorization implements OperationsTenantIdentityAuthorizationPort {
  async isConfirmed(_scope: AuthorizedTenantScope): Promise<boolean> { return false; }
}

export class FailClosedSupportOperationsAuthorization implements SupportOperationsAuthorizationPort {
  async authorize(_input: SupportOperationsAuthorizationRequest): Promise<null> { return null; }
}

export class OperationsActionInputError extends Error {
  constructor() { super('Operations action request is invalid.'); this.name = 'OperationsActionInputError'; }
}

export class OperationsActionUnavailableError extends Error {
  constructor(readonly reasonCode: string) { super('The requested operation is not available.'); this.name = 'OperationsActionUnavailableError'; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY = /^[A-Za-z0-9._~-]{16,128}$/;
const OPAQUE_REF = /^[A-Za-z0-9:_-]{1,128}$/;
const MAX_SUPPORT_GRANT_TTL_MS = 15 * 60 * 1000;
const REASONS = new Set<OperationsReasonCode>(['INCIDENT', 'CUSTOMER_REQUEST', 'SECURITY_REVIEW']);
const STAGES = new Set<OperationsRecoveryStage>(['authorization', 'asset-verification', 'subscription', 'projection']);

function validGrant(input: SupportOperationsAuthorizationRequest, grant: SupportOperationsAuthorizationGrant | null): grant is SupportOperationsAuthorizationGrant {
  const expiresAt = grant ? Date.parse(grant.expiresAt) : NaN;
  const now = Date.now();
  return !!grant && grant.role === 'SUPPORT' && grant.tenantId === input.tenantId && grant.actorRef === input.actorRef &&
    grant.targetRef === input.targetRef && grant.action === input.action && grant.reasonCode === input.reasonCode &&
    OPAQUE_REF.test(grant.authorizationRef) && Number.isFinite(expiresAt) && expiresAt > now && expiresAt - now <= MAX_SUPPORT_GRANT_TTL_MS;
}

function replayReason(result: ReplayRequestResult): OperationsActionResult['outcome'] {
  if (result.reasonCode === 'REPLAY_DUPLICATE') return 'DUPLICATE';
  if (result.reasonCode === 'REPLAY_ENQUEUED') return 'ACCEPTED';
  if (result.reasonCode === 'AUTHORIZATION_UNAVAILABLE' || result.reasonCode === 'AUTHORIZATION_DENIED' ||
      result.reasonCode === 'AUTHORIZATION_EXPIRED' || result.reasonCode === 'GRANT_INVALID') return 'UNAVAILABLE';
  return 'REJECTED';
}

/** Portal action boundary. Tenant identity always comes from the live session plus its server-issued context reference. */
export class OperationsActionService {
  constructor(
    private readonly contexts: TenantContextService,
    private readonly authorization: TenantAuthorizationService,
    private readonly assets: AssetCatalogService,
    private readonly onboarding: OnboardingSagaRecoveryService,
    private readonly lifecycle: ConnectionLifecycleService,
    private readonly database: DurableWorkDatabase,
    private readonly jobs: DurableJobStore,
    private readonly supportAuthorization: SupportOperationsAuthorizationPort = new FailClosedSupportOperationsAuthorization(),
    private readonly audit?: AuditEventWriter,
    private readonly tenantIdentity: OperationsTenantIdentityAuthorizationPort = new FailClosedOperationsTenantIdentityAuthorization(),
  ) {}

  async execute(input: {
    readonly session: VerifiedPortalSession;
    readonly tenantContextRef: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
    readonly action: OperationsActionRequest;
  }): Promise<OperationsActionResult> {
    if (!input.session || !input.tenantContextRef || !IDEMPOTENCY.test(input.idempotencyKey) || !UUID.test(input.requestId)) {
      throw new OperationsActionInputError();
    }
    const action = input.action;
    if (!action || typeof action !== 'object' || !UUID.test(action.resourceRef) || !REASONS.has(action.reasonCode) ||
      (action.action === 'RESUME_STAGE' && !STAGES.has(action.stage)) ||
      !['REVALIDATE', 'RESUME_STAGE', 'RECONCILE_SUBSCRIPTION', 'REQUEST_REAUTH', 'REPLAY_JOB'].includes(action.action)) {
      throw new OperationsActionInputError();
    }

    const scope = await this.contexts.resolveCurrent(input.session, input.tenantContextRef);
    if (!isAuthorizedTenantScope(scope)) throw new IdentityDeniedError();

    if (action.action === 'REVALIDATE') {
      await this.authorization.authorize(scope, 'REAUTHORIZE', scope.tenantId);
      await this.recordTenantAction(scope, input.session.principalId, action.resourceRef, action.action, action.reasonCode, input.requestId);
      if (!await this.tenantIdentityConfirmed(scope)) {
        return this.result(action.action, 'UNAVAILABLE', 'TENANT_IDENTITY_NOT_CONFIRMED', input.requestId);
      }
      try {
        const accepted = await this.assets.refreshAsset(input.session, input.tenantContextRef, action.resourceRef, input.requestId);
        return this.result(action.action, 'ACCEPTED', 'REFRESH_QUEUED', input.requestId, accepted.jobId);
      } catch (error) {
        if (error instanceof AssetRefreshUnavailableError) return this.result(action.action, 'UNAVAILABLE', 'REFRESH_ADAPTER_UNAVAILABLE', input.requestId);
        throw error;
      }
    }

    if (action.action === 'RESUME_STAGE') {
      await this.authorization.authorize(scope, 'CONNECT', scope.tenantId);
      await this.recordTenantAction(scope, input.session.principalId, action.resourceRef, action.action, action.reasonCode, input.requestId);
      if (!await this.tenantIdentityConfirmed(scope)) {
        return this.result(action.action, 'UNAVAILABLE', 'TENANT_IDENTITY_NOT_CONFIRMED', input.requestId);
      }
      try {
        const accepted = await this.onboarding.request(input.session, input.tenantContextRef, action.resourceRef,
          input.idempotencyKey, 'RESUME', action.stage);
        return this.result(action.action, 'ACCEPTED', 'STAGE_RESUME_QUEUED', input.requestId, accepted.id);
      } catch (error) {
        if (error instanceof OnboardingConfigurationUnavailableError) return this.result(action.action, 'UNAVAILABLE', 'ONBOARDING_ADAPTER_UNAVAILABLE', input.requestId);
        throw error;
      }
    }

    if (action.action === 'REQUEST_REAUTH') {
      await this.authorization.authorize(scope, 'REAUTHORIZE', scope.tenantId);
      await this.recordTenantAction(scope, input.session.principalId, action.resourceRef, action.action, action.reasonCode, input.requestId);
      if (!await this.tenantIdentityConfirmed(scope)) {
        return this.result(action.action, 'UNAVAILABLE', 'TENANT_IDENTITY_NOT_CONFIRMED', input.requestId);
      }
      try {
        const created = await this.lifecycle.reauthorize({ session: input.session, tenantContextRef: input.tenantContextRef,
          authorizationRef: action.resourceRef, idempotencyKey: input.idempotencyKey, requestId: input.requestId });
        return this.result(action.action, 'ACCEPTED', 'REAUTHORIZATION_REQUESTED', input.requestId, created.id);
      } catch (error) {
        if (error instanceof ConnectionLifecycleConfigurationUnavailableError) return this.result(action.action, 'UNAVAILABLE', 'REAUTHORIZATION_NOT_CONFIGURED', input.requestId);
        throw error;
      }
    }

    await this.authorization.authorize(scope, 'REPLAY_EVENT', scope.tenantId);
    const supportRequest: SupportOperationsAuthorizationRequest = Object.freeze({
      tenantId: scope.tenantId,
      actorRef: input.session.principalId,
      targetRef: action.resourceRef,
      action: action.action,
      reasonCode: action.reasonCode,
    });
    if (action.action === 'RECONCILE_SUBSCRIPTION') {
      const grant = await this.authorizeSupport(supportRequest);
      if (!grant) return this.result(action.action, 'UNAVAILABLE', 'SUPPORT_ROLE_NOT_CONFIRMED', input.requestId);
      await this.recordSupportAction(scope, input.session.principalId, action.resourceRef, action.action, action.reasonCode, input.requestId);
      return this.result(action.action, 'UNAVAILABLE', 'SUBSCRIPTION_ADAPTER_NOT_CONFIRMED', input.requestId);
    }

    const grant = await this.authorizeSupport(supportRequest);
    if (!grant) return this.result(action.action, 'UNAVAILABLE', 'SUPPORT_ROLE_NOT_CONFIRMED', input.requestId);
    await this.recordSupportAction(scope, input.session.principalId, action.resourceRef, action.action, action.reasonCode, input.requestId);
    const scopeRef = await this.readReplayScope(scope.tenantId, action.resourceRef);
    if (!scopeRef) return this.result(action.action, 'REJECTED', 'DEAD_LETTER_NOT_FOUND', input.requestId);

    const replayAuthorization: ReplayAuthorizationPort = {
      authorize: async (request: ReplayAuthorizationRequest) => {
        if (request.tenantId !== supportRequest.tenantId || request.deadLetterId !== supportRequest.targetRef ||
            request.operatorRef !== supportRequest.actorRef || request.scopeRef !== scopeRef || request.action !== 'REQUEUE' || request.dryRun) return null;
        return Object.freeze({ ...request, authorizationRef: grant.authorizationRef, expiresAt: grant.expiresAt });
      },
    };
    const replay = new ReplayDryRunService(this.database, replayAuthorization, this.jobs);
    const outcome = await replay.requeue({ tenantId: scope.tenantId, deadLetterId: action.resourceRef,
      scopeRef, operatorRef: input.session.principalId });
    return this.result(action.action, replayReason(outcome), outcome.reasonCode, input.requestId, outcome.jobId);
  }

  private async authorizeSupport(input: SupportOperationsAuthorizationRequest): Promise<SupportOperationsAuthorizationGrant | undefined> {
    try {
      const grant = await this.supportAuthorization.authorize(input);
      return validGrant(input, grant) ? grant : undefined;
    } catch { return undefined; }
  }

  private async tenantIdentityConfirmed(scope: AuthorizedTenantScope): Promise<boolean> {
    try { return await this.tenantIdentity.isConfirmed(scope); } catch { return false; }
  }

  private async readReplayScope(tenantId: string, deadLetterId: string): Promise<string | undefined> {
    const database = await this.database.getDataSource();
    const rows = await database.query(
      `SELECT job.resource_scope_ref FROM ca_meta_job_dead_letters dead_letter
       INNER JOIN ca_meta_jobs job ON job.tenant_id = dead_letter.tenant_id AND job.id = dead_letter.job_id
       WHERE dead_letter.tenant_id = ? AND dead_letter.id = ? LIMIT 1`, [tenantId, deadLetterId],
    ) as Array<{ resource_scope_ref?: unknown }>;
    const scopeRef = rows[0]?.resource_scope_ref;
    return typeof scopeRef === 'string' && OPAQUE_REF.test(scopeRef) ? scopeRef : undefined;
  }

  private async recordTenantAction(scope: AuthorizedTenantScope, actorRef: string, targetRef: string,
    action: OperationsActionName, reasonCode: OperationsReasonCode, requestId: string): Promise<void> {
    if (!this.audit) throw new OperationsActionUnavailableError('AUDIT_UNAVAILABLE');
    await this.audit.record({ tenantId: scope.tenantId, actorRef, action: 'ASSET_OPERATION', targetRef,
      correlationId: requestId, retentionClass: 'OPERATIONS', safeDiff: { status: action, reasonCode } });
  }

  private async recordSupportAction(scope: AuthorizedTenantScope, actorRef: string, targetRef: string,
    action: OperationsActionName, reasonCode: OperationsReasonCode, requestId: string): Promise<void> {
    if (!this.audit) throw new OperationsActionUnavailableError('AUDIT_UNAVAILABLE');
    await this.audit.record({ tenantId: scope.tenantId, actorRef, action: 'SUPPORT_DIAGNOSTIC_ACCESS', targetRef,
      correlationId: requestId, retentionClass: 'SUPPORT', safeDiff: { status: action, reasonCode } });
  }

  private result(action: OperationsActionName, outcome: OperationsActionResult['outcome'], reasonCode: string,
    requestId: string, operationRef: string | null = null): OperationsActionResult {
    return Object.freeze({ action, outcome, reasonCode, requestId, operationRef });
  }
}
