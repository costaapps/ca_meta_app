import { createHash, randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import { AuditEventWriter, privacyRefHash } from '../privacy/audit.service.js';
import { MetaLifecycleCallbackReplayConflictError } from './connection-lifecycle.types.js';
import type {
  ConnectionLifecycleBinding,
  ConnectionLifecycleCommandStatus,
  ConnectionLifecycleCommandRepository,
  ConnectionLifecycleDisconnectResult,
  LifecycleCleanupState,
  MetaLifecycleCallbackProcessor,
  MetaLifecycleCallbackTargetResolver,
  TrustedMetaLifecycleCallback,
} from './connection-lifecycle.types.js';
import { isTrustedMetaLifecycleCallback } from './connection-lifecycle.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ENV = /^(development|test|staging|production)$/;

interface AuthorizationRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly app_configuration_id: string;
  readonly environment: string;
  readonly provider_authorization_id: string | null;
  readonly flow_variant: ConnectionLifecycleBinding['flowVariant'];
  readonly auth_variant: ConnectionLifecycleBinding['authVariant'];
  readonly authorization_state: ConnectionLifecycleBinding['authorizationState'];
  readonly version: number | string;
}

function affectedRows(value: unknown): number {
  if (Array.isArray(value)) return value.length > 0 ? affectedRows(value[0]) : 0;
  return typeof value === 'object' && value !== null && 'affectedRows' in value
    ? Number((value as { affectedRows?: number }).affectedRows ?? 0) : 0;
}

function counter(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('connection-lifecycle-count-invalid');
  return parsed;
}

function validTarget(target: Awaited<ReturnType<MetaLifecycleCallbackTargetResolver['resolve']>>): target is NonNullable<typeof target> {
  return !!target && /^[A-Za-z0-9._-]{1,96}$/.test(target.appConfigurationRef) &&
    UUID.test(target.tenantId) && UUID.test(target.authorizationId) && UUID.test(target.appConfigurationId) &&
    SAFE_ENV.test(target.environment);
}

function requestHash(input: { readonly tenantId: string; readonly authorizationId: string; readonly assetId: string | null; readonly operation: string }): string {
  return privacyRefHash([input.tenantId, input.authorizationId, input.assetId ?? 'AUTHORIZATION', input.operation].join('\0'));
}

function resultFromRow(row: { id: string; cleanup_state: LifecycleCleanupState; safe_reason_code: string }): ConnectionLifecycleDisconnectResult {
  const safeReasonCode = row.safe_reason_code === 'EXTERNAL_CLEANUP_PENDING' || row.safe_reason_code === 'EXTERNAL_CLEANUP_FAILED'
    ? row.safe_reason_code : 'PROVIDER_OFFBOARDING_NOT_CONFIRMED';
  return Object.freeze({ commandRef: row.id, localState: 'DISCONNECTED', cleanupState: row.cleanup_state, safeReasonCode });
}

export class MysqlConnectionLifecycleCommandRepository implements ConnectionLifecycleCommandRepository {
  constructor(private readonly database: DurableWorkDatabase, private readonly audit: AuditEventWriter) {}

  async findBinding(input: { readonly tenantId: string; readonly authorizationId: string }): Promise<ConnectionLifecycleBinding | undefined> {
    if (!UUID.test(input.tenantId) || !UUID.test(input.authorizationId)) return undefined;
    const dataSource = await this.database.getDataSource();
    const rows = await dataSource.query(
      `SELECT auth.id, auth.tenant_id, auth.app_configuration_id, auth.environment, auth.provider_authorization_id,
              auth.flow_variant, auth.auth_variant, auth.authorization_state, auth.version,
              (SELECT COUNT(*) FROM ca_meta_asset_authorizations aa WHERE aa.tenant_id = auth.tenant_id
                AND aa.authorization_id = auth.id AND aa.state = 'ACTIVE' AND aa.verification_state = 'VERIFIED') AS asset_bindings
       FROM ca_meta_authorizations auth
       WHERE auth.tenant_id = ? AND auth.id = ? AND auth.provider = 'META' LIMIT 1`,
      [input.tenantId, input.authorizationId],
    ) as Array<AuthorizationRow & { asset_bindings: number | string }>;
    const row = rows[0];
    if (!row || !UUID.test(row.app_configuration_id) || !SAFE_ENV.test(row.environment) ||
      !['ACTIVE', 'PARTIAL', 'REAUTH_REQUIRED', 'UNKNOWN', 'REVOKED', 'DISCONNECTED'].includes(row.authorization_state)) return undefined;
    return Object.freeze({
      tenantId: row.tenant_id,
      authorizationId: row.id,
      appConfigurationId: row.app_configuration_id,
      environment: row.environment,
      providerAuthorizationId: row.provider_authorization_id,
      flowVariant: row.flow_variant,
      authVariant: row.auth_variant,
      authorizationState: row.authorization_state,
      authorizationVersion: counter(row.version),
      assetBindings: counter(row.asset_bindings),
    });
  }

