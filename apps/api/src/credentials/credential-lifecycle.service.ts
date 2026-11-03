import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { DurableJobStore, ClaimedJob, JobFinalization, JobOutcome } from '../jobs/job-store.js';
import type { JobHandler, JobFinalizer } from '../worker/durable-worker.js';
import type { JobPayload } from '../jobs/event-validation.js';
import type { CredentialBinding } from './credential-vault.types.js';
import type { CredentialVaultActor } from './credential-vault.types.js';
import type { CredentialVaultService } from './credential-vault.service.js';
import type { MetaAuthVariant, MetaFlowVariant } from './credential-resolver.types.js';
import type {
  CredentialInspectionBinding, CredentialInspectionObservation, CredentialInspectionPort,
  CredentialLifecycleFamilyPolicy, CredentialLifecyclePolicyPort, CredentialLifecycleSecretPort,
  CredentialReauthAffectedAssetPage, CredentialReauthAffectedAssetView, CredentialReauthIntentPage,
  CredentialReauthIntentView,
} from './credential-lifecycle.types.js';

const MAX_SCHEDULE_BATCH = 50;
const MAX_SCHEDULE_BUDGET_MS = 5_000;
const SCHEDULER_LEASE_SECONDS = 120;
const SAFE_REASONS = new Set(['NONE', 'TOKEN_EXPIRED', 'ACCESS_EXPIRED', 'PERMISSION_REVOKED', 'REAUTH_REQUIRED']);
const HEALTH_STATES = new Set(['VALID', 'HEALTHY', 'EXPIRING', 'EXPIRED', 'REVOKED', 'ACTION_REQUIRED']);
const EXPIRY_STATES = new Set(['KNOWN', 'PROVIDER_NO_EXPIRY', 'UNKNOWN']);
const REAUTH_INTENT_PAGE_MAX = 50;
const REAUTH_ASSET_PAGE_MAX = 100;
const INTERNAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

const SUPPORTED_FLOW_AUTH_SQL = Object.entries(FLOW_AUTH_VARIANTS)
  .flatMap(([flow, variants]) => variants.map((auth) => `(auth.flow_variant = '${flow}' AND auth.auth_variant = '${auth}')`))
  .join(' OR ');

