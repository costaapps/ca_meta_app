import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { DurableJobStore, ClaimedJob, JobFinalization, JobOutcome } from '../jobs/job-store.js';
import type { JobHandler, JobFinalizer } from '../worker/durable-worker.js';
import type { JobPayload } from '../jobs/event-validation.js';
import type { CredentialBinding } from './credential-vault.types.js';
import type { MetaAuthVariant, MetaFlowVariant } from './credential-resolver.types.js';
import type {
  CredentialInspectionBinding, CredentialInspectionObservation, CredentialInspectionPort,
  CredentialLifecycleFamilyPolicy, CredentialLifecyclePolicyPort, CredentialLifecycleSecretPort, CredentialRenewalPort,
} from './credential-lifecycle.types.js';

const MAX_SCHEDULE_BATCH = 50;
const MAX_SCHEDULE_BUDGET_MS = 5_000;
const SCHEDULER_LEASE_SECONDS = 120;
const SAFE_REASONS = new Set(['NONE', 'TOKEN_EXPIRED', 'ACCESS_EXPIRED', 'PERMISSION_REVOKED', 'REAUTH_REQUIRED']);
const HEALTH_STATES = new Set(['VALID', 'HEALTHY', 'EXPIRING', 'EXPIRED', 'REVOKED', 'ACTION_REQUIRED']);
const EXPIRY_STATES = new Set(['KNOWN', 'PROVIDER_NO_EXPIRY', 'UNKNOWN']);

interface DueCredentialRow {
  tenant_id: string; credential_id: string; authorization_id: string; app_configuration_id: string;
  provider: string; environment: string; flow_variant: MetaFlowVariant | null; auth_variant: MetaAuthVariant | null; family: string;
  credential_version: number | string; secret_version: number | string; authorization_version: number | string;
  lifecycle_version: number | string;
  generation: number | string;
}

interface InspectionResult {
  readonly kind: 'OBSERVED' | 'TRANSIENT' | 'FENCED';
  readonly observation?: CredentialInspectionObservation;
  readonly reauthIntent?: boolean;
  readonly reauthImpactKey?: string | null;
  readonly cadenceSeconds?: number;
  readonly jitterPercent?: number;
}

function affectedRows(result: unknown): number {
  if (Array.isArray(result)) return result.length === 0 ? 0 : affectedRows(result[0]);
  if (typeof result === 'object' && result !== null && 'affectedRows' in result) {
    return Number((result as { affectedRows?: number }).affectedRows ?? 0);
  }
  return 0;
}

function version(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('invalid-lifecycle-version');
  return parsed;
}

function counter(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('invalid-lifecycle-counter');
  return parsed;
}

