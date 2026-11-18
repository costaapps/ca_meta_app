import { IdentityDeniedError } from '../identity/identity.errors.js';
import { isAuthorizedTenantScope, TenantAuthorizationService } from '../identity/identity.service.js';
import type { AuthorizedTenantScope } from '../identity/identity.types.js';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';

export type DiagnosticState = 'HEALTHY' | 'ACTION_REQUIRED' | 'PENDING' | 'FAILED' | 'UNKNOWN';

export interface DiagnosticSection {
  readonly state: DiagnosticState;
  readonly reasonCode: string | null;
  readonly observedAt: string | null;
}

export interface OperationsDiagnostics {
  readonly requestId: string;
  readonly generatedAt: string;
  readonly versions: { readonly contract: '1.0.0-proposed'; readonly readModel: 1 };
  readonly onboarding: DiagnosticSection & { readonly nextAction: string | null };
  readonly credentialHealth: DiagnosticSection;
  readonly grants: DiagnosticSection & { readonly grantedCount: number | null; readonly revokedCount: number | null };
  readonly subscription: DiagnosticSection;
  readonly webhook: DiagnosticSection;
  readonly jobs: DiagnosticSection & { readonly counts: Readonly<Record<string, number>> };
  readonly projection: DiagnosticSection & { readonly pendingCount: number | null; readonly failedCount: number | null; readonly lagSeconds: null };
  readonly nextAction: 'REQUEST_REAUTHORIZATION' | 'WAIT_FOR_PROCESSING' | 'CONTACT_SUPPORT' | 'REVIEW_SYNC' | 'CHECK_CONNECTION' | 'NO_ACTION' | 'UNKNOWN';
}

export interface OperationsDiagnosticsRepository {
  readOnboarding(tenantId: string): Promise<{ readonly status: string; readonly readiness: string; readonly nextAction: string; readonly observedAt: unknown } | undefined>;
  readCredentialHealth(tenantId: string): Promise<{ readonly state: string; readonly credentialStatus: string; readonly reasonCode: string | null; readonly observedAt: unknown } | undefined>;
  readGrantCounts(tenantId: string): Promise<{ readonly totalCount: number; readonly grantedCount: number; readonly revokedCount: number } | undefined>;
  readSubscription(tenantId: string): Promise<{ readonly state: string; readonly observedState: string; readonly reasonCode: string | null; readonly observedAt: unknown } | undefined>;
  readWebhook(tenantId: string): Promise<{ readonly state: string; readonly reasonCode: string | null; readonly observedAt: unknown } | undefined>;
  readJobCounts(tenantId: string): Promise<Readonly<Record<string, number>>>;
  readProjectionCounts(tenantId: string): Promise<{ readonly pendingCount: number; readonly failedCount: number } | undefined>;
}

interface Row {
  readonly status?: unknown;
  readonly readiness?: unknown;
  readonly next_action?: unknown;
  readonly state?: unknown;
  readonly credential_status?: unknown;
  readonly observed_state?: unknown;
  readonly reason_code?: unknown;
  readonly observed_at?: unknown;
  readonly granted_count?: unknown;
  readonly revoked_count?: unknown;
  readonly total_count?: unknown;
  readonly job_status?: unknown;
  readonly count?: unknown;
}

function safeCount(value: unknown): number {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function safeCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64 || !/^[A-Z0-9_]+$/.test(value) ||
      /TOKEN|SECRET|PASSWORD|MESSAGE|PAYLOAD|PHONE|EMAIL|GRAPH|URL/.test(value)) return null;
  return value;
}

