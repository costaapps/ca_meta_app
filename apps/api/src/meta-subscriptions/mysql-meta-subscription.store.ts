import { createHash, randomUUID } from 'node:crypto';
import type { QueryRunner } from 'typeorm';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { MetaSubscriptionClaim, MetaSubscriptionReconcileState,
  MetaSubscriptionInactiveCleanupResult, MetaSubscriptionState, MetaSubscriptionStore, MetaSubscriptionTargetContext,
  MetaSubscriptionTargetSnapshot } from './meta-subscriptions.types.js';

interface TargetRow {
  readonly id: string;
  readonly desired_state: MetaSubscriptionState;
  readonly desired_fields: string;
  readonly observed_state: MetaSubscriptionState;
  readonly observed_fields: string;
  readonly reconcile_state: MetaSubscriptionReconcileState;
  readonly version: string | number;
  readonly attempt_count: string | number;
  readonly last_attempt_at?: string | Date | null;
  readonly last_verified_at?: string | Date | null;
  readonly next_attempt_at?: string | Date | null;
  readonly last_safe_reason_code?: string | null;
  readonly lock_token?: string | null;
  readonly locked?: number | string;
}
interface BindingRow { readonly asset_id: string; readonly authorization_id: string; readonly desired_fields: string; readonly binding_state: 'ACTIVE' | 'REMOVED'; readonly version: string | number }
interface InactiveBindingCandidate {
  readonly target_id: string;
  readonly asset_id: string;
  readonly authorization_id: string;
  readonly desired_fields: string;
  readonly target_version: string | number;
  readonly target_desired_state: MetaSubscriptionState;
  readonly target_desired_fields: string;
  readonly target_observed_state: MetaSubscriptionState;
  readonly authorization_state: string;
  readonly asset_state: string;
  readonly verification_state: string;
  readonly credential_id: string | null;
  readonly credential_status: string | null;
  readonly secret_credential_id: string | null;
  readonly health_state: string | null;
  readonly health_source: string | null;
  readonly health_observed_at: string | Date | null;
  readonly expiry_state: string | null;
  readonly expiry_source: string | null;
  readonly expires_at: string | Date | null;
  readonly expiry_observed_at: string | Date | null;
  readonly data_access_expiry_source: string | null;
  readonly data_access_expires_at: string | Date | null;
  readonly data_access_expiry_observed_at: string | Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_REASON = /^[A-Z][A-Z0-9_]{1,63}$/;
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ENSURE_BINDING_MAX_ATTEMPTS = 4;

function isTransientLockContention(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { readonly code?: unknown; readonly driverError?: unknown };
  const driverCode = typeof value.driverError === 'object' && value.driverError !== null && 'code' in value.driverError
    ? (value.driverError as { readonly code?: unknown }).code : undefined;
  const code = value.code ?? driverCode;
  return code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT';
}

function ensureBindingRetryDelay(attempt: number): Promise<void> {
  const delayMs = Math.min(60, 20 * 2 ** (attempt - 1));
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function fieldsJson(value: readonly string[]): string {
  if (!Array.isArray(value) || value.length > 64 || value.some((field) => typeof field !== 'string' || !SAFE_FIELD.test(field))) {
    throw new Error('Subscription fields are invalid.');
  }
  return JSON.stringify([...new Set(value)].sort());
}
function parseFields(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) return Object.freeze([]);
    return Object.freeze([...new Set(parsed as string[])].sort());
  } catch { return Object.freeze([]); }
}
function mysqlDate(value: string | undefined): string | null {
  if (value === undefined) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Retry time is invalid.');
  return date.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
}
function isoDate(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function fresh(value: string | Date | null, now: number): boolean {
  if (value === null) return false;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) && parsed <= now && now - parsed <= 86_400_000;
}
function future(value: string | Date | null, now: number): boolean {
  if (value === null) return false;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) && parsed > now;
}
function resolverCredentialUsable(row: InactiveBindingCandidate, now: number): boolean {
  if (!['ACTIVE', 'PARTIAL'].includes(row.authorization_state) || row.asset_state !== 'ACTIVE' || row.verification_state !== 'VERIFIED' ||
      !row.credential_id || row.credential_status !== 'ACTIVE' || row.secret_credential_id !== row.credential_id ||
      !row.health_state || !['HEALTHY', 'EXPIRING'].includes(row.health_state) || !['META_API', 'SIGNED_WEBHOOK'].includes(row.health_source ?? '') ||
      !fresh(row.health_observed_at, now)) return false;
  const expiryUsable = row.expiry_state === 'PROVIDER_NO_EXPIRY'
    ? ['META_API', 'SIGNED_WEBHOOK'].includes(row.expiry_source ?? '') && fresh(row.expiry_observed_at, now)
    : row.expiry_state === 'KNOWN' && ['META_API', 'SIGNED_WEBHOOK'].includes(row.expiry_source ?? '') &&
      future(row.expires_at, now) && fresh(row.expiry_observed_at, now);
  return expiryUsable && ['META_API', 'SIGNED_WEBHOOK'].includes(row.data_access_expiry_source ?? '') &&
    future(row.data_access_expires_at, now) && fresh(row.data_access_expiry_observed_at, now);
}