function validPolicy(policy: CredentialLifecycleFamilyPolicy | undefined, flow: MetaFlowVariant, auth: MetaAuthVariant,
  family: string): policy is CredentialLifecycleFamilyPolicy {
  return !!policy && policy.flowVariant === flow && policy.authVariant === auth && policy.family === family &&
    validFlowAuthVariant(flow, auth) &&
    typeof policy.inspectEnabled === 'boolean' &&
    policy.refreshEnabled === false &&
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
         WHERE c.status = 'ACTIVE'
           AND (${SUPPORTED_FLOW_AUTH_SQL})
           AND NOT EXISTS (
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
             AND (${SUPPORTED_FLOW_AUTH_SQL})
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
 * Read-only durable inspection handler and finalizer. It needs explicit secret, inspector, and
 * exact flow/auth/family policy ports; it has no renewal/replacement or provider-write capability.
 * Errors are reduced to a transient safe outcome.
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
    if (!validPolicy(policy, binding.flowVariant, binding.authVariant, binding.family) || !policy.inspectEnabled || !this.inspector || !this.secrets || signal.aborted) {
      this.results.set(job.id, { kind: 'TRANSIENT', cadenceSeconds: policy?.checkIntervalSeconds, jitterPercent: policy?.jitterPercent });
      return { kind: 'SUCCEEDED' };
    }
    let observation: CredentialInspectionObservation | undefined;
    try {
      await this.secrets.withCredential(binding, async (secret) => {
        const inspected = validateObservation(await this.inspector!.inspect(binding, secret, signal));
        if (!inspected) throw new Error('invalid-inspection-observation');
        observation = inspected;
      });
    } catch {
      this.results.set(job.id, { kind: 'TRANSIENT', cadenceSeconds: policy.checkIntervalSeconds, jitterPercent: policy.jitterPercent });
      return { kind: 'SUCCEEDED' };
    }
    if (signal.aborted || !observation) {
      this.results.set(job.id, { kind: 'TRANSIENT', cadenceSeconds: policy.checkIntervalSeconds, jitterPercent: policy.jitterPercent });
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
  ) {}

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
    let reauthIntentId: string | undefined;
    if (result.reauthIntent && result.reauthImpactKey) {
      const reasonCode = observation.reasonCode === 'NONE' ? 'REAUTH_REQUIRED' : observation.reasonCode;
      const dedupeKey = `authorization:${payload.authorizationId}:impact:${result.reauthImpactKey}`;
      await manager.query(
        `INSERT INTO ca_meta_credential_reauth_intents
           (id, tenant_id, credential_id, authorization_id, app_configuration_id, provider, environment,
            dedupe_key, reason_code, status, occurrences, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'META', ?, ?, ?, 'PENDING', 1, 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
         ON DUPLICATE KEY UPDATE credential_id = VALUES(credential_id), reason_code = VALUES(reason_code),
           resolved_at = IF(status = 'RESOLVED', NULL, resolved_at), status = IF(status = 'RESOLVED', 'PENDING', status), occurrences = occurrences + 1,
           version = version + 1, updated_at = UTC_TIMESTAMP(6)`,
        [randomUUID(), tenantId, payload.credentialId, payload.authorizationId, payload.appConfigurationId,
          payload.environment, dedupeKey, reasonCode],
      );
      const intentRows = await manager.query(
        'SELECT id FROM ca_meta_credential_reauth_intents WHERE tenant_id = ? AND dedupe_key = ? FOR UPDATE',
        [tenantId, dedupeKey],
      ) as Array<{ id: string }>;
      if (!intentRows[0]) throw new Error('credential-reauth-intent-missing-after-upsert');
      reauthIntentId = intentRows[0].id;
    }
    const reasonCode = observation.reasonCode === 'NONE' ? 'REAUTH_REQUIRED' : observation.reasonCode;
    if (reauthIntentId) await this.recordCredentialReauthImpactsWithin(manager, tenantId, payload, reauthIntentId, reasonCode);
    if (observation.health === 'REVOKED') await this.applyConfirmedCredentialRevocationWithin(manager, tenantId, payload);
  }

  private async recordCredentialReauthImpactsWithin(manager: EntityManager, tenantId: string,
    payload: Extract<JobPayload, { kind: 'CREDENTIAL_INSPECTION' }>, reauthIntentId: string,
    reasonCode: CredentialInspectionObservation['reasonCode'] | 'REAUTH_REQUIRED'): Promise<void> {
    await manager.query(
      `INSERT INTO ca_meta_credential_reauth_impacts
         (tenant_id, reauth_intent_id, credential_id, authorization_id, asset_id, app_configuration_id,
          provider, environment, reason_code, created_at)
       SELECT aa.tenant_id, ?, aa.credential_id, aa.authorization_id, aa.asset_id, aa.app_configuration_id,
              aa.provider, aa.environment, ?, UTC_TIMESTAMP(6)
       FROM ca_meta_asset_authorizations AS aa
       WHERE aa.tenant_id = ? AND aa.authorization_id = ? AND aa.app_configuration_id = ?
         AND aa.provider = 'META' AND aa.environment = ? AND aa.credential_id = ?
         AND aa.state = 'ACTIVE' AND aa.verification_state = 'VERIFIED'
       ON DUPLICATE KEY UPDATE credential_id = VALUES(credential_id), reason_code = VALUES(reason_code)`,
      [reauthIntentId, reasonCode, tenantId, payload.authorizationId, payload.appConfigurationId,
        payload.environment, payload.credentialId],
    );
  }

  private async applyConfirmedCredentialRevocationWithin(manager: EntityManager, tenantId: string,
    payload: Extract<JobPayload, { kind: 'CREDENTIAL_INSPECTION' }>): Promise<void> {
    const revokedCredential = await manager.query(
      `UPDATE ca_meta_credentials
       SET status = 'REVOKED', revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP(6)), version = version + 1,
           updated_at = UTC_TIMESTAMP(6)
       WHERE tenant_id = ? AND id = ? AND authorization_id = ? AND app_configuration_id = ?
         AND provider = 'META' AND environment = ? AND family = ? AND status = 'ACTIVE' AND version = ?`,
      [tenantId, payload.credentialId, payload.authorizationId, payload.appConfigurationId, payload.environment,
        payload.family, payload.credentialVersion],
    );
    if (affectedRows(revokedCredential) !== 1) throw new Error('credential-revocation-fence-lost');

    await manager.query(
      `UPDATE ca_meta_job_attempts AS attempt
       JOIN ca_meta_jobs AS job ON job.tenant_id = attempt.tenant_id AND job.id = attempt.job_id
       SET attempt.outcome = 'FAILED', attempt.safe_error_code = 'CREDENTIAL_REVOKED',
           attempt.safe_error_action = 'REAUTHORIZE', attempt.finished_at = UTC_TIMESTAMP(6),
           attempt.duration_ms = TIMESTAMPDIFF(MICROSECOND, attempt.started_at, UTC_TIMESTAMP(6)) DIV 1000
       WHERE job.tenant_id = ? AND job.job_type = 'CREDENTIAL_INSPECTION' AND job.resource_scope_ref = ?
         AND job.status IN ('QUEUED', 'RETRY_PENDING') AND attempt.outcome = 'RETRY_PENDING'`,
      [tenantId, payload.credentialId],
    );
    await manager.query(
      `UPDATE ca_meta_jobs
       SET status = 'FAILED', last_safe_error_code = 'CREDENTIAL_REVOKED', last_safe_error_action = 'REAUTHORIZE',
           completed_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)
       WHERE tenant_id = ? AND job_type = 'CREDENTIAL_INSPECTION' AND resource_scope_ref = ?
         AND status IN ('QUEUED', 'RETRY_PENDING')`,
      [tenantId, payload.credentialId],
    );

    await manager.query(
      `UPDATE ca_meta_asset_grants AS grant_row
       JOIN ca_meta_asset_authorizations AS asset_auth ON asset_auth.tenant_id = grant_row.tenant_id
         AND asset_auth.authorization_id = grant_row.authorization_id AND asset_auth.asset_id = grant_row.asset_id
         AND asset_auth.app_configuration_id = grant_row.app_configuration_id AND asset_auth.provider = grant_row.provider
         AND asset_auth.environment = grant_row.environment
       SET grant_row.status = 'REVOKED', grant_row.source = 'META_API', grant_row.observed_at = UTC_TIMESTAMP(6),
           grant_row.version = grant_row.version + 1
       WHERE asset_auth.tenant_id = ? AND asset_auth.authorization_id = ? AND asset_auth.app_configuration_id = ?
         AND asset_auth.provider = 'META' AND asset_auth.environment = ? AND asset_auth.credential_id = ?
         AND asset_auth.state <> 'REVOKED' AND grant_row.status = 'GRANTED'`,
      [tenantId, payload.authorizationId, payload.appConfigurationId, payload.environment, payload.credentialId],
    );
    await manager.query(
      `UPDATE ca_meta_asset_authorizations
       SET state = 'REVOKED', version = version + 1, updated_at = UTC_TIMESTAMP(6)
       WHERE tenant_id = ? AND authorization_id = ? AND app_configuration_id = ? AND provider = 'META'
         AND environment = ? AND credential_id = ? AND state <> 'REVOKED'`,
      [tenantId, payload.authorizationId, payload.appConfigurationId, payload.environment, payload.credentialId],
    );
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

/**
 * Transaction-scoped replacement finalizer for a future dedicated ambiguous renewal job.
 * It has no provider port and is deliberately not composed into CredentialInspectionWorker.
 * A replacement can be committed only while the authorization, credential, secret, lifecycle,
 * flow/auth context, generation, and lease all match the inspection snapshot exactly.
 */
export class CredentialReplacementCasService {
  constructor(
    private readonly database: DurableWorkDatabase,
    private readonly vault: Pick<CredentialVaultService, 'replaceIfCurrentWithin'>,
  ) {}

  async replaceIfCurrent(binding: CredentialInspectionBinding, actor: CredentialVaultActor,
    replacementSecret: string): Promise<boolean> {
    if (!validFlowAuthVariant(binding.flowVariant, binding.authVariant) || typeof replacementSecret !== 'string' ||
        replacementSecret.length === 0 || !Number.isSafeInteger(binding.authorizationVersion) ||
        !Number.isSafeInteger(binding.credentialVersion) || !Number.isSafeInteger(binding.secretVersion) ||
        !Number.isSafeInteger(binding.lifecycleVersion) || !Number.isSafeInteger(binding.generation) ||
        binding.generation < 1 || !binding.leaseOwner || !binding.leaseToken) return false;
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => {
      const rows = await manager.query(
        `SELECT auth.authorization_state, auth.version AS authorization_version, auth.flow_variant, auth.auth_variant,
                c.status AS credential_status, c.version AS credential_version, s.version AS secret_version,
                l.version AS lifecycle_version, l.schedule_generation AS generation, l.lease_owner, l.lease_token,
                (l.lease_expires_at > UTC_TIMESTAMP(6)) AS lease_valid
         FROM ca_meta_authorizations auth JOIN ca_meta_credentials c ON c.tenant_id = auth.tenant_id
           AND c.authorization_id = auth.id AND c.app_configuration_id = auth.app_configuration_id
           AND c.provider = auth.provider AND c.environment = auth.environment
         JOIN ca_meta_credential_secrets s ON s.tenant_id = c.tenant_id AND s.credential_id = c.id
           AND s.authorization_id = c.authorization_id AND s.app_configuration_id = c.app_configuration_id
           AND s.provider = c.provider AND s.environment = c.environment
         JOIN ca_meta_credential_lifecycle l ON l.tenant_id = c.tenant_id AND l.credential_id = c.id
           AND l.authorization_id = c.authorization_id AND l.app_configuration_id = c.app_configuration_id
           AND l.provider = c.provider AND l.environment = c.environment
         WHERE auth.tenant_id = ? AND c.id = ? AND auth.id = ? AND c.app_configuration_id = ?
           AND c.provider = 'META' AND c.environment = ? AND c.family = ? FOR UPDATE`,
        [binding.tenantId, binding.credentialId, binding.authorizationId, binding.appConfigurationId,
          binding.environment, binding.family],
      ) as Array<{ authorization_state: string; authorization_version: number | string;
        flow_variant: MetaFlowVariant | null; auth_variant: MetaAuthVariant | null; credential_status: string;
        credential_version: number | string; secret_version: number | string; lifecycle_version: number | string;
        generation: number | string; lease_owner: string | null; lease_token: string | null; lease_valid: number | string }>;
      const row = rows[0];
      if (!row || !['ACTIVE', 'PARTIAL'].includes(row.authorization_state) || row.credential_status !== 'ACTIVE' ||
          row.flow_variant !== binding.flowVariant || row.auth_variant !== binding.authVariant ||
          version(row.authorization_version) !== binding.authorizationVersion ||
          version(row.credential_version) !== binding.credentialVersion || version(row.secret_version) !== binding.secretVersion ||
          version(row.lifecycle_version) !== binding.lifecycleVersion || version(row.generation) !== binding.generation ||
          row.lease_owner !== binding.leaseOwner || row.lease_token !== binding.leaseToken || Number(row.lease_valid) !== 1) {
        return false;
      }
      return this.vault.replaceIfCurrentWithin(manager, {
        tenantId: binding.tenantId,
        credentialId: binding.credentialId,
        authorizationId: binding.authorizationId,
        appConfigurationId: binding.appConfigurationId,
        provider: binding.provider,
        environment: binding.environment,
        family: binding.family,
        ...actor,
        operation: 'CREDENTIAL_RENEWAL',
        secret: replacementSecret,
      }, {
        expectedAuthorizationVersion: binding.authorizationVersion,
        expectedCredentialVersion: binding.credentialVersion,
        expectedSecretVersion: binding.secretVersion,
      });
    });
  }
}

/**
 * Internal, bounded read contract for the future M3.12 connection-status consumer. Callers
 * must authorize tenant and REAUTHORIZE access before reading; this class is not a controller.
 */
export class CredentialReauthIntentReader {
  constructor(private readonly database: DurableWorkDatabase) {}

  async listPending(tenantId: string, afterIntentRef: string | null = null, limit = 25): Promise<CredentialReauthIntentPage> {
    if (!INTERNAL_UUID.test(tenantId) || (afterIntentRef !== null && !INTERNAL_UUID.test(afterIntentRef)) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > REAUTH_INTENT_PAGE_MAX) {
      throw new RangeError('Credential reauthentication page inputs are outside their bounded range.');
    }
    const dataSource = await this.database.getDataSource();
    const rows = await dataSource.query(
      `SELECT i.id, i.authorization_id, auth.flow_variant, auth.auth_variant, i.dedupe_key, i.reason_code,
              i.status, i.occurrences, DATE_FORMAT(i.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_at
       FROM ca_meta_credential_reauth_intents i JOIN ca_meta_authorizations auth
         ON auth.tenant_id = i.tenant_id AND auth.id = i.authorization_id
           AND auth.app_configuration_id = i.app_configuration_id AND auth.provider = i.provider
           AND auth.environment = i.environment
       WHERE i.tenant_id = ? AND i.status IN ('PENDING', 'ACKNOWLEDGED')
         AND (? IS NULL OR i.id > ?)
       ORDER BY i.id LIMIT ${limit + 1}`,
      [tenantId, afterIntentRef, afterIntentRef],
    ) as Array<{ id: string; authorization_id: string; flow_variant: MetaFlowVariant | null; auth_variant: MetaAuthVariant | null;
      dedupe_key: string; reason_code: string; status: 'PENDING' | 'ACKNOWLEDGED'; occurrences: number | string; updated_at: string }>;
    const hasMore = rows.length > limit;
    const items: CredentialReauthIntentView[] = rows.slice(0, limit).map((row) => {
      const prefix = `authorization:${row.authorization_id}:impact:`;
      const impactKey = row.dedupe_key.startsWith(prefix) ? row.dedupe_key.slice(prefix.length) : '';
      if (!INTERNAL_UUID.test(row.id) || !INTERNAL_UUID.test(row.authorization_id) ||
          !/^[A-Z][A-Z0-9_-]{0,63}$/.test(impactKey) || !SAFE_REASONS.has(row.reason_code) && row.reason_code !== 'REAUTH_REQUIRED' ||
          !validFlowAuthVariant(row.flow_variant, row.auth_variant) || !validUtc(row.updated_at)) {
        throw new Error('credential-reauth-intent-read-shape-invalid');
      }
      return Object.freeze({
        intentRef: row.id, authorizationRef: row.authorization_id, flowVariant: row.flow_variant, authVariant: row.auth_variant,
        impactKey, reasonCode: row.reason_code, status: row.status, occurrences: counter(row.occurrences), updatedAt: row.updated_at,
      });
    });
    return Object.freeze({ items: Object.freeze(items), nextAfterRef: hasMore ? items.at(-1)?.intentRef ?? null : null });
  }

  async listAffectedAssets(tenantId: string, intentRef: string, afterAssetRef: string | null = null,
    limit = 50): Promise<CredentialReauthAffectedAssetPage> {
    if (!INTERNAL_UUID.test(tenantId) || !INTERNAL_UUID.test(intentRef) ||
        (afterAssetRef !== null && !INTERNAL_UUID.test(afterAssetRef)) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > REAUTH_ASSET_PAGE_MAX) {
      throw new RangeError('Credential reauthentication asset page inputs are outside their bounded range.');
    }
    const dataSource = await this.database.getDataSource();
    const rows = await dataSource.query(
      `SELECT impact.credential_id, impact.asset_id, asset.asset_kind, credential.family, impact.reason_code
       FROM ca_meta_credential_reauth_impacts impact
       JOIN ca_meta_credential_reauth_intents intent ON intent.tenant_id = impact.tenant_id
         AND intent.id = impact.reauth_intent_id AND intent.authorization_id = impact.authorization_id
         AND intent.app_configuration_id = impact.app_configuration_id AND intent.provider = impact.provider
         AND intent.environment = impact.environment AND intent.status IN ('PENDING', 'ACKNOWLEDGED')
       JOIN ca_meta_asset_authorizations asset_auth ON asset_auth.tenant_id = impact.tenant_id
         AND asset_auth.authorization_id = impact.authorization_id AND asset_auth.asset_id = impact.asset_id
         AND asset_auth.app_configuration_id = impact.app_configuration_id AND asset_auth.provider = impact.provider
         AND asset_auth.environment = impact.environment AND asset_auth.credential_id = impact.credential_id
         AND asset_auth.verification_state = 'VERIFIED'
       JOIN ca_meta_credentials credential ON credential.tenant_id = impact.tenant_id
         AND credential.id = impact.credential_id AND credential.authorization_id = impact.authorization_id
         AND credential.app_configuration_id = impact.app_configuration_id AND credential.provider = impact.provider
         AND credential.environment = impact.environment
       JOIN ca_meta_credential_lifecycle lifecycle ON lifecycle.tenant_id = credential.tenant_id
         AND lifecycle.credential_id = credential.id AND lifecycle.authorization_id = credential.authorization_id
         AND lifecycle.app_configuration_id = credential.app_configuration_id AND lifecycle.provider = credential.provider
         AND lifecycle.environment = credential.environment
       JOIN ca_meta_assets asset ON asset.tenant_id = impact.tenant_id AND asset.id = impact.asset_id
         AND asset.app_configuration_id = impact.app_configuration_id AND asset.provider = impact.provider
         AND asset.environment = impact.environment
       WHERE impact.tenant_id = ? AND impact.reauth_intent_id = ? AND (? IS NULL OR impact.asset_id > ?)
         AND ((lifecycle.health_state = 'REVOKED' AND credential.status = 'REVOKED' AND asset_auth.state = 'REVOKED')
           OR (lifecycle.health_state IN ('EXPIRED', 'ACTION_REQUIRED') AND credential.status = 'ACTIVE' AND asset_auth.state = 'ACTIVE'))
       ORDER BY impact.asset_id LIMIT ${limit + 1}`,
      [tenantId, intentRef, afterAssetRef, afterAssetRef],
    ) as Array<{ credential_id: string; asset_id: string; asset_kind: string; family: string; reason_code: string }>;
    const hasMore = rows.length > limit;
    const items: CredentialReauthAffectedAssetView[] = rows.slice(0, limit).map((row) => {
      if (!INTERNAL_UUID.test(row.credential_id) || !INTERNAL_UUID.test(row.asset_id) ||
          !/^[A-Z][A-Z0-9_-]{0,31}$/.test(row.family) || !/^[A-Z][A-Z0-9_-]{0,63}$/.test(row.asset_kind) ||
          !SAFE_REASONS.has(row.reason_code)) {
        throw new Error('credential-reauth-impact-read-shape-invalid');
      }
      return Object.freeze({ credentialRef: row.credential_id, assetRef: row.asset_id, assetKind: row.asset_kind,
        family: row.family, reasonCode: row.reason_code });
    });
    return Object.freeze({ items: Object.freeze(items), nextAfterAssetRef: hasMore ? items.at(-1)?.assetRef ?? null : null });
  }
}
