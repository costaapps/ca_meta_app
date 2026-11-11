import { createHash } from 'node:crypto';
import type { DurableWorkDatabase } from './durable-work-database.js';
import type { ClaimedJob } from './job-store.js';
import { canonicalJson, parseJobPayload, type JobPayload, type JobType } from './event-validation.js';
import { IdentityDeniedError } from '../identity/identity.errors.js';
import type { ServiceTenantAuthorizationService } from '../identity/identity.service.js';
import type { ServiceScope, VerifiedServiceTenantScope } from '../identity/identity.types.js';
import type { VerifiedWorkerServiceIdentity } from '../identity/identity.trust.js';

declare const verifiedJobExecutionBrand: unique symbol;
const verifiedJobExecutions = new WeakSet<object>();

export interface VerifiedJobExecutionContext {
  readonly [verifiedJobExecutionBrand]: true;
  readonly jobId: string;
  readonly tenantId: string;
  readonly principalId: string;
  /** The payload's tenant-owned target, never the caller-selected scheduling key. */
  readonly resourceRef: string;
  readonly serviceScope: VerifiedServiceTenantScope;
}

export function isVerifiedJobExecutionContext(value: unknown): value is VerifiedJobExecutionContext {
  return typeof value === 'object' && value !== null && verifiedJobExecutions.has(value);
}

export interface JobExecutionAuthorizationPort {
  /** Returns an opaque context only after reloading the active claim, service grant, and target resource. */
  authorize(job: ClaimedJob): Promise<VerifiedJobExecutionContext | undefined>;
}

/** Default for an intentionally idle worker with no installed handlers. */
export class FailClosedJobExecutionAuthorizationPort implements JobExecutionAuthorizationPort {
  async authorize(): Promise<undefined> { return undefined; }
}

interface ActiveJobRow {
  id: string;
  tenant_id: string;
  job_type: string;
  lane: string;
  effect_mode: string;
  resource_scope_ref: string;
  correlation_id: string;
  causation_id: string | null;
  payload_hash: string;
  attempt: number | string;
  max_attempts: number | string;
}

interface OnboardingResourceRow {
  steps_json: string | Buffer | unknown;
}

const REQUIRED_JOB_SCOPES: Readonly<Partial<Record<JobType, ServiceScope>>> = Object.freeze({
  INBOX_PROCESS: 'WEBHOOK_ROUTE',
  ONBOARDING_STEP: 'META_CONNECTION_EXECUTE',
  PROJECTION_RECONCILE: 'TENANT_RESOURCE_READ',
  HISTORY_SYNC: 'TENANT_RESOURCE_READ',
  CREDENTIAL_INSPECTION: 'CREDENTIAL_USE',
  ASSET_REFRESH: 'META_CONNECTION_EXECUTE',
  TEMPLATE_CREATE: 'CREDENTIAL_USE',
  NOTIFICATION_ACTION: 'CREDENTIAL_USE',
} as const satisfies Readonly<Partial<Record<JobType, ServiceScope>>>);

function resourceReference(type: JobType, payload: JobPayload): string | undefined {
  if (type !== payload.kind) return undefined;
  switch (payload.kind) {
    case 'INBOX_PROCESS': return payload.inboxEventRef;
    case 'OUTBOX_DELIVER': return payload.outboxEventRef;
    case 'ONBOARDING_STEP': return payload.onboardingRef;
    case 'PROJECTION_RECONCILE': return payload.projectionRef;
    case 'HISTORY_SYNC': return undefined;
    case 'CREDENTIAL_INSPECTION': return payload.credentialId;
    case 'ASSET_REFRESH': return payload.assetId;
    case 'TEMPLATE_CREATE': return payload.assetId;
    case 'NOTIFICATION_ACTION': return payload.notificationId;
  }
}

function parseJson(value: string | Buffer | unknown): unknown {
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8')) as unknown;
  if (typeof value === 'string') return JSON.parse(value) as unknown;
  return value;
}

function onboardingStepExists(value: string | Buffer | unknown, stepRef: string): boolean {
  let steps: unknown;
  try {
    steps = parseJson(value);
  } catch {
    return false;
  }
  if (!Array.isArray(steps)) return false;
  return steps.some((step: unknown) => {
    if (typeof step !== 'object' || step === null || Array.isArray(step)) return false;
    const id = Reflect.get(step, 'id');
    const name = Reflect.get(step, 'name');
    return id === stepRef || name === stepRef;
  });
}