function validUtc(value: string | null): value is string {
  return value !== null && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function validateObservation(value: CredentialInspectionObservation): CredentialInspectionObservation | undefined {
  if (!value || !HEALTH_STATES.has(value.health) || !EXPIRY_STATES.has(value.expiryState) || !SAFE_REASONS.has(value.reasonCode) ||
      (value.issuedAt !== null && !validUtc(value.issuedAt)) ||
      (value.expiryState === 'KNOWN' ? !validUtc(value.expiresAt) : value.expiresAt !== null) ||
      (value.dataAccessExpiresAt !== null && !validUtc(value.dataAccessExpiresAt))) return undefined;
  return Object.freeze({
    health: value.health === 'VALID' ? 'HEALTHY' : value.health,
    issuedAt: value.issuedAt,
    expiryState: value.expiryState,
    expiresAt: value.expiresAt,
    dataAccessExpiresAt: value.dataAccessExpiresAt,
    reasonCode: value.reasonCode,
  });
}

const FLOW_AUTH_VARIANTS: Readonly<Record<MetaFlowVariant, readonly MetaAuthVariant[]>> = {
  FACEBOOK: ['FACEBOOK_LOGIN_FOR_BUSINESS'],
  INSTAGRAM: ['FACEBOOK_LOGIN_FOR_BUSINESS', 'INSTAGRAM_LOGIN'],
  WHATSAPP_EXCLUSIVE: ['WHATSAPP_EMBEDDED_SIGNUP'],
  WHATSAPP_COEXISTENCE: ['WHATSAPP_BUSINESS_APP_ONBOARDING'],
};

function validFlowAuthVariant(flow: MetaFlowVariant | null, auth: MetaAuthVariant | null): boolean {
  return flow !== null && auth !== null && FLOW_AUTH_VARIANTS[flow]?.includes(auth) === true;
}

function validPolicy(policy: CredentialLifecycleFamilyPolicy | undefined, flow: MetaFlowVariant, auth: MetaAuthVariant,
  family: string): policy is CredentialLifecycleFamilyPolicy {
  return !!policy && policy.flowVariant === flow && policy.authVariant === auth && policy.family === family &&
    validFlowAuthVariant(flow, auth) &&
    typeof policy.inspectEnabled === 'boolean' &&
    typeof policy.refreshEnabled === 'boolean' &&
    typeof policy.createReauthIntent === 'boolean' && (policy.reauthImpactKey === null ||
      /^[A-Z][A-Z0-9_-]{0,63}$/.test(policy.reauthImpactKey)) &&
    (!policy.createReauthIntent || policy.reauthImpactKey !== null) && Number.isSafeInteger(policy.checkIntervalSeconds) &&
    policy.checkIntervalSeconds >= 60 && policy.checkIntervalSeconds <= 7 * 24 * 60 * 60 &&
    Number.isFinite(policy.jitterPercent) && policy.jitterPercent >= 0 && policy.jitterPercent <= 50;
}

function jitteredSeconds(seconds: number, jitterPercent: number, random: () => number): number {
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new RangeError('random must return a value in [0, 1).');
  const spread = jitterPercent / 100;
  return Math.max(60, Math.floor(seconds * (1 + ((sample * 2) - 1) * spread)));
}

function inspectionPayload(row: DueCredentialRow, leaseToken: string, leaseOwner: string): Extract<JobPayload, { kind: 'CREDENTIAL_INSPECTION' }> {
  if (!validFlowAuthVariant(row.flow_variant, row.auth_variant)) throw new Error('credential-lifecycle-flow-auth-unknown');
  const generation = version(row.generation);
  return {
    kind: 'CREDENTIAL_INSPECTION',
    credentialId: row.credential_id,
    authorizationId: row.authorization_id,
    appConfigurationId: row.app_configuration_id,
    provider: 'META',
    environment: row.environment as 'development' | 'test' | 'staging' | 'production',
    flowVariant: row.flow_variant as MetaFlowVariant,
    authVariant: row.auth_variant as MetaAuthVariant,
    family: row.family,
    credentialVersion: version(row.credential_version),
    secretVersion: version(row.secret_version),
    authorizationVersion: version(row.authorization_version),
    lifecycleVersion: version(row.lifecycle_version),
    generation,
    leaseOwner,
    leaseToken,
  };
}

/**
 * Bounded local trigger. Schedule lease and durable enqueue share one transaction, so a crash
 * cannot strand a lease without its idempotent job.
 */
export class CredentialLifecycleScheduler {
  constructor(
    private readonly database: DurableWorkDatabase,
    private readonly jobs: Pick<DurableJobStore, 'enqueueWithin'>,
    private readonly ownerRef: string,
    private readonly now: () => number = () => Date.now(),
    private readonly randomId: () => string = randomUUID,
  ) {
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(ownerRef)) throw new Error('Invalid lifecycle scheduler reference.');
  }

  async scheduleDue(maxJobs = 20, budgetMs = 1_000): Promise<number> {
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > MAX_SCHEDULE_BATCH ||
        !Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > MAX_SCHEDULE_BUDGET_MS) {
      throw new RangeError('Lifecycle scheduling batch/budget is outside its bounded range.');
    }
    const dataSource = await this.database.getDataSource();
    const started = this.now();
    await dataSource.transaction(async (manager) => {
      const seedLimit = Math.min(maxJobs, MAX_SCHEDULE_BATCH);
      await manager.query(
        `INSERT IGNORE INTO ca_meta_credential_lifecycle
           (tenant_id, credential_id, authorization_id, app_configuration_id, provider, environment,
            health_state, next_check_at, version, created_at, updated_at)
         SELECT c.tenant_id, c.id, c.authorization_id, c.app_configuration_id, c.provider, c.environment,
                'UNKNOWN', UTC_TIMESTAMP(6), 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)
         FROM ca_meta_credentials c JOIN ca_meta_authorizations auth ON auth.tenant_id = c.tenant_id
           AND auth.id = c.authorization_id AND auth.app_configuration_id = c.app_configuration_id
           AND auth.provider = c.provider AND auth.environment = c.environment
           AND auth.authorization_state IN ('ACTIVE', 'PARTIAL')
         JOIN ca_meta_credential_secrets s ON s.tenant_id = c.tenant_id
           AND s.credential_id = c.id AND s.authorization_id = c.authorization_id
           AND s.app_configuration_id = c.app_configuration_id AND s.provider = c.provider AND s.environment = c.environment
         WHERE c.status = 'ACTIVE' AND NOT EXISTS (
           SELECT 1 FROM ca_meta_credential_lifecycle present WHERE present.tenant_id = c.tenant_id AND present.credential_id = c.id
         )
         ORDER BY c.tenant_id, c.id LIMIT ${seedLimit}`,
      );
    });
    let scheduled = 0;
    while (scheduled < maxJobs && this.now() - started < budgetMs) {
      const created = await dataSource.transaction(async (manager) => {
        const rows = await manager.query(
          `SELECT c.tenant_id, c.id AS credential_id, c.authorization_id, c.app_configuration_id,
                  c.provider, c.environment, auth.flow_variant, auth.auth_variant, c.family, c.version AS credential_version,
                  s.version AS secret_version, auth.version AS authorization_version,
                  l.version AS lifecycle_version, l.schedule_generation AS generation
           FROM ca_meta_credentials c JOIN ca_meta_credential_secrets s ON s.tenant_id = c.tenant_id
             AND s.credential_id = c.id AND s.authorization_id = c.authorization_id
             AND s.app_configuration_id = c.app_configuration_id AND s.provider = c.provider AND s.environment = c.environment
           JOIN ca_meta_credential_lifecycle l ON l.tenant_id = c.tenant_id AND l.credential_id = c.id
             AND l.authorization_id = c.authorization_id AND l.app_configuration_id = c.app_configuration_id
             AND l.provider = c.provider AND l.environment = c.environment
           JOIN ca_meta_authorizations auth ON auth.tenant_id = c.tenant_id AND auth.id = c.authorization_id
             AND auth.app_configuration_id = c.app_configuration_id AND auth.provider = c.provider
             AND auth.environment = c.environment AND auth.authorization_state IN ('ACTIVE', 'PARTIAL')
           WHERE c.status = 'ACTIVE' AND l.next_check_at <= UTC_TIMESTAMP(6)
             AND auth.flow_variant IS NOT NULL AND auth.auth_variant IS NOT NULL
             AND ((auth.flow_variant = 'FACEBOOK' AND auth.auth_variant = 'FACEBOOK_LOGIN_FOR_BUSINESS')
               OR (auth.flow_variant = 'INSTAGRAM' AND auth.auth_variant IN ('FACEBOOK_LOGIN_FOR_BUSINESS', 'INSTAGRAM_LOGIN'))
               OR (auth.flow_variant = 'WHATSAPP_EXCLUSIVE' AND auth.auth_variant = 'WHATSAPP_EMBEDDED_SIGNUP')
               OR (auth.flow_variant = 'WHATSAPP_COEXISTENCE' AND auth.auth_variant = 'WHATSAPP_BUSINESS_APP_ONBOARDING'))
             AND (l.lease_expires_at IS NULL OR l.lease_expires_at <= UTC_TIMESTAMP(6))
           ORDER BY l.next_check_at, c.tenant_id, c.id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        ) as DueCredentialRow[];
        const row = rows[0];
        if (!row) return false;
        const leaseToken = this.randomId();
        const updated = await manager.query(
          `UPDATE ca_meta_credential_lifecycle
           SET lease_owner = ?, lease_token = ?, lease_expires_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ${SCHEDULER_LEASE_SECONDS} SECOND),
               schedule_generation = schedule_generation + 1, version = version + 1, updated_at = UTC_TIMESTAMP(6)
           WHERE tenant_id = ? AND credential_id = ? AND version = ?
             AND (lease_expires_at IS NULL OR lease_expires_at <= UTC_TIMESTAMP(6)) AND next_check_at <= UTC_TIMESTAMP(6)`,
          [this.ownerRef, leaseToken, row.tenant_id, row.credential_id, row.lifecycle_version],
        );
        if (affectedRows(updated) !== 1) return false;
        const next = { ...row, lifecycle_version: version(row.lifecycle_version) + 1, generation: counter(row.generation) + 1 };
        await this.jobs.enqueueWithin(manager, {
          tenantId: row.tenant_id,
          type: 'CREDENTIAL_INSPECTION',
          idempotencyKey: `credential-inspection:${row.credential_id}:${next.generation}`,
          correlationId: this.randomId(),
          resourceScopeRef: row.credential_id,
          payload: inspectionPayload(next, leaseToken, this.ownerRef),
        });
        return true;
      });
      if (!created) break;
      scheduled += 1;
    }
    return scheduled;
  }

  async run(signal: AbortSignal, onError: () => void = () => undefined, pollMs = 15_000): Promise<void> {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1_000 || pollMs > 60_000) throw new RangeError('Invalid lifecycle scheduler poll interval.');
    while (!signal.aborted) {
      try { await this.scheduleDue(); } catch { onError(); }
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, pollMs);
        function done(): void { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
        signal.addEventListener('abort', done, { once: true });
      });
    }
  }
}

/**
 * Registered durable handler and finalizer. It has no provider effect unless both ports and a
 * flow/auth/family policy are explicitly injected. Errors are reduced to a transient safe outcome.
 */
export class CredentialInspectionWorker {
  private readonly results = new Map<string, InspectionResult>();

  readonly handler: JobHandler = async (job: ClaimedJob, signal: AbortSignal): Promise<JobOutcome> => {
    if (job.type !== 'CREDENTIAL_INSPECTION' || job.payload.kind !== 'CREDENTIAL_INSPECTION') {
      return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
    }
    const payload = job.payload;
    const binding: CredentialInspectionBinding = {
      tenantId: job.tenantId, credentialId: payload.credentialId, authorizationId: payload.authorizationId,
      appConfigurationId: payload.appConfigurationId, provider: 'META' as const,
      environment: payload.environment, flowVariant: payload.flowVariant, authVariant: payload.authVariant, family: payload.family,
      credentialVersion: payload.credentialVersion, secretVersion: payload.secretVersion,
      authorizationVersion: payload.authorizationVersion, lifecycleVersion: payload.lifecycleVersion,
      generation: payload.generation, leaseOwner: payload.leaseOwner, leaseToken: payload.leaseToken,
    };
    const current = await this.currentBinding(job.tenantId, payload);
    if (!current) {
      this.results.set(job.id, { kind: 'FENCED' });
      return { kind: 'SUCCEEDED' };
    }
    const policy = this.policies?.forCredential(binding.flowVariant, binding.authVariant, binding.family);
    if (!validPolicy(policy, binding.flowVariant, binding.authVariant, binding.family) || !policy.inspectEnabled || !this.inspector || !this.secrets ||
        (policy.refreshEnabled && !this.renewal) || signal.aborted) {
      this.results.set(job.id, { kind: 'TRANSIENT', cadenceSeconds: policy?.checkIntervalSeconds, jitterPercent: policy?.jitterPercent });
      return { kind: 'SUCCEEDED' };
    }
    let observation: CredentialInspectionObservation | undefined;
    let renewalResult: Awaited<ReturnType<CredentialRenewalPort['renew']>>;
    try {
      await this.secrets.withCredential(binding, async (secret) => {
        const inspected = validateObservation(await this.inspector!.inspect(binding, secret, signal));
        if (!inspected) throw new Error('invalid-inspection-observation');
        observation = inspected;
        if (inspected.health === 'EXPIRING' && policy.refreshEnabled) {
          if (!this.renewal) throw new Error('renewal-adapter-unavailable');
          renewalResult = await this.renewal.renew(binding, secret, signal);
          if (!renewalResult || typeof renewalResult.replacementSecret !== 'string' ||
              renewalResult.replacementSecret.length === 0 || Buffer.byteLength(renewalResult.replacementSecret, 'utf8') > 16 * 1024) {
            throw new Error('renewal-result-invalid');
          }
          const renewedObservation = validateObservation(renewalResult.observation);
          if (!renewedObservation || !['HEALTHY', 'EXPIRING'].includes(renewedObservation.health)) {
            throw new Error('renewed-observation-invalid');
          }
          observation = renewedObservation;
        }
      });
    } catch {
      this.results.set(job.id, { kind: 'TRANSIENT', cadenceSeconds: policy.checkIntervalSeconds, jitterPercent: policy.jitterPercent });
      return { kind: 'SUCCEEDED' };
    }
    if (signal.aborted || !observation) {
      this.results.set(job.id, { kind: 'TRANSIENT', cadenceSeconds: policy.checkIntervalSeconds, jitterPercent: policy.jitterPercent });
      return { kind: 'SUCCEEDED' };
    }
    if (renewalResult) {
      let replacementSecret = renewalResult.replacementSecret;
      try {
        await this.commitRenewal(job, binding, payload, observation, replacementSecret, policy);
        // Finalizer is deliberately a no-op after renewal's atomic vault+lifecycle commit.
        this.results.set(job.id, { kind: 'FENCED' });
      } catch {
        this.results.set(job.id, { kind: 'TRANSIENT', cadenceSeconds: policy.checkIntervalSeconds, jitterPercent: policy.jitterPercent });
      } finally {
        replacementSecret = '';
        renewalResult = undefined;
      }
      return { kind: 'SUCCEEDED' };
    }
    this.results.set(job.id, {
      kind: 'OBSERVED', observation,
      reauthIntent: policy.createReauthIntent && ['EXPIRED', 'REVOKED', 'ACTION_REQUIRED'].includes(observation.health),
      reauthImpactKey: policy.reauthImpactKey,
      cadenceSeconds: policy.checkIntervalSeconds, jitterPercent: policy.jitterPercent,
    });
    return { kind: 'SUCCEEDED' };
  };

  readonly finalizer: JobFinalizer = async (manager: EntityManager, job: ClaimedJob, _finalization: JobFinalization): Promise<void> => {
    if (job.type !== 'CREDENTIAL_INSPECTION' || job.payload.kind !== 'CREDENTIAL_INSPECTION') return;
    const result = this.results.get(job.id) ?? { kind: 'TRANSIENT' as const };
    this.results.delete(job.id);
    if (result.kind === 'FENCED') return;
    const payload = job.payload;
    const locked = await manager.query(
      `SELECT l.version, l.schedule_generation, l.lease_token, l.lease_owner, l.lease_expires_at,
              (l.lease_expires_at > UTC_TIMESTAMP(6)) AS lease_valid,
              l.health_state, c.version AS credential_version, s.version AS secret_version, auth.version AS authorization_version,
              auth.flow_variant, auth.auth_variant
       FROM ca_meta_credential_lifecycle l JOIN ca_meta_credentials c ON c.tenant_id = l.tenant_id
         AND c.id = l.credential_id AND c.authorization_id = l.authorization_id
         AND c.app_configuration_id = l.app_configuration_id AND c.provider = l.provider AND c.environment = l.environment
       JOIN ca_meta_credential_secrets s ON s.tenant_id = c.tenant_id AND s.credential_id = c.id
         AND s.authorization_id = c.authorization_id AND s.app_configuration_id = c.app_configuration_id
         AND s.provider = c.provider AND s.environment = c.environment
       JOIN ca_meta_authorizations auth ON auth.tenant_id = c.tenant_id AND auth.id = c.authorization_id
         AND auth.app_configuration_id = c.app_configuration_id AND auth.provider = c.provider
         AND auth.environment = c.environment AND auth.authorization_state IN ('ACTIVE', 'PARTIAL')
       WHERE l.tenant_id = ? AND l.credential_id = ? FOR UPDATE`,
      [job.tenantId, payload.credentialId],
    ) as Array<{ version: number | string; schedule_generation: number | string; lease_token: string | null; lease_owner: string | null;
      lease_expires_at: string | Date | null; lease_valid: number | string; health_state: string;
      credential_version: number | string; secret_version: number | string; authorization_version: number | string;
      flow_variant: MetaFlowVariant | null; auth_variant: MetaAuthVariant | null }>;
    const row = locked[0];
    if (!row || version(row.version) !== payload.lifecycleVersion || version(row.schedule_generation) !== payload.generation ||
        row.lease_owner !== payload.leaseOwner || row.lease_token !== payload.leaseToken || Number(row.lease_valid) !== 1 ||
        row.flow_variant !== payload.flowVariant || row.auth_variant !== payload.authVariant ||
        version(row.authorization_version) !== payload.authorizationVersion ||
        version(row.credential_version) !== payload.credentialVersion || version(row.secret_version) !== payload.secretVersion) return;
    const observedResult = result.kind === 'OBSERVED' && result.observation !== undefined
      ? { ...result, observation: result.observation } : undefined;
    if (observedResult) {
      await this.writeObservationWithin(manager, job.tenantId, payload, observedResult,
        jitteredSeconds(result.cadenceSeconds ?? 86_400, result.jitterPercent ?? 20, this.random));
      return;
    }
    await this.markLifecycleStaleWithin(manager, job.tenantId, payload,
      jitteredSeconds(result.cadenceSeconds ?? 86_400, result.jitterPercent ?? 20, this.random));
  };

  constructor(
    private readonly database: DurableWorkDatabase,
    private readonly policies?: CredentialLifecyclePolicyPort,
    private readonly secrets?: CredentialLifecycleSecretPort,
    private readonly inspector?: CredentialInspectionPort,
    private readonly random: () => number = Math.random,
    private readonly renewal?: CredentialRenewalPort,
  ) {}

  private async commitRenewal(job: ClaimedJob, binding: CredentialInspectionBinding,
    payload: Extract<JobPayload, { kind: 'CREDENTIAL_INSPECTION' }>, observation: CredentialInspectionObservation,
    replacementSecret: string, policy: CredentialLifecycleFamilyPolicy): Promise<void> {
    const dataSource = await this.database.getDataSource();
    await dataSource.transaction(async (manager) => {
      const rows = await manager.query(
        `SELECT l.version AS lifecycle_version, l.schedule_generation AS generation,
                l.lease_owner, l.lease_token, (l.lease_expires_at > UTC_TIMESTAMP(6)) AS lease_valid,
                auth.authorization_state, auth.version AS authorization_version, auth.flow_variant, auth.auth_variant,
                c.status AS credential_status, c.version AS credential_version, s.version AS secret_version
         FROM ca_meta_credential_lifecycle l JOIN ca_meta_credentials c ON c.tenant_id = l.tenant_id
           AND c.id = l.credential_id AND c.authorization_id = l.authorization_id
           AND c.app_configuration_id = l.app_configuration_id AND c.provider = l.provider AND c.environment = l.environment
         JOIN ca_meta_authorizations auth ON auth.tenant_id = c.tenant_id AND auth.id = c.authorization_id
           AND auth.app_configuration_id = c.app_configuration_id AND auth.provider = c.provider
           AND auth.environment = c.environment
         JOIN ca_meta_credential_secrets s ON s.tenant_id = c.tenant_id AND s.credential_id = c.id
           AND s.authorization_id = c.authorization_id AND s.app_configuration_id = c.app_configuration_id
           AND s.provider = c.provider AND s.environment = c.environment
         WHERE l.tenant_id = ? AND l.credential_id = ? FOR UPDATE`,
        [job.tenantId, payload.credentialId],
      ) as Array<{ lifecycle_version: number | string; generation: number | string; lease_owner: string | null;
        lease_token: string | null; lease_valid: number | string; authorization_state: string;
        authorization_version: number | string; credential_status: string; credential_version: number | string;
        secret_version: number | string; flow_variant: MetaFlowVariant | null; auth_variant: MetaAuthVariant | null }>;
      const row = rows[0];
      if (!row) return;
      const leaseMatches = Number(row.lease_valid) === 1 && row.lease_owner === payload.leaseOwner &&
        row.lease_token === payload.leaseToken && version(row.lifecycle_version) === payload.lifecycleVersion &&
        version(row.generation) === payload.generation;
      const matches = leaseMatches && ['ACTIVE', 'PARTIAL'].includes(row.authorization_state) && row.credential_status === 'ACTIVE' &&
        row.flow_variant === payload.flowVariant && row.auth_variant === payload.authVariant &&
        version(row.authorization_version) === payload.authorizationVersion &&
        version(row.credential_version) === payload.credentialVersion && version(row.secret_version) === payload.secretVersion &&
        version(row.lifecycle_version) === payload.lifecycleVersion && version(row.generation) === payload.generation;
      if (!matches) {
        if (leaseMatches) await this.markLifecycleStaleWithin(manager, job.tenantId, payload);
        return;
      }
      const fence = {
        ...binding, credentialVersion: payload.credentialVersion, secretVersion: payload.secretVersion,
        authorizationVersion: payload.authorizationVersion, lifecycleVersion: payload.lifecycleVersion,
        generation: payload.generation, leaseOwner: payload.leaseOwner, leaseToken: payload.leaseToken,
      };
      const stored = await this.secrets!.replaceCredentialWithin(manager, binding, fence, replacementSecret);
      if (!stored) {
        await this.markLifecycleStaleWithin(manager, job.tenantId, payload);
        return;
      }
      await this.writeObservationWithin(manager, job.tenantId, payload, { kind: 'OBSERVED', observation },
        jitteredSeconds(policy.checkIntervalSeconds, policy.jitterPercent, this.random));
    });
  }

  private async writeObservationWithin(manager: EntityManager, tenantId: string,
    payload: Extract<JobPayload, { kind: 'CREDENTIAL_INSPECTION' }>,
    result: InspectionResult & { readonly observation: CredentialInspectionObservation }, nextDelaySeconds: number): Promise<void> {
    const observation = result.observation;
    const updated = await manager.query(
      `UPDATE ca_meta_credential_lifecycle
       SET issued_at = ?, expires_at = ?, expiry_state = ?, data_access_expires_at = ?,
           health_state = ?, health_source = 'META_API', health_observed_at = UTC_TIMESTAMP(6),
           expiry_source = 'META_API', expiry_observed_at = UTC_TIMESTAMP(6),
           data_access_expiry_source = 'META_API', data_access_expiry_observed_at = UTC_TIMESTAMP(6),
           last_checked_at = UTC_TIMESTAMP(6), last_safe_reason_code = ?, check_attempts = check_attempts + 1,
           next_check_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ${nextDelaySeconds} SECOND),
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           version = version + 1, updated_at = UTC_TIMESTAMP(6)
       WHERE tenant_id = ? AND credential_id = ? AND version = ? AND schedule_generation = ?
         AND lease_owner = ? AND lease_token = ? AND lease_expires_at > UTC_TIMESTAMP(6)`,
      [observation.issuedAt ? new Date(observation.issuedAt) : null,
        observation.expiresAt ? new Date(observation.expiresAt) : null, observation.expiryState,
        observation.dataAccessExpiresAt ? new Date(observation.dataAccessExpiresAt) : null,
        observation.health, observation.reasonCode, tenantId, payload.credentialId,
        payload.lifecycleVersion, payload.generation, payload.leaseOwner, payload.leaseToken],
    );
    if (affectedRows(updated) !== 1) throw new Error('credential-lifecycle-observation-fence-lost');
    if (result.reauthIntent && result.reauthImpactKey) {
      const reasonCode = observation.reasonCode === 'NONE' ? 'REAUTH_REQUIRED' : observation.reasonCode;
      const dedupeKey = `authorization:${payload.authorizationId}:impact:${result.reauthImpactKey}`;
      await manager.query(
        `INSERT INTO ca_meta_credential_reauth_intents
           (id, tenant_id, credential_id, authorization_id, app_configuration_id, provider, environment,
            dedupe_key, reason_code, status, occurrences, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'META', ?, ?, ?, 'PENDING', 1, 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
         ON DUPLICATE KEY UPDATE credential_id = VALUES(credential_id), reason_code = VALUES(reason_code),
           status = IF(status = 'RESOLVED', 'PENDING', status), occurrences = occurrences + 1,
           version = version + 1, updated_at = UTC_TIMESTAMP(6)`,
        [randomUUID(), tenantId, payload.credentialId, payload.authorizationId, payload.appConfigurationId,
          payload.environment, dedupeKey, reasonCode],
      );
    }
  }

  private async markLifecycleStaleWithin(manager: EntityManager, tenantId: string,
    payload: Extract<JobPayload, { kind: 'CREDENTIAL_INSPECTION' }>, nextDelaySeconds = 86_400): Promise<void> {
    await manager.query(
      `UPDATE ca_meta_credential_lifecycle
       SET health_state = IF(health_state = 'UNKNOWN', 'UNKNOWN', 'STALE'),
           last_checked_at = UTC_TIMESTAMP(6), last_safe_reason_code = 'INSPECTION_UNAVAILABLE',
           check_attempts = check_attempts + 1, next_check_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ${nextDelaySeconds} SECOND),
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           version = version + 1, updated_at = UTC_TIMESTAMP(6)
       WHERE tenant_id = ? AND credential_id = ? AND version = ? AND schedule_generation = ?
         AND lease_owner = ? AND lease_token = ? AND lease_expires_at > UTC_TIMESTAMP(6)`,
      [tenantId, payload.credentialId, payload.lifecycleVersion, payload.generation, payload.leaseOwner, payload.leaseToken],
    );
  }

  private async currentBinding(tenantId: string, payload: Extract<JobPayload, { kind: 'CREDENTIAL_INSPECTION' }>): Promise<boolean> {
    const dataSource = await this.database.getDataSource();
    const rows = await dataSource.query(
      `SELECT c.version AS credential_version, s.version AS secret_version, auth.version AS authorization_version,
              auth.flow_variant, auth.auth_variant,
              l.version AS lifecycle_version,
              l.schedule_generation AS generation, l.lease_owner, l.lease_token,
              (l.lease_expires_at > UTC_TIMESTAMP(6)) AS lease_valid
       FROM ca_meta_credentials c JOIN ca_meta_credential_secrets s ON s.tenant_id = c.tenant_id
         AND s.credential_id = c.id AND s.authorization_id = c.authorization_id
         AND s.app_configuration_id = c.app_configuration_id AND s.provider = c.provider AND s.environment = c.environment
       JOIN ca_meta_credential_lifecycle l ON l.tenant_id = c.tenant_id AND l.credential_id = c.id
         AND l.authorization_id = c.authorization_id AND l.app_configuration_id = c.app_configuration_id
         AND l.provider = c.provider AND l.environment = c.environment
       JOIN ca_meta_authorizations auth ON auth.tenant_id = c.tenant_id AND auth.id = c.authorization_id
         AND auth.app_configuration_id = c.app_configuration_id AND auth.provider = c.provider
         AND auth.environment = c.environment AND auth.authorization_state IN ('ACTIVE', 'PARTIAL')
       WHERE c.tenant_id = ? AND c.id = ? AND c.authorization_id = ? AND c.app_configuration_id = ?
         AND c.provider = 'META' AND c.environment = ? AND c.family = ? AND c.status = 'ACTIVE'`,
      [tenantId, payload.credentialId, payload.authorizationId, payload.appConfigurationId, payload.environment, payload.family],
    ) as Array<{ credential_version: number | string; secret_version: number | string; authorization_version: number | string;
      lifecycle_version: number | string; generation: number | string; lease_token: string | null;
      lease_owner: string | null; lease_valid: number | string; flow_variant: MetaFlowVariant | null;
      auth_variant: MetaAuthVariant | null }>;
    const row = rows[0];
    return !!row && version(row.credential_version) === payload.credentialVersion &&
      version(row.secret_version) === payload.secretVersion && version(row.lifecycle_version) === payload.lifecycleVersion &&
      version(row.authorization_version) === payload.authorizationVersion && version(row.generation) === payload.generation &&
      row.flow_variant === payload.flowVariant && row.auth_variant === payload.authVariant &&
      row.lease_owner === payload.leaseOwner && row.lease_token === payload.leaseToken && Number(row.lease_valid) === 1;
  }
}
