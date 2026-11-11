import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createPool, type Pool, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import type { ApiEnvironment } from '../config/environment.js';
import { OnboardingCoexistenceActiveSessionConflictError } from './onboarding-session.types.js';
import type {
  OnboardingCreateCommand,
  OnboardingFlowVariant,
  OnboardingNextAction,
  OnboardingProviderOutcome,
  OnboardingReadiness,
  OnboardingSessionStore,
  OnboardingStatusName,
  OnboardingStep,
  OnboardingStoredRecord,
} from './onboarding-session.types.js';
import { isSafePhoneReadiness, type OnboardingPhoneReadiness } from './onboarding-phone-readiness.js';

interface OnboardingRow extends RowDataPacket {
  id: string;
  tenant_id: string;
  principal_id: string;
  portal_session_id: string;
  tenant_context_hash: string;
  flow_variant: string;
  configuration_ref: string;
  provider_app_id: string;
  provider_environment: string;
  auth_variant: string;
  capability_manifest_version: string;
  graph_api_version: string;
  requested_capabilities: unknown;
  return_route: string;
  idempotency_key_hash: string;
  request_hash: string;
  provider_state_hash: string;
  expires_at: string | Date;
  status: string;
  readiness: string;
  steps_json: unknown;
  saga_checkpoint_json?: unknown;
  next_action: string;
  last_updated_at: string | Date;
  provider_state_consumed_at: string | Date | null;
}

const STATUS_VALUES = new Set<OnboardingStatusName>([
  'CREATED', 'AWAITING_PROVIDER', 'CODE_RECEIVED', 'EXCHANGING', 'ASSETS_VERIFIED',
  'PROVISIONING', 'READY', 'PARTIAL', 'CANCELLED', 'EXPIRED', 'FAILED',
]);
const READINESS_VALUES = new Set<OnboardingReadiness>(['READY', 'PARTIAL', 'UNKNOWN']);
const NEXT_ACTION_VALUES = new Set<OnboardingNextAction>([
  'WAIT', 'CHECK_STATUS', 'REAUTHORIZE', 'RECONCILE', 'RESUME', 'RESOLVE_CONFLICT', 'NONE',
]);
const FLOW_VALUES = new Set<OnboardingFlowVariant>([
  'FACEBOOK_LOGIN', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN', 'WHATSAPP_CLOUD_API', 'WHATSAPP_COEXISTENCE',
]);
const PROVIDER_ENVIRONMENTS = new Set(['development', 'test', 'staging', 'production']);
const STEP_STATUSES = new Set<OnboardingStep['status']>([
  'PENDING', 'RUNNING', 'SUCCEEDED', 'RETRY_PENDING', 'FAILED', 'UNKNOWN', 'SKIPPED',
]);

function dateValue(value: string | Date): Date {
  if (value instanceof Date) return new Date(value.getTime());
  const parsed = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Onboarding persistence returned an invalid timestamp.');
  return parsed;
}

function jsonArray<T>(value: unknown, validate: (entry: unknown) => entry is T): readonly T[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { throw new Error('Onboarding persistence returned invalid JSON.'); }
  }
  if (!Array.isArray(parsed) || !parsed.every(validate)) throw new Error('Onboarding persistence returned malformed data.');
  return Object.freeze(parsed.map((entry) => Object.freeze({ ...entry }) as T));
}

function isCapability(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
}

function isStep(value: unknown): value is OnboardingStep {
  return typeof value === 'object' && value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    (value as { name: string }).name.length > 0 && (value as { name: string }).name.length <= 64 &&
    STEP_STATUSES.has((value as { status: OnboardingStep['status'] }).status);
}

function checkpointPhoneReadiness(value: unknown, flowVariant: OnboardingFlowVariant): readonly OnboardingPhoneReadiness[] | undefined {
  let checkpoint: unknown = value;
  if (typeof checkpoint === 'string') {
    try { checkpoint = JSON.parse(checkpoint); } catch { throw new Error('Onboarding persistence returned invalid checkpoint JSON.'); }
  } else if (Buffer.isBuffer(checkpoint)) {
    try { checkpoint = JSON.parse(checkpoint.toString('utf8')); } catch { throw new Error('Onboarding persistence returned invalid checkpoint JSON.'); }
  }
  if (checkpoint === undefined || checkpoint === null) return undefined;
  if (typeof checkpoint !== 'object' || Array.isArray(checkpoint)) throw new Error('Onboarding persistence returned malformed checkpoint data.');
  const readiness = (checkpoint as Record<string, unknown>)['phoneReadiness'];
  if (readiness === undefined) return undefined;
  if (!isSafePhoneReadiness(readiness, flowVariant)) throw new Error('Onboarding persistence returned unsafe phone readiness.');
  return Object.freeze(readiness.map((item) => Object.freeze({ ...item })));
}