function isoTime(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function state(value: unknown): DiagnosticState {
  switch (value) {
    case 'HEALTHY': case 'ACTIVE': case 'SYNCED': case 'PROCESSED': case 'READY': return 'HEALTHY';
    case 'ACTION_REQUIRED': case 'REAUTH_REQUIRED': case 'REVOKED': case 'MANUAL_ACTION_REQUIRED':
    case 'EXPIRING': case 'EXPIRED': return 'ACTION_REQUIRED';
    case 'PENDING': case 'QUEUED': case 'RUNNING': case 'RETRY_PENDING': case 'PARTIAL':
    case 'RECEIVED': case 'VERIFIED': case 'ROUTED': return 'PENDING';
    case 'FAILED': case 'DEAD_LETTER': case 'REJECTED': return 'FAILED';
    default: return 'UNKNOWN';
  }
}

function section(value: unknown, reasonCode?: unknown, observedAt?: unknown): DiagnosticSection {
  return Object.freeze({ state: state(value), reasonCode: safeCode(reasonCode), observedAt: isoTime(observedAt) });
}

function safeOnboardingAction(value: unknown): string | null {
  switch (value) {
    case 'WAIT': return 'WAIT_FOR_PROCESSING';
    case 'CHECK_STATUS': case 'RECONCILE': return 'REVIEW_STATUS';
    case 'REAUTHORIZE': return 'REQUEST_REAUTHORIZATION';
    case 'RESUME': return 'RESUME_SETUP';
    case 'RESOLVE_CONFLICT': return 'CONTACT_SUPPORT';
    case 'NONE': return 'NO_ACTION';
    default: return null;
  }
}

/** Reads only tenant-owned allowlisted metadata. Secrets, payloads and provider IDs never enter this DTO. */
export class MysqlOperationsDiagnosticsRepository implements OperationsDiagnosticsRepository {
  constructor(private readonly database: DurableWorkDatabase) {}

  async readOnboarding(tenantId: string) {
    const db = await this.database.getDataSource();
    const rows = await db.query(
      `SELECT status, readiness, next_action, last_updated_at AS observed_at
       FROM ca_meta_onboarding_sessions WHERE tenant_id = ?
       ORDER BY last_updated_at DESC, id LIMIT 1`, [tenantId],
    ) as Row[];
    const row = rows[0];
    return row ? { status: String(row.status ?? 'UNKNOWN'), readiness: String(row.readiness ?? 'UNKNOWN'),
      nextAction: String(row.next_action ?? 'UNKNOWN'), observedAt: row.observed_at } : undefined;
  }

  async readCredentialHealth(tenantId: string) {
    const db = await this.database.getDataSource();
    const rows = await db.query(
      `SELECT lifecycle.health_state AS state, credential.status AS credential_status,
              lifecycle.last_safe_reason_code AS reason_code,
              lifecycle.last_checked_at AS observed_at
       FROM ca_meta_credentials credential
       INNER JOIN ca_meta_credential_lifecycle lifecycle
         ON lifecycle.tenant_id = credential.tenant_id AND lifecycle.credential_id = credential.id
       WHERE credential.tenant_id = ?
       ORDER BY COALESCE(lifecycle.last_checked_at, lifecycle.updated_at) DESC, credential.id LIMIT 1`, [tenantId],
    ) as Row[];
    const row = rows[0];
    return row ? { state: String(row.state ?? 'UNKNOWN'), credentialStatus: String(row.credential_status ?? 'UNKNOWN'),
      reasonCode: safeCode(row.reason_code), observedAt: row.observed_at } : undefined;
  }

  async readGrantCounts(tenantId: string) {
    const db = await this.database.getDataSource();
    const rows = await db.query(
      `SELECT COUNT(*) AS total_count,
              SUM(CASE WHEN status = 'GRANTED' THEN 1 ELSE 0 END) AS granted_count,
              SUM(CASE WHEN status = 'REVOKED' THEN 1 ELSE 0 END) AS revoked_count
       FROM ca_meta_authorization_scopes WHERE tenant_id = ?`, [tenantId],
    ) as Row[];
    const row = rows[0];
    return row ? { totalCount: safeCount(row.total_count), grantedCount: safeCount(row.granted_count),
      revokedCount: safeCount(row.revoked_count) } : undefined;
  }

  async readSubscription(tenantId: string) {
    const db = await this.database.getDataSource();
    const rows = await db.query(
      `SELECT reconcile_state AS state, observed_state, last_safe_reason_code AS reason_code,
              last_verified_at AS observed_at
       FROM ca_meta_subscription_targets WHERE tenant_id = ?
       ORDER BY updated_at DESC, id LIMIT 1`, [tenantId],
    ) as Row[];
    const row = rows[0];
    return row ? { state: String(row.state ?? 'UNKNOWN'), observedState: String(row.observed_state ?? 'UNKNOWN'),
      reasonCode: safeCode(row.reason_code), observedAt: row.observed_at } : undefined;
  }

  async readWebhook(tenantId: string) {
    const db = await this.database.getDataSource();
    const rows = await db.query(
      `SELECT process_state AS state, last_error_code AS reason_code, received_at AS observed_at
       FROM ca_meta_webhook_events WHERE tenant_id = ? AND route_state = 'ROUTED'
       ORDER BY received_at DESC, id LIMIT 1`, [tenantId],
    ) as Row[];
    const row = rows[0];
    return row ? { state: String(row.state ?? 'UNKNOWN'), reasonCode: safeCode(row.reason_code), observedAt: row.observed_at } : undefined;
  }

  async readJobCounts(tenantId: string): Promise<Readonly<Record<string, number>>> {
    const db = await this.database.getDataSource();
    const rows = await db.query(
      `SELECT status AS job_status, COUNT(*) AS count FROM ca_meta_jobs
       WHERE tenant_id = ? GROUP BY status`, [tenantId],
    ) as Row[];
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const statusName = typeof row.job_status === 'string' && /^[A-Z_]{1,24}$/.test(row.job_status) ? row.job_status : 'UNKNOWN';
      counts[statusName] = safeCount(row.count);
    }
    return Object.freeze(counts);
  }

  async readProjectionCounts(tenantId: string) {
    const db = await this.database.getDataSource();
    const rows = await db.query(
      `SELECT state, COUNT(*) AS count FROM ca_meta_legacy_projection_checkpoints
       WHERE tenant_id = ? GROUP BY state`, [tenantId],
    ) as Row[];
    if (!rows.length) return { pendingCount: 0, failedCount: 0 };
    let pendingCount = 0;
    let failedCount = 0;
    for (const row of rows) {
      if (row.state === 'PENDING') pendingCount = safeCount(row.count);
      if (row.state === 'FAILED') failedCount = safeCount(row.count);
    }
    return { pendingCount, failedCount };
  }
}