  async findStatus(input: { readonly tenantId: string; readonly commandRef: string }): Promise<ConnectionLifecycleCommandStatus | undefined> {
    if (!UUID.test(input.tenantId) || !UUID.test(input.commandRef)) return undefined;
    const dataSource = await this.database.getDataSource();
    const rows = await dataSource.query(
      `SELECT id, operation, local_state, cleanup_state, safe_reason_code, created_at, updated_at
       FROM ca_meta_connection_lifecycle_commands
       WHERE tenant_id = ? AND (id = ? OR onboarding_session_id = ?) LIMIT 1`,
      [input.tenantId, input.commandRef, input.commandRef],
    ) as Array<{ id: string; operation: string; local_state: string; cleanup_state: string | null;
      safe_reason_code: string | null; created_at: Date | string; updated_at: Date | string }>;
    const row = rows[0];
    if (!row || !['DISCONNECT_ASSET', 'DISCONNECT_AUTHORIZATION', 'REAUTHORIZE'].includes(row.operation) ||
      !['DISCONNECTED', 'SESSION_CREATED'].includes(row.local_state)) return undefined;
    const cleanupState = row.cleanup_state && ['BLOCKED', 'PENDING', 'FAILED', 'UNKNOWN', 'CONFIRMED'].includes(row.cleanup_state)
      ? row.cleanup_state as LifecycleCleanupState : null;
    const safeReasonCode = row.safe_reason_code &&
      ['PROVIDER_OFFBOARDING_NOT_CONFIRMED', 'EXTERNAL_CLEANUP_PENDING', 'EXTERNAL_CLEANUP_FAILED'].includes(row.safe_reason_code)
      ? row.safe_reason_code as ConnectionLifecycleCommandStatus['safeReasonCode'] : null;
    if ((row.operation === 'REAUTHORIZE' && (cleanupState !== null || safeReasonCode !== null || row.local_state !== 'SESSION_CREATED')) ||
      (row.operation !== 'REAUTHORIZE' && (!cleanupState || !safeReasonCode || row.local_state !== 'DISCONNECTED'))) return undefined;
    const createdAt = new Date(row.created_at);
    const updatedAt = new Date(row.updated_at);
    if (!Number.isFinite(createdAt.getTime()) || !Number.isFinite(updatedAt.getTime())) throw new Error('connection-lifecycle-status-invalid');
    return Object.freeze({
      commandRef: row.id,
      operation: row.operation as ConnectionLifecycleCommandStatus['operation'],
      localState: row.local_state as ConnectionLifecycleCommandStatus['localState'],
      cleanupState,
      safeReasonCode,
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
  }

  async disconnect(input: {
    readonly tenantId: string;
    readonly actorRef: string;
    readonly authorizationId: string;
    readonly assetId: string | null;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<ConnectionLifecycleDisconnectResult> {
    if (![input.tenantId, input.authorizationId, input.actorRef, input.correlationId].every((value) => UUID.test(value)) ||
      (input.assetId !== null && !UUID.test(input.assetId)) || !/^[A-Za-z0-9._~-]{16,128}$/.test(input.idempotencyKey)) {
      throw new Error('connection-lifecycle-disconnect-invalid');
    }
    const database = await this.database.getDataSource();
    const actorHash = privacyRefHash(input.actorRef);
    const idempotencyHash = privacyRefHash(input.idempotencyKey);
    const operation = input.assetId === null ? 'DISCONNECT_AUTHORIZATION' : 'DISCONNECT_ASSET';
    const expectedHash = requestHash({ ...input, operation });
    return database.transaction(async (manager) => {
      const priorRows = await manager.query(
        `SELECT id, request_hash, cleanup_state, safe_reason_code
         FROM ca_meta_connection_lifecycle_commands
         WHERE tenant_id = ? AND actor_ref_hash = ? AND idempotency_key_hash = ? FOR UPDATE`,
        [input.tenantId, actorHash, idempotencyHash],
      ) as Array<{ id: string; request_hash: string; cleanup_state: LifecycleCleanupState; safe_reason_code: string }>;
      const prior = priorRows[0];
      if (prior) {
        if (prior.request_hash !== expectedHash) throw new Error('connection-lifecycle-idempotency-conflict');
        return resultFromRow(prior);
      }

      const authRows = await manager.query(
        `SELECT id, tenant_id, app_configuration_id, environment, authorization_state, version
         FROM ca_meta_authorizations WHERE tenant_id = ? AND id = ? AND provider = 'META' FOR UPDATE`,
        [input.tenantId, input.authorizationId],
      ) as Array<{ id: string; tenant_id: string; app_configuration_id: string; environment: string; authorization_state: string; version: number | string }>;
      const auth = authRows[0];
      if (!auth) throw new Error('connection-lifecycle-not-found');
      if (!UUID.test(auth.app_configuration_id) || !SAFE_ENV.test(auth.environment)) throw new Error('connection-lifecycle-binding-invalid');

      const bindings = await manager.query(
        `SELECT asset_id, verification_state, state FROM ca_meta_asset_authorizations
         WHERE tenant_id = ? AND authorization_id = ? AND state = 'ACTIVE'
         ORDER BY asset_id FOR UPDATE`,
        [input.tenantId, input.authorizationId],
      ) as Array<{ asset_id: string; verification_state: string; state: string }>;
      if (input.assetId === null && bindings.filter((row) => row.verification_state === 'VERIFIED').length > 1) {
        throw new Error('connection-lifecycle-scope-required');
      }
      if (input.assetId !== null && !bindings.some((row) => row.asset_id === input.assetId && row.verification_state === 'VERIFIED')) {
        throw new Error('connection-lifecycle-not-found');
      }

      if (input.assetId !== null) {
        await manager.query(
          `UPDATE ca_meta_asset_authorizations SET state = 'REVOKED', version = version + 1, updated_at = UTC_TIMESTAMP(6)
           WHERE tenant_id = ? AND authorization_id = ? AND asset_id = ? AND state = 'ACTIVE'`,
          [input.tenantId, input.authorizationId, input.assetId],
        );
        const stillActive = await manager.query(
          `SELECT COUNT(*) AS active_count FROM ca_meta_asset_authorizations
           WHERE tenant_id = ? AND authorization_id = ? AND state = 'ACTIVE' AND verification_state = 'VERIFIED'`,
          [input.tenantId, input.authorizationId],
        ) as Array<{ active_count: number | string }>;
        if (counter(stillActive[0]?.active_count ?? 0) === 0) {
          await manager.query(
            `UPDATE ca_meta_authorizations SET authorization_state = 'DISCONNECTED', version = version + 1,
               updated_at = UTC_TIMESTAMP(6) WHERE tenant_id = ? AND id = ? AND authorization_state NOT IN ('REVOKED', 'DISCONNECTED')`,
            [input.tenantId, input.authorizationId],
          );
        }
      } else {
        await manager.query(
          `UPDATE ca_meta_authorizations SET authorization_state = 'DISCONNECTED', version = version + 1,
             updated_at = UTC_TIMESTAMP(6) WHERE tenant_id = ? AND id = ? AND authorization_state NOT IN ('REVOKED', 'DISCONNECTED')`,
          [input.tenantId, input.authorizationId],
        );
        await manager.query(
          `UPDATE ca_meta_asset_authorizations SET state = 'REVOKED', version = version + 1, updated_at = UTC_TIMESTAMP(6)
           WHERE tenant_id = ? AND authorization_id = ? AND state = 'ACTIVE'`,
          [input.tenantId, input.authorizationId],
        );
      }

      const id = randomUUID();
      await this.audit.record({
        tenantId: input.tenantId,
        actorRef: input.actorRef,
        action: input.assetId === null ? 'AUTHORIZATION_DISCONNECTED' : 'ASSET_OPERATION',
        targetRef: input.authorizationId,
        correlationId: input.correlationId,
        retentionClass: 'SECURITY',
        safeDiff: {
          operation: input.assetId === null ? 'AUTHORIZATION_DISCONNECTED_LOCALLY' : 'ASSET_BINDING_DISCONNECTED_LOCALLY',
          scope: input.assetId === null ? 'AUTHORIZATION' : 'ASSET',
          assetRefHash: input.assetId === null ? null : privacyRefHash(input.assetId),
          providerCleanup: 'BLOCKED_NOT_CONFIRMED',
        },
      }, manager);
      await manager.query(
        `INSERT INTO ca_meta_connection_lifecycle_commands
         (id, tenant_id, actor_ref_hash, authorization_id, asset_id, onboarding_session_id, operation,
          idempotency_key_hash, request_hash, local_state, cleanup_state, safe_reason_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'DISCONNECTED', 'BLOCKED', 'PROVIDER_OFFBOARDING_NOT_CONFIRMED',
           UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
        [id, input.tenantId, actorHash, input.authorizationId, input.assetId, operation, idempotencyHash, expectedHash],
      );
      return Object.freeze({ commandRef: id, localState: 'DISCONNECTED', cleanupState: 'BLOCKED',
        safeReasonCode: 'PROVIDER_OFFBOARDING_NOT_CONFIRMED' });
    });
  }

  async associateReauthorization(input: {
    readonly tenantId: string;
    readonly actorRef: string;
    readonly authorizationId: string;
    readonly onboardingSessionId: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<void> {
    if (![input.tenantId, input.actorRef, input.authorizationId, input.onboardingSessionId].every((value) => UUID.test(value)) ||
      !UUID.test(input.correlationId) || !/^[A-Za-z0-9._~-]{16,128}$/.test(input.idempotencyKey)) {
      throw new Error('connection-lifecycle-reauthorization-invalid');
    }
    const database = await this.database.getDataSource();
    const actorHash = privacyRefHash(input.actorRef);
    const idempotencyHash = privacyRefHash(input.idempotencyKey);
    const expectedHash = requestHash({ tenantId: input.tenantId, authorizationId: input.authorizationId,
      assetId: input.onboardingSessionId, operation: 'REAUTHORIZE' });
    await database.transaction(async (manager) => {
      const priorRows = await manager.query(
        `SELECT id, request_hash FROM ca_meta_connection_lifecycle_commands
         WHERE tenant_id = ? AND actor_ref_hash = ? AND idempotency_key_hash = ? FOR UPDATE`,
        [input.tenantId, actorHash, idempotencyHash],
      ) as Array<{ id: string; request_hash: string }>;
      const prior = priorRows[0];
      if (prior) {
        if (prior.request_hash !== expectedHash) throw new Error('connection-lifecycle-idempotency-conflict');
        return;
      }
      const binding = await manager.query(
        `SELECT id FROM ca_meta_authorizations WHERE tenant_id = ? AND id = ? FOR UPDATE`,
        [input.tenantId, input.authorizationId],
      ) as Array<{ id: string }>;
      if (!binding[0]) throw new Error('connection-lifecycle-not-found');
      const session = await manager.query(
        `SELECT id FROM ca_meta_onboarding_sessions WHERE tenant_id = ? AND id = ?`,
        [input.tenantId, input.onboardingSessionId],
      ) as Array<{ id: string }>;
      if (!session[0]) throw new Error('connection-lifecycle-onboarding-session-not-found');
      const id = randomUUID();
      await this.audit.record({
        tenantId: input.tenantId,
        actorRef: input.actorRef,
        action: 'ASSET_OPERATION',
        targetRef: input.authorizationId,
        correlationId: input.correlationId,
        retentionClass: 'SECURITY',
        safeDiff: { operation: 'REAUTHORIZATION_STARTED', onboardingSessionRefHash: privacyRefHash(input.onboardingSessionId), priorGrantPreserved: true },
      }, manager);
      await manager.query(
        `INSERT INTO ca_meta_connection_lifecycle_commands
         (id, tenant_id, actor_ref_hash, authorization_id, asset_id, onboarding_session_id, operation,
          idempotency_key_hash, request_hash, local_state, cleanup_state, safe_reason_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, 'REAUTHORIZE', ?, ?, 'SESSION_CREATED', NULL, NULL, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
        [id, input.tenantId, actorHash, input.authorizationId, input.onboardingSessionId, idempotencyHash, expectedHash],
      );
    });
  }
}

export class FailClosedMetaLifecycleCallbackTargetResolver implements MetaLifecycleCallbackTargetResolver {
  async resolve(): Promise<undefined> { return undefined; }
}

/** Applies only server-mapped, verifier-branded lifecycle callbacks. The verifier and target mapping are not enabled by default. */
export class MysqlMetaLifecycleCallbackProcessor implements MetaLifecycleCallbackProcessor {
  constructor(
    private readonly database: DurableWorkDatabase,
    private readonly audit: AuditEventWriter,
    private readonly targets: MetaLifecycleCallbackTargetResolver,
  ) {}

  async process(callback: TrustedMetaLifecycleCallback): Promise<'APPLIED' | 'DUPLICATE' | 'UNMAPPED'> {
    if (!isTrustedMetaLifecycleCallback(callback)) throw new Error('meta-lifecycle-callback-untrusted');
    const target = await this.targets.resolve(callback);
    if (target && (!validTarget(target) || target.appConfigurationRef !== callback.appConfigurationRef)) {
      throw new Error('meta-lifecycle-callback-target-invalid');
    }
    const appRefHash = privacyRefHash(callback.appConfigurationRef);
    const payloadHash = privacyRefHash(`${callback.kind}\0${callback.subjectRefHash}`);
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => {
      const priorRows = await manager.query(
        `SELECT callback_kind, payload_ref_hash, receipt_state FROM ca_meta_lifecycle_callback_receipts
         WHERE app_configuration_ref_hash = ? AND event_ref_hash = ? FOR UPDATE`,
        [appRefHash, callback.eventRefHash],
      ) as Array<{ callback_kind: string; payload_ref_hash: string; receipt_state: 'RECEIVED' | 'APPLIED' | 'UNMAPPED' }>;
      const prior = priorRows[0];
      if (prior && (prior.callback_kind !== callback.kind || prior.payload_ref_hash !== payloadHash)) {
        throw new MetaLifecycleCallbackReplayConflictError();
      }
      if (prior?.receipt_state === 'APPLIED') return 'DUPLICATE';
      if (!prior) {
        await manager.query(
          `INSERT INTO ca_meta_lifecycle_callback_receipts
           (app_configuration_ref_hash, event_ref_hash, payload_ref_hash, callback_kind, receipt_state, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'RECEIVED', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
          [appRefHash, callback.eventRefHash, payloadHash, callback.kind],
        );
      }
      if (!target) {
        await manager.query(
          `UPDATE ca_meta_lifecycle_callback_receipts SET receipt_state = 'UNMAPPED', updated_at = UTC_TIMESTAMP(6)
           WHERE app_configuration_ref_hash = ? AND event_ref_hash = ?`, [appRefHash, callback.eventRefHash],
        );
        return 'UNMAPPED';
      }
      const authRows = await manager.query(
        `SELECT id, authorization_state FROM ca_meta_authorizations
         WHERE tenant_id = ? AND id = ? AND app_configuration_id = ? AND environment = ? AND provider = 'META' FOR UPDATE`,
        [target.tenantId, target.authorizationId, target.appConfigurationId, target.environment],
      ) as Array<{ id: string; authorization_state: string }>;
      if (!authRows[0]) {
        await manager.query(
          `UPDATE ca_meta_lifecycle_callback_receipts SET receipt_state = 'UNMAPPED', updated_at = UTC_TIMESTAMP(6)
           WHERE app_configuration_ref_hash = ? AND event_ref_hash = ?`, [appRefHash, callback.eventRefHash],
        );
        return 'UNMAPPED';
      }
      if (callback.kind === 'DEAUTHORIZATION') await this.applyDeauthorization(manager, callback, target);
      else await this.recordDataDeletion(manager, callback, target);
      await manager.query(
        `UPDATE ca_meta_lifecycle_callback_receipts SET receipt_state = 'APPLIED', updated_at = UTC_TIMESTAMP(6)
         WHERE app_configuration_ref_hash = ? AND event_ref_hash = ?`, [appRefHash, callback.eventRefHash],
      );
      return 'APPLIED';
    });
  }

  private async applyDeauthorization(manager: EntityManager, callback: TrustedMetaLifecycleCallback,
    target: NonNullable<Awaited<ReturnType<MetaLifecycleCallbackTargetResolver['resolve']>>>): Promise<void> {
    await manager.query(
      `UPDATE ca_meta_authorizations SET authorization_state = 'REVOKED', version = version + 1, updated_at = UTC_TIMESTAMP(6)
       WHERE tenant_id = ? AND id = ? AND app_configuration_id = ? AND environment = ?
         AND authorization_state NOT IN ('REVOKED', 'DISCONNECTED')`,
      [target.tenantId, target.authorizationId, target.appConfigurationId, target.environment],
    );
    await manager.query(
      `UPDATE ca_meta_credentials SET status = 'REVOKED', revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP(6)),
         version = version + 1, updated_at = UTC_TIMESTAMP(6)
       WHERE tenant_id = ? AND authorization_id = ? AND app_configuration_id = ? AND environment = ? AND status = 'ACTIVE'`,
      [target.tenantId, target.authorizationId, target.appConfigurationId, target.environment],
    );
    await manager.query(
      `UPDATE ca_meta_asset_authorizations SET state = 'REVOKED', version = version + 1, updated_at = UTC_TIMESTAMP(6)
       WHERE tenant_id = ? AND authorization_id = ? AND app_configuration_id = ? AND environment = ? AND state = 'ACTIVE'`,
      [target.tenantId, target.authorizationId, target.appConfigurationId, target.environment],
    );
    await manager.query(
      `UPDATE ca_meta_asset_grants SET status = 'REVOKED', source = 'SIGNED_WEBHOOK', observed_at = UTC_TIMESTAMP(6), version = version + 1
       WHERE tenant_id = ? AND authorization_id = ? AND app_configuration_id = ? AND environment = ? AND status = 'GRANTED'`,
      [target.tenantId, target.authorizationId, target.appConfigurationId, target.environment],
    );
    await manager.query(
      `UPDATE ca_meta_credential_lifecycle SET health_state = 'REVOKED', health_source = 'SIGNED_WEBHOOK',
         health_observed_at = UTC_TIMESTAMP(6), last_checked_at = UTC_TIMESTAMP(6), last_safe_reason_code = 'PERMISSION_REVOKED',
         version = version + 1, updated_at = UTC_TIMESTAMP(6)
       WHERE tenant_id = ? AND authorization_id = ? AND app_configuration_id = ? AND environment = ?`,
      [target.tenantId, target.authorizationId, target.appConfigurationId, target.environment],
    );
    await manager.query(
      `UPDATE ca_meta_job_attempts AS attempt
       JOIN ca_meta_jobs AS job ON job.tenant_id = attempt.tenant_id AND job.id = attempt.job_id
       JOIN ca_meta_credentials credential ON credential.tenant_id = job.tenant_id
         AND credential.id = job.resource_scope_ref
       SET attempt.outcome = 'FAILED', attempt.safe_error_code = 'CREDENTIAL_REVOKED',
         attempt.safe_error_action = 'REAUTHORIZE', attempt.finished_at = UTC_TIMESTAMP(6),
         attempt.duration_ms = TIMESTAMPDIFF(MICROSECOND, attempt.started_at, UTC_TIMESTAMP(6)) DIV 1000
       WHERE job.tenant_id = ? AND job.job_type = 'CREDENTIAL_INSPECTION' AND job.status IN ('QUEUED', 'RETRY_PENDING')
         AND credential.authorization_id = ? AND credential.app_configuration_id = ? AND credential.environment = ?
         AND attempt.outcome = 'RETRY_PENDING'`,
      [target.tenantId, target.authorizationId, target.appConfigurationId, target.environment],
    );
    await manager.query(
      `UPDATE ca_meta_jobs SET status = 'FAILED', last_safe_error_code = 'CREDENTIAL_REVOKED',
         last_safe_error_action = 'REAUTHORIZE', completed_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)
       WHERE tenant_id = ? AND job_type = 'CREDENTIAL_INSPECTION' AND status IN ('QUEUED', 'RETRY_PENDING')
         AND resource_scope_ref IN (SELECT id FROM ca_meta_credentials WHERE tenant_id = ? AND authorization_id = ?
           AND app_configuration_id = ? AND environment = ?)`,
      [target.tenantId, target.tenantId, target.authorizationId, target.appConfigurationId, target.environment],
    );
    await this.audit.record({
      tenantId: target.tenantId, actorRef: 'meta_lifecycle_callback', action: 'AUTHORIZATION_DISCONNECTED',
      targetRef: target.authorizationId, correlationId: callback.eventRefHash,
      retentionClass: 'SECURITY', safeDiff: { source: 'SIGNED_WEBHOOK', eventKind: 'DEAUTHORIZATION' },
    }, manager);
  }

  private async recordDataDeletion(manager: EntityManager, callback: TrustedMetaLifecycleCallback,
    target: NonNullable<Awaited<ReturnType<MetaLifecycleCallbackTargetResolver['resolve']>>>): Promise<void> {
    const targetHash = privacyRefHash(target.authorizationId);
    const priorTombstones = await manager.query(
      `SELECT request_id FROM ca_meta_deletion_tombstones WHERE tenant_id = ? AND scope = 'AUTHORIZATION' AND target_ref_hash = ? FOR UPDATE`,
      [target.tenantId, targetHash],
    ) as Array<{ request_id: string }>;
    if (priorTombstones[0]) return;

    const requestId = randomUUID();
    const requestHashValue = privacyRefHash([target.tenantId, targetHash, 'AUTHORIZATION', 'PRIVACY_REQUEST'].join('\0'));
    const evidenceRef = await this.audit.record({
      tenantId: target.tenantId, actorRef: 'meta_data_deletion_callback', action: 'DELETION_REQUESTED',
      targetRef: requestId, correlationId: callback.eventRefHash, retentionClass: 'DELETION',
      safeDiff: { status: 'RECEIVED', reasonCode: 'PROVIDER_CALLBACK', scope: 'AUTHORIZATION' },
    }, manager);
    await manager.query(
      `INSERT INTO ca_meta_deletion_requests
       (id, tenant_id, requester_ref_hash, target_ref_hash, scope, reason_code, status, idempotency_key,
        request_hash, evidence_ref, requested_at, updated_at)
       VALUES (?, ?, ?, ?, 'AUTHORIZATION', 'PRIVACY_REQUEST', 'RECEIVED', ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
      [requestId, target.tenantId, privacyRefHash('meta_data_deletion_callback'), targetHash,
        callbackUuid(callback.eventRefHash), requestHashValue, evidenceRef],
    );
    await manager.query(
      `INSERT INTO ca_meta_deletion_tombstones (id, tenant_id, request_id, target_ref_hash, scope, created_at)
       VALUES (?, ?, ?, ?, 'AUTHORIZATION', UTC_TIMESTAMP(6))`,
      [randomUUID(), target.tenantId, requestId, targetHash],
    );
  }
}

function callbackUuid(hash: string): string {
  const compact = hash.slice(0, 32);
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-4${compact.slice(13, 16)}-8${compact.slice(17, 20)}-${compact.slice(20, 32)}`;
}