function mapRecord(row: OnboardingRow): OnboardingStoredRecord {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(row.id) || !FLOW_VALUES.has(row.flow_variant as OnboardingFlowVariant) ||
    !STATUS_VALUES.has(row.status as OnboardingStatusName) || !READINESS_VALUES.has(row.readiness as OnboardingReadiness) ||
    !NEXT_ACTION_VALUES.has(row.next_action as OnboardingNextAction) || !/^[a-f0-9]{64}$/.test(row.tenant_context_hash) ||
    !/^[a-f0-9]{64}$/.test(row.idempotency_key_hash) || !/^[a-f0-9]{64}$/.test(row.request_hash) ||
    !/^[a-f0-9]{64}$/.test(row.provider_state_hash) || !/^[A-Za-z0-9._-]{1,96}$/.test(row.configuration_ref) ||
    (row.provider_app_id !== 'unbound' && !/^[A-Za-z0-9._:-]{1,512}$/.test(row.provider_app_id)) ||
    (row.provider_environment !== 'unbound' && !PROVIDER_ENVIRONMENTS.has(row.provider_environment)) ||
    ((row.provider_app_id === 'unbound') !== (row.provider_environment === 'unbound')) ||
    !['FACEBOOK_LOGIN_FOR_BUSINESS', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN', 'WHATSAPP_EMBEDDED_SIGNUP',
      'WHATSAPP_BUSINESS_APP_ONBOARDING'].includes(row.auth_variant) ||
    !/^[A-Za-z0-9._-]{1,96}$/.test(row.capability_manifest_version) || !/^v[0-9]{1,2}\.[0-9]{1,3}$/.test(row.graph_api_version) ||
    (row.return_route !== 'connections' && row.return_route !== 'setup')) {
    throw new Error('Onboarding persistence returned a malformed record.');
  }
  const phoneReadiness = checkpointPhoneReadiness(row.saga_checkpoint_json, row.flow_variant as OnboardingFlowVariant);
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    portalSessionId: row.portal_session_id,
    tenantContextHash: row.tenant_context_hash,
    flowVariant: row.flow_variant as OnboardingFlowVariant,
    configurationRef: row.configuration_ref,
    providerAppId: row.provider_app_id === 'unbound' ? undefined : row.provider_app_id,
    providerEnvironment: row.provider_environment === 'unbound' ? undefined : row.provider_environment as OnboardingStoredRecord['providerEnvironment'],
    authVariant: row.auth_variant as OnboardingStoredRecord['authVariant'],
    capabilityManifestVersion: row.capability_manifest_version,
    graphApiVersion: row.graph_api_version,
    requestedCapabilities: jsonArray(row.requested_capabilities, isCapability),
    returnRoute: row.return_route,
    idempotencyHash: row.idempotency_key_hash,
    requestHash: row.request_hash,
    providerStateHash: row.provider_state_hash,
    expiresAt: dateValue(row.expires_at),
    status: row.status as OnboardingStatusName,
    readiness: row.readiness as OnboardingReadiness,
    steps: jsonArray(row.steps_json, isStep),
    ...(phoneReadiness ? { phoneReadiness } : {}),
    nextAction: row.next_action as OnboardingNextAction,
    lastUpdatedAt: dateValue(row.last_updated_at),
    stateConsumed: row.provider_state_consumed_at !== null,
  });
}

@Injectable()
export class MysqlOnboardingSessionStore implements OnboardingSessionStore, OnApplicationShutdown {
  private readonly pool: Pool;