/** Durable per-WABA state. A single target row is the cross-process lock for every phone under a WABA. */
export class MysqlMetaSubscriptionStore implements MetaSubscriptionStore {
  constructor(private readonly database: DurableWorkDatabase, private readonly now: () => Date = () => new Date()) {}

  async ensureBinding(input: MetaSubscriptionTargetContext & { readonly desiredFields: readonly string[];
    readonly actorRef: string; readonly correlationId: string }): Promise<MetaSubscriptionTargetSnapshot> {
    this.validate(input.tenantId, input.appConfigurationId, input.authorizationId, input.targetAssetId, input.sourceAssetId, input.correlationId);
    this.validateEnvironment(input.environment);
    for (let attempt = 1; attempt <= ENSURE_BINDING_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.ensureBindingTransaction(input);
      } catch (error) {
        if (!isTransientLockContention(error) || attempt === ENSURE_BINDING_MAX_ATTEMPTS) throw error;
        // The attempt helper has rolled back and released its QueryRunner before this backoff begins.
        await ensureBindingRetryDelay(attempt);
      }
    }
    throw new Error('Subscription binding retry loop exited unexpectedly.');
  }

  private async ensureBindingTransaction(input: MetaSubscriptionTargetContext & { readonly desiredFields: readonly string[];
    readonly actorRef: string; readonly correlationId: string }): Promise<MetaSubscriptionTargetSnapshot> {
    const runner = await this.database.getDataSource().then((source) => source.createQueryRunner());
    let transactionStarted = false;
    try {
      await runner.connect();
      await runner.startTransaction();
      transactionStarted = true;
      const now = this.sqlNow();
      await runner.query(
        `INSERT IGNORE INTO ca_meta_subscription_targets
         (id, tenant_id, app_configuration_id, provider, environment, target_asset_id, desired_state, desired_fields,
          observed_state, observed_fields, reconcile_state, version, attempt_count, last_attempt_at, last_verified_at, next_attempt_at, last_safe_reason_code,
          lock_token, lock_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, 'META', ?, ?, 'UNSUBSCRIBED', '[]', 'UNKNOWN', '[]', 'PENDING', 1, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        [randomUUID(), input.tenantId, input.appConfigurationId, input.environment, input.targetAssetId, now, now],
      );
      const targets = await runner.query(
        `SELECT id, version, desired_state, desired_fields FROM ca_meta_subscription_targets
         WHERE tenant_id = ? AND app_configuration_id = ? AND provider = 'META' AND environment = ? AND target_asset_id = ?
         FOR UPDATE`,
        [input.tenantId, input.appConfigurationId, input.environment, input.targetAssetId],
      ) as Array<{ id: string; version: string | number; desired_state: MetaSubscriptionState; desired_fields: string }>;
      const target = targets[0];
      if (!target) throw new Error('Subscription target row was not created.');
      await runner.query(
        `INSERT INTO ca_meta_subscription_bindings
         (tenant_id, target_id, asset_id, authorization_id, app_configuration_id, provider, environment, desired_fields, binding_state, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'META', ?, ?, 'ACTIVE', 1, ?, ?)
         ON DUPLICATE KEY UPDATE desired_fields = VALUES(desired_fields), binding_state = 'ACTIVE', version = version + 1, updated_at = VALUES(updated_at)`,
        [input.tenantId, target.id, input.sourceAssetId, input.authorizationId, input.appConfigurationId, input.environment, fieldsJson(input.desiredFields), now, now],
      );
      const bindings = await this.readBindings(runner, input.tenantId, target.id);
      const active = bindings.filter((binding) => binding.state === 'ACTIVE');
      const union = fieldsJson(active.flatMap((binding) => binding.desiredFields));
      const desiredChanged = target.desired_state !== 'SUBSCRIBED' || fieldsJson(parseFields(target.desired_fields)) !== union;
      await runner.query(
        `UPDATE ca_meta_subscription_targets SET desired_state = 'SUBSCRIBED', desired_fields = ?,
         reconcile_state = IF(? = 1, 'PENDING', reconcile_state), version = version + ?,
         next_attempt_at = IF(? = 1, NULL, next_attempt_at), last_safe_reason_code = IF(? = 1, NULL, last_safe_reason_code),
         updated_at = ? WHERE tenant_id = ? AND id = ?`,
        [union, Number(desiredChanged), Number(desiredChanged), Number(desiredChanged), Number(desiredChanged), now, input.tenantId, target.id],
      );
      await this.audit(runner, { tenantId: input.tenantId, appConfigurationId: input.appConfigurationId, environment: input.environment, targetId: target.id,
        assetId: input.sourceAssetId, action: 'DESIRED_STATE_CHANGED', reasonCode: desiredChanged ? 'TARGET_DESIRED_STATE_CHANGED' : 'BINDING_UPSERTED',
        beforeVersion: Number(target.version), afterVersion: Number(target.version) + Number(desiredChanged), correlationId: input.correlationId, actorRef: input.actorRef });
      const snapshot = await this.readSnapshot(runner, input, target.id);
      await runner.commitTransaction();
      return snapshot;
    } catch (error) {
      if (runner.isTransactionActive) {
        try { await runner.rollbackTransaction(); }
        catch (rollbackError) { throw new Error('Subscription binding rollback failed; automatic retry suppressed.', { cause: rollbackError }); }
      }
      if (!transactionStarted) throw new Error('Subscription binding transaction setup failed; automatic retry suppressed.', { cause: error });
      throw error;
    } finally {
      try { await runner.release(); }
      catch (releaseError) { throw new Error('Subscription binding QueryRunner release failed; automatic retry suppressed.', { cause: releaseError }); }
    }
  }

  async removeBinding(input: MetaSubscriptionTargetContext & { readonly actorRef: string; readonly correlationId: string }): Promise<MetaSubscriptionTargetSnapshot> {
    this.validate(input.tenantId, input.appConfigurationId, input.authorizationId, input.targetAssetId, input.sourceAssetId, input.correlationId);
    this.validateEnvironment(input.environment);
    const runner = await this.database.getDataSource().then((source) => source.createQueryRunner());
    await runner.connect(); await runner.startTransaction();
    try {
      const rows = await runner.query(
        `SELECT id, version, desired_state, observed_state, desired_fields FROM ca_meta_subscription_targets
         WHERE tenant_id = ? AND app_configuration_id = ? AND provider = 'META' AND environment = ? AND target_asset_id = ? FOR UPDATE`,
        [input.tenantId, input.appConfigurationId, input.environment, input.targetAssetId],
       ) as Array<{ id: string; version: string | number; desired_state: MetaSubscriptionState; observed_state: MetaSubscriptionState; desired_fields: string }>;
      const target = rows[0];
      if (!target) throw new Error('Subscription target does not exist.');
      const now = this.sqlNow();
      await runner.query(
        `UPDATE ca_meta_subscription_bindings SET binding_state = 'REMOVED', version = version + 1, updated_at = ?
         WHERE tenant_id = ? AND target_id = ? AND asset_id = ? AND authorization_id = ? AND binding_state = 'ACTIVE'`,
        [now, input.tenantId, target.id, input.sourceAssetId, input.authorizationId],
      );
      const bindings = await this.readBindings(runner, input.tenantId, target.id);
      const active = bindings.filter((binding) => binding.state === 'ACTIVE');
      const desiredState: MetaSubscriptionState = active.length > 0 ? 'SUBSCRIBED' : 'UNSUBSCRIBED';
      const desiredFields = fieldsJson(active.flatMap((binding) => binding.desiredFields));
      const desiredChanged = target.desired_state !== desiredState || fieldsJson(parseFields(target.desired_fields)) !== desiredFields;
      const nextState: MetaSubscriptionReconcileState = active.length > 0
        ? target.observed_state === 'SUBSCRIBED' ? 'ACTIVE' : 'PENDING'
        : 'MANUAL_ACTION_REQUIRED';
      const reason = active.length > 0 ? null : 'REMOTE_UNSUBSCRIBE_NOT_CONFIRMED';
      await runner.query(
        `UPDATE ca_meta_subscription_targets SET desired_state = ?, desired_fields = ?, reconcile_state = ?,
         last_safe_reason_code = ?, version = version + ?, next_attempt_at = IF(? = 1, NULL, next_attempt_at), updated_at = ? WHERE tenant_id = ? AND id = ?`,
        [desiredState, desiredFields, nextState, reason, Number(desiredChanged), Number(desiredChanged), now, input.tenantId, target.id],
      );
      await this.audit(runner, { tenantId: input.tenantId, appConfigurationId: input.appConfigurationId, environment: input.environment, targetId: target.id,
        assetId: input.sourceAssetId, action: 'BINDING_REMOVED', reasonCode: active.length > 0 ? 'SHARED_CONSUMER_REMAINS' : 'REMOTE_UNSUBSCRIBE_NOT_CONFIRMED',
        beforeVersion: Number(target.version), afterVersion: Number(target.version) + Number(desiredChanged), correlationId: input.correlationId, actorRef: input.actorRef });
      const snapshot = await this.readSnapshot(runner, input, target.id);
      await runner.commitTransaction();
      return snapshot;
    } catch (error) { await runner.rollbackTransaction(); throw error; }
    finally { await runner.release(); }
  }

  /** Retire stale grant-owned bindings from server state only. This path never calls Meta. */
  async removeInactiveBindings(input: { readonly tenantId: string; readonly appConfigurationId: string;
    readonly environment: MetaSubscriptionTargetContext['environment']; readonly assetId: string;
    readonly actorRef: string; readonly correlationId: string }): Promise<MetaSubscriptionInactiveCleanupResult> {
    this.validate(input.tenantId, input.appConfigurationId, input.assetId, input.correlationId);
    this.validateEnvironment(input.environment);
    const runner = await this.database.getDataSource().then((source) => source.createQueryRunner());
    await runner.connect(); await runner.startTransaction();
    try {
      const candidates = await runner.query(
        `SELECT b.target_id, b.asset_id, b.authorization_id, b.desired_fields,
                t.version AS target_version, t.desired_state AS target_desired_state,
                t.desired_fields AS target_desired_fields, t.observed_state AS target_observed_state,
                auth.authorization_state, aa.state AS asset_state, aa.verification_state, aa.credential_id,
                c.status AS credential_status, secret.credential_id AS secret_credential_id,
                life.health_state, life.health_source, life.health_observed_at, life.expiry_state, life.expiry_source,
                life.expires_at, life.expiry_observed_at, life.data_access_expiry_source,
                life.data_access_expires_at, life.data_access_expiry_observed_at
         FROM ca_meta_subscription_bindings b
         INNER JOIN ca_meta_subscription_targets t ON t.tenant_id = b.tenant_id AND t.id = b.target_id
           AND t.app_configuration_id = b.app_configuration_id AND t.provider = b.provider AND t.environment = b.environment
         INNER JOIN ca_meta_asset_authorizations aa ON aa.tenant_id = b.tenant_id AND aa.authorization_id = b.authorization_id
           AND aa.asset_id = b.asset_id AND aa.app_configuration_id = b.app_configuration_id
           AND aa.provider = b.provider AND aa.environment = b.environment
         INNER JOIN ca_meta_authorizations auth ON auth.tenant_id = aa.tenant_id AND auth.id = aa.authorization_id
           AND auth.app_configuration_id = aa.app_configuration_id AND auth.provider = aa.provider AND auth.environment = aa.environment
         LEFT JOIN ca_meta_credentials c ON c.tenant_id = aa.tenant_id AND c.id = aa.credential_id
           AND c.authorization_id = aa.authorization_id AND c.app_configuration_id = aa.app_configuration_id
           AND c.provider = aa.provider AND c.environment = aa.environment
         LEFT JOIN ca_meta_credential_secrets secret ON secret.tenant_id = c.tenant_id AND secret.credential_id = c.id
           AND secret.authorization_id = c.authorization_id AND secret.app_configuration_id = c.app_configuration_id
           AND secret.provider = c.provider AND secret.environment = c.environment
         LEFT JOIN ca_meta_credential_lifecycle life ON life.tenant_id = c.tenant_id AND life.credential_id = c.id
           AND life.authorization_id = c.authorization_id AND life.app_configuration_id = c.app_configuration_id
           AND life.provider = c.provider AND life.environment = c.environment
         WHERE b.tenant_id = ? AND b.app_configuration_id = ? AND b.provider = 'META' AND b.environment = ?
           AND b.asset_id = ? AND b.binding_state = 'ACTIVE'
         ORDER BY b.target_id, b.authorization_id FOR UPDATE`,
        [input.tenantId, input.appConfigurationId, input.environment, input.assetId],
      ) as InactiveBindingCandidate[];
      const nowEpoch = this.now().getTime();
      const stale = candidates.filter((row) => {
        const grantInactive = row.authorization_state !== 'ACTIVE' || row.asset_state !== 'ACTIVE' || row.verification_state !== 'VERIFIED';
        return grantInactive && !resolverCredentialUsable(row, nowEpoch);
      });
      if (stale.length === 0) {
        await runner.commitTransaction();
        return Object.freeze({ removedBindingCount: 0, targets: Object.freeze([]) });
      }

      const now = this.sqlNow();
      const targetGroups = new Map<string, InactiveBindingCandidate[]>();
      for (const row of stale) targetGroups.set(row.target_id, [...(targetGroups.get(row.target_id) ?? []), row]);
      const outcomes: MetaSubscriptionInactiveCleanupResult['targets'][number][] = [];
      for (const [targetId, removed] of [...targetGroups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const before = removed[0]!;
        for (const row of removed) {
          await runner.query(
            `UPDATE ca_meta_subscription_bindings SET binding_state = 'REMOVED', version = version + 1, updated_at = ?
             WHERE tenant_id = ? AND target_id = ? AND asset_id = ? AND authorization_id = ? AND binding_state = 'ACTIVE'`,
            [now, input.tenantId, targetId, row.asset_id, row.authorization_id],
          );
        }
        const bindings = await this.readBindings(runner, input.tenantId, targetId);
        const active = bindings.filter((binding) => binding.state === 'ACTIVE');
        const desiredState: MetaSubscriptionState = active.length > 0 ? 'SUBSCRIBED' : 'UNSUBSCRIBED';
        const desiredFields = fieldsJson(active.flatMap((binding) => binding.desiredFields));
        const desiredChanged = before.target_desired_state !== desiredState ||
          fieldsJson(parseFields(before.target_desired_fields)) !== desiredFields;
        const state: MetaSubscriptionReconcileState = active.length > 0
          ? before.target_observed_state === 'SUBSCRIBED' ? 'ACTIVE' : 'PENDING'
          : 'MANUAL_ACTION_REQUIRED';
        await runner.query(
          `UPDATE ca_meta_subscription_targets SET desired_state = ?, desired_fields = ?, reconcile_state = ?,
           last_safe_reason_code = ?, version = version + ?, next_attempt_at = IF(? = 1, NULL, next_attempt_at), updated_at = ?
           WHERE tenant_id = ? AND id = ?`,
          [desiredState, desiredFields, state, active.length > 0 ? null : 'REMOTE_UNSUBSCRIBE_NOT_CONFIRMED',
            Number(desiredChanged), Number(desiredChanged), now, input.tenantId, targetId],
        );
        const version = Number(before.target_version) + Number(desiredChanged);
        for (const row of removed) {
          await this.audit(runner, { tenantId: input.tenantId, appConfigurationId: input.appConfigurationId,
            environment: input.environment, targetId, assetId: row.asset_id, action: 'BINDING_REMOVED',
            reasonCode: 'INACTIVE_GRANT_CREDENTIAL_UNUSABLE', beforeVersion: Number(before.target_version), afterVersion: version,
            correlationId: input.correlationId, actorRef: input.actorRef });
        }
        outcomes.push(Object.freeze({ targetId, desiredState, observedState: before.target_observed_state, state,
          version, remainingBindingCount: active.length }));
      }
      await runner.commitTransaction();
      return Object.freeze({ removedBindingCount: stale.length, targets: Object.freeze(outcomes) });
    } catch (error) { await runner.rollbackTransaction(); throw error; }
    finally { await runner.release(); }
  }

  async claim(input: MetaSubscriptionTargetContext, leaseMilliseconds: number): Promise<MetaSubscriptionClaim | undefined> {
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1_000 || leaseMilliseconds > 120_000) throw new Error('Subscription lease is invalid.');
    this.validate(input.tenantId, input.appConfigurationId, input.targetAssetId);
    this.validateEnvironment(input.environment);
    const runner = await this.database.getDataSource().then((source) => source.createQueryRunner());
    await runner.connect(); await runner.startTransaction();
    try {
      const rows = await runner.query(
        `SELECT id, desired_state, desired_fields, observed_state, observed_fields, reconcile_state, version, attempt_count,
                last_attempt_at, last_verified_at, next_attempt_at, last_safe_reason_code,
                lock_token, (lock_expires_at > UTC_TIMESTAMP(6)) AS locked
         FROM ca_meta_subscription_targets WHERE tenant_id = ? AND app_configuration_id = ? AND provider = 'META'
           AND environment = ? AND target_asset_id = ?
           AND (next_attempt_at IS NULL OR next_attempt_at <= UTC_TIMESTAMP(6)) FOR UPDATE`,
        [input.tenantId, input.appConfigurationId, input.environment, input.targetAssetId],
      ) as TargetRow[];
      const row = rows[0];
      if (!row || Number(row.locked) === 1 || row.desired_state !== 'SUBSCRIBED') {
        await runner.commitTransaction(); return undefined;
      }
      const token = randomUUID();
      const now = this.sqlNow();
      const expiry = new Date(this.now().getTime() + leaseMilliseconds).toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
      await runner.query(
        `UPDATE ca_meta_subscription_targets SET lock_token = ?, lock_expires_at = ?, attempt_count = attempt_count + 1,
          last_attempt_at = ?,
          version = version + 1, reconcile_state = 'PENDING', updated_at = ? WHERE tenant_id = ? AND id = ?`,
        [token, expiry, now, now, input.tenantId, row.id],
      );
      const claimedVersion = Number(row.version) + 1;
      const snapshot = await this.readSnapshot(runner, input, row.id);
      await runner.commitTransaction();
      return Object.freeze({ target: snapshot, leaseToken: token, claimedVersion });
    } catch (error) { await runner.rollbackTransaction(); throw error; }
    finally { await runner.release(); }
  }

  async complete(claim: MetaSubscriptionClaim, input: { readonly state: MetaSubscriptionReconcileState;
    readonly observedState: MetaSubscriptionState; readonly observedFields: readonly string[]; readonly reasonCode?: string;
    readonly retryAt?: string; readonly actorRef: string; readonly correlationId: string }): Promise<MetaSubscriptionTargetSnapshot> {
    if (input.reasonCode !== undefined && !SAFE_REASON.test(input.reasonCode)) throw new Error('Subscription reason code is invalid.');
    const runner = await this.database.getDataSource().then((source) => source.createQueryRunner());
    await runner.connect(); await runner.startTransaction();
    try {
      const now = this.sqlNow();
      const updateResult = await runner.query(
        `UPDATE ca_meta_subscription_targets SET observed_state = ?, observed_fields = ?, reconcile_state = ?,
          last_safe_reason_code = ?, next_attempt_at = ?, attempt_count = IF(? = 'ACTIVE', 0, attempt_count),
          last_verified_at = IF(? <> 'UNKNOWN', ?, last_verified_at),
          lock_token = NULL, lock_expires_at = NULL, version = version + 1, updated_at = ?
         WHERE tenant_id = ? AND id = ? AND lock_token = ? AND version = ?`,
        [input.observedState, fieldsJson(input.observedFields), input.state, input.reasonCode ?? null, mysqlDate(input.retryAt),
          input.state, input.observedState, now, now, claim.target.tenantId, claim.target.targetId, claim.leaseToken, claim.claimedVersion],
      ) as { readonly affectedRows?: number };
      if (Number(updateResult.affectedRows) !== 1) throw new Error('Subscription lease was lost before outcome persistence.');
      const rows = await runner.query(
        `SELECT id, version, lock_token FROM ca_meta_subscription_targets WHERE tenant_id = ? AND id = ?`,
        [claim.target.tenantId, claim.target.targetId],
      ) as Array<{ id: string; version: string | number; lock_token: string | null }>;
      const version = Number(rows[0]?.version ?? 0);
      if (version !== claim.claimedVersion + 1 || rows[0]?.lock_token !== null) throw new Error('Subscription lease was lost before outcome persistence.');
      const successful = input.state === 'ACTIVE';
      await this.audit(runner, { tenantId: claim.target.tenantId, appConfigurationId: claim.target.appConfigurationId, environment: claim.target.environment,
        targetId: claim.target.targetId, assetId: claim.target.targetAssetId,
        action: successful ? 'RECONCILE_SUCCEEDED' : 'RECONCILE_PARTIAL', reasonCode: input.reasonCode ?? (successful ? 'SUBSCRIBED' : 'RECONCILE_INCOMPLETE'),
        beforeVersion: claim.claimedVersion, afterVersion: version, correlationId: input.correlationId, actorRef: input.actorRef });
      const snapshot = await this.readSnapshot(runner, claim.target, claim.target.targetId);
      await runner.commitTransaction();
      return snapshot;
    } catch (error) { await runner.rollbackTransaction(); throw error; }
    finally { await runner.release(); }
  }

  async saveAppWebhookDesired(input: { readonly tenantId: string; readonly appConfigurationId: string;
    readonly environment: MetaSubscriptionTargetContext['environment']; readonly desiredFields: readonly string[];
    readonly actorRef: string; readonly correlationId: string }): Promise<{ readonly desiredFields: readonly string[];
      readonly observedFields: readonly string[]; readonly state: 'NOT_CONFIRMED'; readonly version: number }> {
    this.validate(input.tenantId, input.appConfigurationId, input.correlationId);
    this.validateEnvironment(input.environment);
    const runner = await this.database.getDataSource().then((source) => source.createQueryRunner());
    await runner.connect(); await runner.startTransaction();
    try {
      const id = randomUUID(); const now = this.sqlNow();
      await runner.query(
        `INSERT IGNORE INTO ca_meta_app_webhook_configs
         (id, tenant_id, app_configuration_id, provider, environment, desired_fields, observed_fields, observed_state, config_state, version, created_at, updated_at)
         VALUES (?, ?, ?, 'META', ?, ?, '[]', 'UNKNOWN', 'NOT_CONFIRMED', 1, ?, ?)`,
        [id, input.tenantId, input.appConfigurationId, input.environment, fieldsJson(input.desiredFields), now, now],
      );
      const rows = await runner.query(
        `SELECT id, version FROM ca_meta_app_webhook_configs WHERE tenant_id = ? AND app_configuration_id = ? AND provider = 'META' AND environment = ? FOR UPDATE`,
        [input.tenantId, input.appConfigurationId, input.environment],
      ) as Array<{ id: string; version: string | number }>;
      const row = rows[0]; if (!row) throw new Error('App webhook desired-state row was not created.');
      await runner.query(
        `UPDATE ca_meta_app_webhook_configs SET desired_fields = ?, config_state = 'NOT_CONFIRMED', version = version + 1, updated_at = ? WHERE tenant_id = ? AND id = ?`,
        [fieldsJson(input.desiredFields), now, input.tenantId, row.id],
      );
      await this.audit(runner, { tenantId: input.tenantId, appConfigurationId: input.appConfigurationId, environment: input.environment,
        action: 'APP_WEBHOOK_DESIRED_CHANGED', reasonCode: 'APP_LEVEL_ADAPTER_NOT_CONFIRMED', beforeVersion: Number(row.version),
        afterVersion: Number(row.version) + 1, correlationId: input.correlationId, actorRef: input.actorRef });
      const values = await runner.query(
        `SELECT desired_fields, observed_fields, version FROM ca_meta_app_webhook_configs WHERE tenant_id = ? AND id = ?`,
        [input.tenantId, row.id],
      ) as Array<{ desired_fields: string; observed_fields: string; version: string | number }>;
      await runner.commitTransaction();
      const value = values[0]!;
      return Object.freeze({ desiredFields: parseFields(value.desired_fields), observedFields: parseFields(value.observed_fields),
        state: 'NOT_CONFIRMED', version: Number(value.version) });
    } catch (error) { await runner.rollbackTransaction(); throw error; }
    finally { await runner.release(); }
  }

  private async readSnapshot(runner: QueryRunner, context: MetaSubscriptionTargetContext, targetId: string): Promise<MetaSubscriptionTargetSnapshot> {
    const rows = await runner.query(
      `SELECT id, desired_state, desired_fields, observed_state, observed_fields, reconcile_state, version, attempt_count,
              last_attempt_at, last_verified_at, next_attempt_at, last_safe_reason_code
       FROM ca_meta_subscription_targets WHERE tenant_id = ? AND id = ?`, [context.tenantId, targetId],
    ) as TargetRow[];
    const row = rows[0]; if (!row) throw new Error('Subscription target disappeared during transaction.');
    const bindings = await this.readBindings(runner, context.tenantId, targetId);
    return Object.freeze({ ...context, targetId: row.id, desiredState: row.desired_state, desiredFields: parseFields(row.desired_fields),
      observedState: row.observed_state, observedFields: parseFields(row.observed_fields), state: row.reconcile_state,
      version: Number(row.version), attemptCount: Number(row.attempt_count),
      lastAttemptAt: isoDate(row.last_attempt_at), lastVerifiedAt: isoDate(row.last_verified_at),
      lastErrorCode: row.last_safe_reason_code ?? null, nextAttemptAt: isoDate(row.next_attempt_at), bindings: Object.freeze(bindings) });
  }

  private async readBindings(runner: QueryRunner, tenantId: string, targetId: string): Promise<MetaSubscriptionTargetSnapshot['bindings']> {
    const rows = await runner.query(
      `SELECT asset_id, authorization_id, desired_fields, binding_state, version FROM ca_meta_subscription_bindings
       WHERE tenant_id = ? AND target_id = ? ORDER BY asset_id, authorization_id`, [tenantId, targetId],
    ) as BindingRow[];
    return Object.freeze(rows.map((row) => Object.freeze({ assetId: row.asset_id, authorizationId: row.authorization_id, desiredFields: parseFields(row.desired_fields),
      state: row.binding_state, version: Number(row.version) })));
  }

  private async audit(runner: QueryRunner, event: { readonly tenantId: string; readonly appConfigurationId: string;
    readonly environment: MetaSubscriptionTargetContext['environment'];
    readonly targetId?: string; readonly assetId?: string; readonly action: string; readonly reasonCode: string;
    readonly beforeVersion?: number; readonly afterVersion?: number; readonly correlationId: string; readonly actorRef: string }): Promise<void> {
    await runner.query(
      `INSERT INTO ca_meta_subscription_audit
       (id, tenant_id, app_configuration_id, provider, environment, target_id, asset_id, action, reason_code, before_version, after_version, actor_ref_hash, correlation_id, created_at)
       VALUES (?, ?, ?, 'META', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), event.tenantId, event.appConfigurationId, event.environment, event.targetId ?? null, event.assetId ?? null,
        event.action, event.reasonCode, event.beforeVersion ?? null, event.afterVersion ?? null,
        createHash('sha256').update(event.actorRef, 'utf8').digest('hex'), event.correlationId, this.sqlNow()],
    );
  }

  private sqlNow(): string { return this.now().toISOString().replace('T', ' ').replace('Z', '').slice(0, 23); }
  private validate(tenantId: string, appConfigurationId: string, ...ids: string[]): void {
    if (!UUID.test(tenantId) || !UUID.test(appConfigurationId) || ids.some((value) => !UUID.test(value))) throw new Error('Subscription scope is malformed.');
  }

  private validateEnvironment(value: string): void {
    if (value !== 'development' && value !== 'test' && value !== 'staging' && value !== 'production') {
      throw new Error('Subscription environment is malformed.');
    }
  }
}