/** M3.01/M3.08 boundary for a worker with a verified SERVICE principal. */
export class MysqlJobExecutionAuthorizationPort implements JobExecutionAuthorizationPort {
  constructor(
    private readonly database: DurableWorkDatabase,
    private readonly services: ServiceTenantAuthorizationService,
    private readonly identity: VerifiedWorkerServiceIdentity,
  ) {}

  async authorize(job: ClaimedJob): Promise<VerifiedJobExecutionContext | undefined> {
    if (!job || typeof job.id !== 'string' || typeof job.claimToken !== 'string' ||
        typeof job.workerRef !== 'string' || !job.resourceScopeRef ||
        !Object.hasOwn(REQUIRED_JOB_SCOPES, job.type)) return undefined;

    const database = await this.database.getDataSource();
    const rows = await database.query(
      `SELECT id, tenant_id, job_type, lane, effect_mode, resource_scope_ref,
              correlation_id, causation_id, HEX(payload_hash) AS payload_hash,
              attempt, max_attempts
       FROM ca_meta_jobs
       WHERE id = ? AND claim_token = ? AND lease_owner = ? AND status = 'RUNNING'
         AND lease_expires_at > UTC_TIMESTAMP(6)
       LIMIT 1`,
      [job.id, job.claimToken, job.workerRef],
    ) as ActiveJobRow[];
    const row = rows[0];
    if (!row ||
        row.id !== job.id || row.tenant_id !== job.tenantId || row.job_type !== job.type ||
        row.lane !== job.lane || row.effect_mode !== job.effectMode ||
        row.resource_scope_ref !== job.resourceScopeRef || row.correlation_id !== job.correlationId ||
        row.causation_id !== job.causationId || Number(row.attempt) !== job.attempt ||
        Number(row.max_attempts) !== job.maxAttempts) return undefined;

    let payload: JobPayload;
    try {
      payload = parseJobPayload(job.type, job.payload);
      const expectedHash = createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
      if (row.payload_hash.toLowerCase() !== expectedHash) return undefined;
    } catch {
      return undefined;
    }

    const resourceRef = resourceReference(job.type, payload);
    if (!resourceRef || !(await this.resourceBelongsToTenant(database, row.tenant_id, job.type, payload))) return undefined;

    let scope: VerifiedServiceTenantScope;
    try {
      scope = await this.services.resolveJobScope(this.identity, row.tenant_id);
      const requiredScope = REQUIRED_JOB_SCOPES[job.type];
      if (!requiredScope) return undefined;
      await this.services.authorize(scope, requiredScope, row.tenant_id);
    } catch (error) {
      if (error instanceof IdentityDeniedError) return undefined;
      throw error;
    }

    // Re-fence after resource/grant lookups so a slow authorization pass cannot outlive the claim lease.
    const currentClaim = await database.query(
      `SELECT id FROM ca_meta_jobs
       WHERE id = ? AND tenant_id = ? AND job_type = ? AND resource_scope_ref = ?
         AND claim_token = ? AND lease_owner = ? AND status = 'RUNNING'
         AND lease_expires_at > UTC_TIMESTAMP(6)
       LIMIT 1`,
      [row.id, row.tenant_id, row.job_type, row.resource_scope_ref, job.claimToken, job.workerRef],
    ) as Array<{ id: string }>;
    if (currentClaim.length !== 1) return undefined;

    const result = Object.freeze({
      jobId: row.id,
      tenantId: row.tenant_id,
      principalId: scope.principalId,
      resourceRef,
      serviceScope: scope,
    }) as VerifiedJobExecutionContext;
    verifiedJobExecutions.add(result);
    return result;
  }