  constructor(database: ApiEnvironment['database']) {
    this.pool = createPool({
      host: database.host,
      port: database.port,
      database: database.name,
      user: database.user,
      password: database.password,
      connectTimeout: database.connectTimeoutMs,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 20,
      charset: 'utf8mb4',
      timezone: 'Z',
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
  }

  async findByIdempotency(tenantId: string, idempotencyHash: string): Promise<OnboardingStoredRecord | undefined> {
    await this.pool.execute<ResultSetHeader>(
      `UPDATE ca_meta_onboarding_sessions SET status = 'EXPIRED', readiness = 'UNKNOWN', next_action = 'NONE',
         provider_state_consumed_at = COALESCE(provider_state_consumed_at, UTC_TIMESTAMP(6)),
         last_updated_at = UTC_TIMESTAMP(6), version = version + 1
       WHERE tenant_id = ? AND idempotency_key_hash = ? AND expires_at <= UTC_TIMESTAMP(6)
         AND status IN ('CREATED', 'AWAITING_PROVIDER', 'CODE_RECEIVED', 'EXCHANGING', 'ASSETS_VERIFIED', 'PROVISIONING')`,
      [tenantId, idempotencyHash],
    );
    const [rows] = await this.pool.execute<OnboardingRow[]>(
      `SELECT id, tenant_id, principal_id, portal_session_id, tenant_context_hash, flow_variant,
              configuration_ref, provider_app_id, provider_environment, auth_variant, capability_manifest_version, graph_api_version,
              requested_capabilities, return_route, idempotency_key_hash, request_hash, provider_state_hash,
              expires_at, status, readiness, steps_json, next_action, last_updated_at, provider_state_consumed_at
       FROM ca_meta_onboarding_sessions WHERE tenant_id = ? AND idempotency_key_hash = ? LIMIT 1`,
      [tenantId, idempotencyHash],
    );
    return rows[0] ? mapRecord(rows[0]) : undefined;
  }

  async createOrReplay(command: OnboardingCreateCommand): Promise<OnboardingStoredRecord> {
    const connection = await this.pool.getConnection();
    let committed = false;
    try {
      await connection.beginTransaction();
      const [tenantRows] = await connection.execute<Array<{ id: string } & RowDataPacket>>(
        'SELECT id FROM ca_meta_tenants WHERE id = ? FOR UPDATE', [command.tenantId],
      );
      if (!tenantRows[0]) throw new Error('Onboarding tenant disappeared before session creation.');

      const [existingRows] = await connection.execute<OnboardingRow[]>(
        `SELECT id, tenant_id, principal_id, portal_session_id, tenant_context_hash, flow_variant,
                configuration_ref, provider_app_id, provider_environment, auth_variant,
                capability_manifest_version, graph_api_version, requested_capabilities, return_route,
                idempotency_key_hash, request_hash, provider_state_hash, expires_at, status, readiness,
                steps_json, saga_checkpoint_json, next_action, last_updated_at, provider_state_consumed_at
         FROM ca_meta_onboarding_sessions WHERE tenant_id = ? AND idempotency_key_hash = ? LIMIT 1`,
        [command.tenantId, command.idempotencyHash],
      );
      if (existingRows[0]) {
        await connection.commit();
        committed = true;
        return mapRecord(existingRows[0]);
      }

      if (command.flowVariant === 'WHATSAPP_COEXISTENCE') {
        await connection.execute<ResultSetHeader>(
          `UPDATE ca_meta_onboarding_sessions
           SET status = 'EXPIRED', readiness = 'UNKNOWN', next_action = 'NONE',
               provider_state_consumed_at = COALESCE(provider_state_consumed_at, UTC_TIMESTAMP(6)),
               last_updated_at = UTC_TIMESTAMP(6), version = version + 1
           WHERE tenant_id = ? AND flow_variant = 'WHATSAPP_COEXISTENCE' AND expires_at <= UTC_TIMESTAMP(6)
             AND status IN ('CREATED','AWAITING_PROVIDER','CODE_RECEIVED','EXCHANGING','ASSETS_VERIFIED','PROVISIONING','PARTIAL')`,
          [command.tenantId],
        );
        const [activeRows] = await connection.execute<Array<{ id: string; expires_at: string | Date } & RowDataPacket>>(
          `SELECT id, expires_at FROM ca_meta_onboarding_sessions
           WHERE tenant_id = ? AND flow_variant = 'WHATSAPP_COEXISTENCE'
             AND status IN ('CREATED','AWAITING_PROVIDER','CODE_RECEIVED','EXCHANGING','ASSETS_VERIFIED','PROVISIONING','PARTIAL')
             AND expires_at > UTC_TIMESTAMP(6)
           ORDER BY created_at, id LIMIT 1 FOR UPDATE`,
          [command.tenantId],
        );
        if (activeRows[0]) {
          await connection.execute<ResultSetHeader>(
            `INSERT IGNORE INTO ca_meta_onboarding_coexistence_locks
              (tenant_id, onboarding_session_id, expires_at, created_at)
             VALUES (?, ?, ?, UTC_TIMESTAMP(6))`,
            [command.tenantId, activeRows[0].id, activeRows[0].expires_at],
          );
          await connection.commit();
          committed = true;
          throw new OnboardingCoexistenceActiveSessionConflictError();
        }
        await connection.execute<ResultSetHeader>(
          'DELETE FROM ca_meta_onboarding_coexistence_locks WHERE tenant_id = ?', [command.tenantId],
        );
      }

      await connection.execute<ResultSetHeader>(
        `INSERT INTO ca_meta_onboarding_sessions
          (id, tenant_id, principal_id, portal_session_id, tenant_context_hash, flow_variant,
           configuration_ref, provider_app_id, provider_environment, auth_variant, capability_manifest_version, graph_api_version,
           requested_capabilities, return_route, idempotency_key_hash, request_hash, provider_state_hash,
           expires_at, status, readiness, steps_json, next_action, created_at, last_updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AWAITING_PROVIDER', 'UNKNOWN', ?, 'WAIT', ?, ?, 1)`,
        [command.id, command.tenantId, command.principalId, command.portalSessionId, command.tenantContextHash,
          command.flowVariant, command.configurationRef, command.providerAppId, command.providerEnvironment,
          command.authVariant, command.capabilityManifestVersion, command.graphApiVersion,
          JSON.stringify(command.requestedCapabilities), command.returnRoute,
          command.idempotencyHash, command.requestHash, command.providerStateHash, command.expiresAt,
          JSON.stringify([
            { name: 'authorization', status: 'PENDING' }, { name: 'asset-verification', status: 'PENDING' },
            { name: 'subscription', status: 'PENDING' }, { name: 'projection', status: 'PENDING' },
          ]),
          command.createdAt, command.createdAt],
      );
      if (command.flowVariant === 'WHATSAPP_COEXISTENCE') {
        await connection.execute<ResultSetHeader>(
          `INSERT INTO ca_meta_onboarding_coexistence_locks
            (tenant_id, onboarding_session_id, expires_at, created_at)
           VALUES (?, ?, ?, UTC_TIMESTAMP(6))`,
          [command.tenantId, command.id, command.expiresAt],
        );
      }
      const [createdRows] = await connection.execute<OnboardingRow[]>(
        `SELECT id, tenant_id, principal_id, portal_session_id, tenant_context_hash, flow_variant,
                configuration_ref, provider_app_id, provider_environment, auth_variant,
                capability_manifest_version, graph_api_version, requested_capabilities, return_route,
                idempotency_key_hash, request_hash, provider_state_hash, expires_at, status, readiness,
                steps_json, saga_checkpoint_json, next_action, last_updated_at, provider_state_consumed_at
         FROM ca_meta_onboarding_sessions WHERE tenant_id = ? AND idempotency_key_hash = ? LIMIT 1`,
        [command.tenantId, command.idempotencyHash],
      );
      if (!createdRows[0]) throw new Error('Onboarding persistence did not return the created record.');
      await connection.commit();
      committed = true;
      return mapRecord(createdRows[0]);
    } catch (error) {
      if (!committed) {
        try { await connection.rollback(); } catch { /* Preserve the original database failure. */ }
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async findForSession(id: string, sessionId: string, principalId: string): Promise<OnboardingStoredRecord | undefined> {
    await this.pool.execute<ResultSetHeader>(
      `UPDATE ca_meta_onboarding_sessions SET status = 'EXPIRED', readiness = 'UNKNOWN', next_action = 'NONE',
         provider_state_consumed_at = COALESCE(provider_state_consumed_at, UTC_TIMESTAMP(6)),
         last_updated_at = UTC_TIMESTAMP(6), version = version + 1
       WHERE id = ? AND portal_session_id = ? AND principal_id = ? AND expires_at <= UTC_TIMESTAMP(6)
         AND status IN ('CREATED', 'AWAITING_PROVIDER', 'CODE_RECEIVED', 'EXCHANGING', 'ASSETS_VERIFIED', 'PROVISIONING')`,
      [id, sessionId, principalId],
    );
    const [rows] = await this.pool.execute<OnboardingRow[]>(
      `SELECT s.id, s.tenant_id, s.principal_id, s.portal_session_id, s.tenant_context_hash, s.flow_variant,
              s.configuration_ref, s.provider_app_id, s.provider_environment, s.auth_variant,
              s.capability_manifest_version, s.graph_api_version, s.requested_capabilities, s.return_route,
              s.idempotency_key_hash, s.request_hash, s.provider_state_hash, s.expires_at, s.status, s.readiness,
              s.steps_json, s.saga_checkpoint_json,
              CASE WHEN EXISTS (
                SELECT 1 FROM ca_meta_jobs j
                WHERE j.tenant_id = s.tenant_id AND j.resource_scope_ref = s.id AND j.job_type = 'ONBOARDING_STEP'
                  AND j.status = 'UNKNOWN' AND j.last_safe_error_code = 'LEASE_EXPIRED'
                  AND j.updated_at > s.last_updated_at
              ) AND s.status NOT IN ('CANCELLED', 'EXPIRED', 'FAILED', 'READY') THEN 'RECONCILE' ELSE s.next_action END AS next_action,
              s.last_updated_at, s.provider_state_consumed_at
       FROM ca_meta_onboarding_sessions s WHERE s.id = ? AND s.portal_session_id = ? AND s.principal_id = ? LIMIT 1`,
      [id, sessionId, principalId],
    );
    return rows[0] ? mapRecord(rows[0]) : undefined;
  }

  async findByProviderStateHash(providerStateHash: string): Promise<OnboardingStoredRecord | undefined> {
    if (!/^[a-f0-9]{64}$/.test(providerStateHash)) return undefined;
    const [rows] = await this.pool.execute<OnboardingRow[]>(
      `SELECT id, tenant_id, principal_id, portal_session_id, tenant_context_hash, flow_variant,
              configuration_ref, provider_app_id, provider_environment, auth_variant, capability_manifest_version, graph_api_version,
              requested_capabilities, return_route, idempotency_key_hash, request_hash, provider_state_hash,
              expires_at, status, readiness, steps_json, next_action, last_updated_at, provider_state_consumed_at
       FROM ca_meta_onboarding_sessions WHERE provider_state_hash = ? LIMIT 1`,
      [providerStateHash],
    );
    return rows[0] ? mapRecord(rows[0]) : undefined;
  }

  async cancelByProviderState(providerStateHash: string): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE ca_meta_onboarding_sessions
       SET status = 'CANCELLED', readiness = 'UNKNOWN', next_action = 'NONE',
           provider_state_consumed_at = UTC_TIMESTAMP(6), last_updated_at = UTC_TIMESTAMP(6), version = version + 1
       WHERE provider_state_hash = ? AND provider_state_consumed_at IS NULL
         AND expires_at > UTC_TIMESTAMP(6) AND status = 'AWAITING_PROVIDER'`,
      [providerStateHash],
    );
    return result.affectedRows === 1;
  }

  async completeByProviderState(providerStateHash: string, outcome: OnboardingProviderOutcome): Promise<boolean> {
    if (outcome.status === 'READY' && (!Array.isArray(outcome.verifiedAssetRefs) || outcome.verifiedAssetRefs.length === 0 ||
      outcome.subscriptionVerified !== true || outcome.projectionVerified !== true)) return false;
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE ca_meta_onboarding_sessions
       SET status = ?, readiness = ?, steps_json = ?, next_action = ?,
           provider_state_consumed_at = UTC_TIMESTAMP(6), last_updated_at = UTC_TIMESTAMP(6), version = version + 1
       WHERE provider_state_hash = ? AND provider_state_consumed_at IS NULL AND expires_at > UTC_TIMESTAMP(6)
         AND status IN ('AWAITING_PROVIDER', 'CODE_RECEIVED', 'EXCHANGING', 'ASSETS_VERIFIED', 'PROVISIONING')`,
      [outcome.status, outcome.readiness, JSON.stringify(outcome.steps), outcome.nextAction, providerStateHash],
    );
    return result.affectedRows === 1;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
