import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createPool, type Pool, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import type { ApiEnvironment } from '../config/environment.js';
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

interface OnboardingRow extends RowDataPacket {
  id: string;
  tenant_id: string;
  principal_id: string;
  portal_session_id: string;
  tenant_context_hash: string;
  flow_variant: string;
  requested_capabilities: unknown;
  return_route: string;
  idempotency_key_hash: string;
  request_hash: string;
  provider_state_hash: string;
  expires_at: string | Date;
  status: string;
  readiness: string;
  steps_json: unknown;
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
  'WAIT', 'CHECK_STATUS', 'REAUTHORIZE', 'RECONCILE', 'RESOLVE_CONFLICT', 'NONE',
]);
const FLOW_VALUES = new Set<OnboardingFlowVariant>([
  'FACEBOOK_LOGIN', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN', 'WHATSAPP_CLOUD_API', 'WHATSAPP_COEXISTENCE',
]);
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

function mapRecord(row: OnboardingRow): OnboardingStoredRecord {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(row.id) || !FLOW_VALUES.has(row.flow_variant as OnboardingFlowVariant) ||
    !STATUS_VALUES.has(row.status as OnboardingStatusName) || !READINESS_VALUES.has(row.readiness as OnboardingReadiness) ||
    !NEXT_ACTION_VALUES.has(row.next_action as OnboardingNextAction) || !/^[a-f0-9]{64}$/.test(row.tenant_context_hash) ||
    !/^[a-f0-9]{64}$/.test(row.idempotency_key_hash) || !/^[a-f0-9]{64}$/.test(row.request_hash) ||
    !/^[a-f0-9]{64}$/.test(row.provider_state_hash) || (row.return_route !== 'connections' && row.return_route !== 'setup')) {
    throw new Error('Onboarding persistence returned a malformed record.');
  }
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    portalSessionId: row.portal_session_id,
    tenantContextHash: row.tenant_context_hash,
    flowVariant: row.flow_variant as OnboardingFlowVariant,
    requestedCapabilities: jsonArray(row.requested_capabilities, isCapability),
    returnRoute: row.return_route,
    idempotencyHash: row.idempotency_key_hash,
    requestHash: row.request_hash,
    providerStateHash: row.provider_state_hash,
    expiresAt: dateValue(row.expires_at),
    status: row.status as OnboardingStatusName,
    readiness: row.readiness as OnboardingReadiness,
    steps: jsonArray(row.steps_json, isStep),
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
              requested_capabilities, return_route, idempotency_key_hash, request_hash, provider_state_hash,
              expires_at, status, readiness, steps_json, next_action, last_updated_at, provider_state_consumed_at
       FROM ca_meta_onboarding_sessions WHERE tenant_id = ? AND idempotency_key_hash = ? LIMIT 1`,
      [tenantId, idempotencyHash],
    );
    return rows[0] ? mapRecord(rows[0]) : undefined;
  }

  async createOrReplay(command: OnboardingCreateCommand): Promise<OnboardingStoredRecord> {
    const existing = await this.findByIdempotency(command.tenantId, command.idempotencyHash);
    if (existing) return existing;
    try {
      await this.pool.execute<ResultSetHeader>(
        `INSERT INTO ca_meta_onboarding_sessions
          (id, tenant_id, principal_id, portal_session_id, tenant_context_hash, flow_variant,
           requested_capabilities, return_route, idempotency_key_hash, request_hash, provider_state_hash,
           expires_at, status, readiness, steps_json, next_action, created_at, last_updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AWAITING_PROVIDER', 'UNKNOWN', ?, 'WAIT', ?, ?, 1)`,
        [command.id, command.tenantId, command.principalId, command.portalSessionId, command.tenantContextHash,
          command.flowVariant, JSON.stringify(command.requestedCapabilities), command.returnRoute,
          command.idempotencyHash, command.requestHash, command.providerStateHash, command.expiresAt,
          JSON.stringify([{ name: 'authorization', status: 'PENDING' }, { name: 'asset-verification', status: 'PENDING' }]),
          command.createdAt, command.createdAt],
      );
    } catch (error) {
      if ((error as { code?: unknown })?.code !== 'ER_DUP_ENTRY') throw error;
    }
    const stored = await this.findByIdempotency(command.tenantId, command.idempotencyHash);
    if (!stored) throw new Error('Onboarding persistence did not return the created record.');
    return stored;
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
      `SELECT id, tenant_id, principal_id, portal_session_id, tenant_context_hash, flow_variant,
              requested_capabilities, return_route, idempotency_key_hash, request_hash, provider_state_hash,
              expires_at, status, readiness, steps_json, next_action, last_updated_at, provider_state_consumed_at
       FROM ca_meta_onboarding_sessions WHERE id = ? AND portal_session_id = ? AND principal_id = ? LIMIT 1`,
      [id, sessionId, principalId],
    );
    return rows[0] ? mapRecord(rows[0]) : undefined;
  }

  async completeByProviderState(providerStateHash: string, outcome: OnboardingProviderOutcome): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE ca_meta_onboarding_sessions
       SET status = ?, readiness = ?, steps_json = ?, next_action = ?,
           provider_state_consumed_at = UTC_TIMESTAMP(6), last_updated_at = UTC_TIMESTAMP(6), version = version + 1
       WHERE provider_state_hash = ? AND provider_state_consumed_at IS NULL
         AND expires_at > UTC_TIMESTAMP(6) AND status = 'AWAITING_PROVIDER'`,
      [outcome.status, outcome.readiness, JSON.stringify(outcome.steps), outcome.nextAction, providerStateHash],
    );
    return result.affectedRows === 1;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
