import { createHash, randomUUID } from 'node:crypto';
import type { QueryRunner } from 'typeorm';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { MetaSubscriptionClaim, MetaSubscriptionReconcileState,
  MetaSubscriptionState, MetaSubscriptionStore, MetaSubscriptionTargetContext, MetaSubscriptionTargetSnapshot } from './meta-subscriptions.types.js';

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_REASON = /^[A-Z][A-Z0-9_]{1,63}$/;
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

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

/** Durable per-WABA state. A single target row is the cross-process lock for every phone under a WABA. */
export class MysqlMetaSubscriptionStore implements MetaSubscriptionStore {
  constructor(private readonly database: DurableWorkDatabase, private readonly now: () => Date = () => new Date()) {}

  async ensureBinding(input: MetaSubscriptionTargetContext & { readonly desiredFields: readonly string[];
    readonly actorRef: string; readonly correlationId: string }): Promise<MetaSubscriptionTargetSnapshot> {
    this.validate(input.tenantId, input.appConfigurationId, input.authorizationId, input.targetAssetId, input.sourceAssetId, input.correlationId);
    this.validateEnvironment(input.environment);
    const runner = await this.database.getDataSource().then((source) => source.createQueryRunner());
    await runner.connect(); await runner.startTransaction();
    try {
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
    } catch (error) { await runner.rollbackTransaction(); throw error; }
    finally { await runner.release(); }
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