export class OperationsDiagnosticsService {
  constructor(private readonly repository: OperationsDiagnosticsRepository, private readonly authorization: TenantAuthorizationService,
    private readonly now: () => Date = () => new Date()) {}

  async read(scope: AuthorizedTenantScope, requestId: string): Promise<OperationsDiagnostics> {
    if (!isAuthorizedTenantScope(scope) || !/^[a-f0-9-]{36}$/i.test(requestId)) throw new IdentityDeniedError();
    await this.authorization.authorize(scope, 'RESOURCE_READ', scope.tenantId);

    const safeRead = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
      try { return await read(); } catch { return undefined; }
    };
    const [onboarding, credential, grants, subscription, webhook, jobCounts, projection] = await Promise.all([
      safeRead(() => this.repository.readOnboarding(scope.tenantId)),
      safeRead(() => this.repository.readCredentialHealth(scope.tenantId)),
      safeRead(() => this.repository.readGrantCounts(scope.tenantId)),
      safeRead(() => this.repository.readSubscription(scope.tenantId)),
      safeRead(() => this.repository.readWebhook(scope.tenantId)),
      safeRead(() => this.repository.readJobCounts(scope.tenantId)),
      safeRead(() => this.repository.readProjectionCounts(scope.tenantId)),
    ]);