  private async resourceBelongsToTenant(
    database: Awaited<ReturnType<DurableWorkDatabase['getDataSource']>>,
    tenantId: string,
    type: JobType,
    payload: JobPayload,
  ): Promise<boolean> {
    if (type !== payload.kind) return false;
    switch (payload.kind) {
      case 'INBOX_PROCESS': {
        const rows = await database.query(
          `SELECT id FROM ca_meta_inbox_events
           WHERE id = ? AND tenant_id = ? AND routing_state = 'ROUTED'
             AND processing_state IN ('PENDING', 'RUNNING')
           LIMIT 1`,
          [payload.inboxEventRef, tenantId],
        ) as Array<{ id: string }>;
        return rows.length === 1;
      }
      case 'OUTBOX_DELIVER': {
        // Event types have no reviewed mapping from delivery effect to a narrow service scope yet.
        // A tenant-owned outbox row alone cannot authorize its delivery.
        return false;
      }
      case 'ONBOARDING_STEP': {
        const rows = await database.query(
          `SELECT onboarding.steps_json
           FROM ca_meta_onboarding_sessions AS onboarding
           INNER JOIN ca_meta_memberships AS m ON m.tenant_id = onboarding.tenant_id
             AND m.principal_id = onboarding.principal_id AND m.principal_kind = 'USER' AND m.status = 'ACTIVE'
           INNER JOIN ca_meta_principals AS p ON p.id = onboarding.principal_id
             AND p.kind = 'USER' AND p.status = 'ACTIVE'
           INNER JOIN ca_meta_tenants AS t ON t.id = onboarding.tenant_id AND t.status = 'ACTIVE'
           WHERE onboarding.id = ? AND onboarding.tenant_id = ?
             AND onboarding.status IN ('AWAITING_PROVIDER', 'CODE_RECEIVED', 'EXCHANGING', 'ASSETS_VERIFIED', 'PROVISIONING', 'PARTIAL')
             AND onboarding.expires_at > UTC_TIMESTAMP(6)
             AND (JSON_CONTAINS(m.roles, JSON_QUOTE('owner'))
               OR JSON_CONTAINS(m.roles, JSON_QUOTE('admin'))
               OR JSON_CONTAINS(m.roles, JSON_QUOTE('operator')))
           LIMIT 1`,
          [payload.onboardingRef, tenantId],
        ) as OnboardingResourceRow[];
        // The session's persisted tenant/principal stay authoritative across tenant switches; a revoked CONNECT role blocks the next provider step.
        return !!rows[0] && onboardingStepExists(rows[0].steps_json, payload.stepRef);
      }
      case 'PROJECTION_RECONCILE': {
        const rows = await database.query(
          `SELECT id FROM ca_meta_outbox_events
           WHERE id = ? AND tenant_id = ? AND aggregate_version = ?
             AND event_type IN ('connection.changed', 'automation.config.changed')
           LIMIT 1`,
          [payload.projectionRef, tenantId, payload.sourceVersion],
        ) as Array<{ id: string }>;
        return rows.length === 1;
      }
      case 'HISTORY_SYNC':
        // Historical sync refs currently have no tenant-owned resource table or producer.
        return false;
      case 'CREDENTIAL_INSPECTION': {
        const rows = await database.query(
          `SELECT c.id
           FROM ca_meta_credentials c
           JOIN ca_meta_credential_secrets s ON s.tenant_id = c.tenant_id
             AND s.credential_id = c.id AND s.authorization_id = c.authorization_id
             AND s.app_configuration_id = c.app_configuration_id AND s.provider = c.provider AND s.environment = c.environment
           JOIN ca_meta_credential_lifecycle l ON l.tenant_id = c.tenant_id AND l.credential_id = c.id
             AND l.authorization_id = c.authorization_id AND l.app_configuration_id = c.app_configuration_id
             AND l.provider = c.provider AND l.environment = c.environment
           JOIN ca_meta_authorizations auth ON auth.tenant_id = c.tenant_id AND auth.id = c.authorization_id
             AND auth.app_configuration_id = c.app_configuration_id AND auth.provider = c.provider
             AND auth.environment = c.environment AND auth.authorization_state IN ('ACTIVE', 'PARTIAL')
           WHERE c.tenant_id = ? AND c.id = ? AND c.authorization_id = ? AND c.app_configuration_id = ?
             AND c.provider = ? AND c.environment = ? AND c.family = ? AND c.status = 'ACTIVE'
             AND c.version = ? AND s.version = ? AND auth.version = ?
             AND auth.flow_variant = ? AND auth.auth_variant = ?
             AND l.version = ? AND l.schedule_generation = ? AND l.lease_owner = ? AND l.lease_token = ?
             AND l.lease_expires_at > UTC_TIMESTAMP(6)
           LIMIT 1`,
          [tenantId, payload.credentialId, payload.authorizationId, payload.appConfigurationId,
            payload.provider, payload.environment, payload.family, payload.credentialVersion, payload.secretVersion,
            payload.authorizationVersion, payload.flowVariant, payload.authVariant, payload.lifecycleVersion,
            payload.generation, payload.leaseOwner, payload.leaseToken],
        ) as Array<{ id: string }>;
        return rows.length === 1;
      }
      case 'ASSET_REFRESH': {
        const rows = await database.query(
          `SELECT a.id
           FROM ca_meta_assets AS a
           INNER JOIN ca_meta_asset_authorizations AS aa ON aa.tenant_id = a.tenant_id AND aa.asset_id = a.id
             AND aa.app_configuration_id = a.app_configuration_id AND aa.provider = a.provider AND aa.environment = a.environment
           INNER JOIN ca_meta_authorizations AS auth ON auth.tenant_id = aa.tenant_id AND auth.id = aa.authorization_id
             AND auth.app_configuration_id = aa.app_configuration_id AND auth.provider = aa.provider AND auth.environment = aa.environment
           WHERE a.tenant_id = ? AND a.id = ? AND a.app_configuration_id = ?
             AND a.environment = ? AND a.provider = 'META'
             AND aa.state = 'ACTIVE' AND aa.verification_state = 'VERIFIED'
             AND auth.authorization_state IN ('ACTIVE', 'PARTIAL')
           LIMIT 1`,
          [tenantId, payload.assetId, payload.appConfigurationId, payload.environment],
        ) as Array<{ id: string }>;
        // Match the current usable-authorization states required by the M3.08 credential resolver.
        return rows.length === 1;
      }
      case 'TEMPLATE_CREATE': {
        const rows = await database.query(
          `SELECT a.id
           FROM ca_meta_assets AS a
           INNER JOIN ca_meta_asset_authorizations AS aa ON aa.tenant_id = a.tenant_id AND aa.asset_id = a.id
             AND aa.app_configuration_id = a.app_configuration_id AND aa.provider = a.provider AND aa.environment = a.environment
           INNER JOIN ca_meta_authorizations AS auth ON auth.tenant_id = aa.tenant_id AND auth.id = aa.authorization_id
             AND auth.app_configuration_id = aa.app_configuration_id AND auth.provider = aa.provider AND auth.environment = aa.environment
           INNER JOIN ca_meta_asset_grants AS g ON g.tenant_id = aa.tenant_id AND g.authorization_id = aa.authorization_id
             AND g.asset_id = aa.asset_id AND g.app_configuration_id = aa.app_configuration_id
             AND g.provider = aa.provider AND g.environment = aa.environment
           WHERE a.tenant_id = ? AND a.id = ? AND a.app_configuration_id = ? AND a.environment = ?
             AND a.provider = 'META' AND a.asset_kind = 'WHATSAPP_BUSINESS_ACCOUNT'
             AND aa.state = 'ACTIVE' AND aa.verification_state = 'VERIFIED'
             AND auth.authorization_state IN ('ACTIVE', 'PARTIAL')
             AND auth.flow_variant = 'WHATSAPP_EXCLUSIVE' AND auth.auth_variant = 'WHATSAPP_EMBEDDED_SIGNUP'
             AND g.grant_name = 'whatsapp_business_management' AND g.status = 'GRANTED'
           LIMIT 1`,
          [tenantId, payload.assetId, payload.appConfigurationId, payload.environment],
        ) as Array<{ id: string }>;
        // The operation grant name is a candidate only; real Meta eligibility remains a release gate.
        return rows.length === 1;
      }
      case 'NOTIFICATION_ACTION': {
        const isCommentReply = payload.request.action === 'REPLY_COMMENT';
        const compatibleAssetKinds = isCommentReply
          ? ['FACEBOOK_PAGE', 'INSTAGRAM_BUSINESS_ACCOUNT', 'INSTAGRAM_CREATOR_ACCOUNT']
          : ['WHATSAPP_PHONE_NUMBER'];
        const kindPredicate = isCommentReply ? "n.kind = 'COMMENT_RECEIVED'" : '1 = 1';
        const rows = await database.query(
          `SELECT n.id
           FROM ca_meta_notifications n
           JOIN ca_meta_assets a ON a.tenant_id = n.tenant_id AND a.id = n.asset_id
           WHERE n.tenant_id = ? AND n.id = ? AND n.asset_id = ?
             AND a.app_configuration_id = ? AND a.environment = ? AND a.provider = 'META'
             AND n.status = 'UNREAD' AND a.asset_kind IN (${compatibleAssetKinds.map(() => '?').join(',')})
             AND ${kindPredicate}
           LIMIT 1`,
          [tenantId, payload.notificationId, payload.assetId, payload.appConfigurationId, payload.environment,
            ...compatibleAssetKinds],
        ) as Array<{ id: string }>;
        return rows.length === 1;
      }
    }
  }
}