    const onboardingState = !onboarding ? 'UNKNOWN'
      : onboarding.status === 'READY' ? onboarding.readiness === 'READY' ? 'READY' : 'UNKNOWN'
        : onboarding.status;
    const onboardingSection = section(onboardingState,
      undefined, onboarding?.observedAt);
    const credentialState = credential?.credentialStatus === 'REAUTH_REQUIRED' || credential?.credentialStatus === 'REVOKED'
      ? credential.credentialStatus : credential?.state;
    const credentialSection = section(credentialState, credential?.reasonCode, credential?.observedAt);
    const grantState = !grants || grants.totalCount === 0 ? 'UNKNOWN'
      : grants.grantedCount > 0 ? 'HEALTHY' : grants.revokedCount > 0 ? 'ACTION_REQUIRED' : 'UNKNOWN';
    const grantsSection = Object.freeze({ ...section(grantState, grants?.totalCount === 0 ? 'NO_GRANTS_RECORDED' : undefined),
      grantedCount: grants?.grantedCount ?? null, revokedCount: grants?.revokedCount ?? null });
    const subscriptionState = !subscription ? 'UNKNOWN'
      : subscription.state === 'ACTIVE' && subscription.observedState === 'SUBSCRIBED' ? 'HEALTHY'
        : subscription.state === 'MANUAL_ACTION_REQUIRED' || subscription.observedState === 'UNSUBSCRIBED' ? 'ACTION_REQUIRED'
          : subscription.state === 'ACTIVE' || subscription.state === 'PARTIAL' || subscription.state === 'PENDING' ? 'PENDING'
            : subscription.observedState === 'UNKNOWN' ? 'UNKNOWN' : subscription.state;
    const subscriptionSection = section(subscriptionState, subscription?.reasonCode, subscription?.observedAt);
    const webhookSection = section(webhook?.state, webhook?.reasonCode, webhook?.observedAt);
    const normalizedJobs: Record<string, number> = {};
    for (const [key, count] of Object.entries(jobCounts ?? {})) {
      if (/^[A-Z_]{1,24}$/.test(key)) normalizedJobs[key] = safeCount(count);
    }
    const activeJobs = (normalizedJobs['QUEUED'] ?? 0) + (normalizedJobs['RUNNING'] ?? 0) + (normalizedJobs['RETRY_PENDING'] ?? 0);
    const failedJobs = (normalizedJobs['FAILED'] ?? 0) + (normalizedJobs['DEAD_LETTER'] ?? 0) + (normalizedJobs['UNKNOWN'] ?? 0);
    const jobsSection = Object.freeze({ ...section(failedJobs > 0 ? 'FAILED' : activeJobs > 0 ? 'PENDING' : jobCounts ? 'HEALTHY' : undefined),
      counts: Object.freeze(normalizedJobs) });
    // M5.08 intentionally has no configured consumer runtime yet; counts are evidence of backlog only.
    const projectionSection = Object.freeze({ ...section('UNKNOWN', 'PROJECTION_RUNTIME_NOT_CONFIGURED'),
      pendingCount: projection?.pendingCount ?? null, failedCount: projection?.failedCount ?? null, lagSeconds: null as null });

    const nextAction = onboardingSection.state === 'ACTION_REQUIRED' || credentialSection.state === 'ACTION_REQUIRED' || grantsSection.state === 'ACTION_REQUIRED'
      ? 'REQUEST_REAUTHORIZATION'
      : failedJobs > 0 || [onboardingSection, credentialSection, webhookSection].some((item) => item.state === 'FAILED')
        ? 'CONTACT_SUPPORT'
        : subscriptionSection.state === 'ACTION_REQUIRED' ||
          (projectionSection.pendingCount !== null && (projectionSection.pendingCount > 0 || (projectionSection.failedCount ?? 0) > 0))
          ? 'REVIEW_SYNC'
          : activeJobs > 0 ? 'WAIT_FOR_PROCESSING'
            : [onboardingSection, credentialSection, grantsSection, subscriptionSection, webhookSection, jobsSection, projectionSection]
              .some((item) => item.state === 'UNKNOWN')
              ? 'CHECK_CONNECTION' : 'NO_ACTION';

    return Object.freeze({ requestId, generatedAt: this.now().toISOString(),
      versions: Object.freeze({ contract: '1.0.0-proposed', readModel: 1 as const }),
      onboarding: Object.freeze({ ...onboardingSection, nextAction: safeOnboardingAction(onboarding?.nextAction) }),
      credentialHealth: credentialSection, grants: grantsSection, subscription: subscriptionSection,
      webhook: webhookSection, jobs: jobsSection, projection: projectionSection, nextAction });
  }
}
