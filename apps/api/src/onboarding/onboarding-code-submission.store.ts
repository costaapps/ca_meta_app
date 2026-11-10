import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { OnModuleDestroy } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { DurableJobStore } from '../jobs/job-store.js';
import type { OnboardingStoredRecord } from './onboarding-session.types.js';
import { OnboardingCodeProtector, type OnboardingCodeContext, type SealedOnboardingCode } from './onboarding-code-crypto.js';

export interface AcceptOnboardingCodeInput {
  readonly record: OnboardingStoredRecord;
  readonly codeRef: string;
  readonly idempotencyHash: string;
  readonly requestHash: string;
  readonly sealedCode: SealedOnboardingCode;
  readonly principalId: string;
  readonly portalSessionId: string;
}

export interface AcceptedOnboardingCode {
  readonly jobId: string;
  readonly duplicate: boolean;
}

export class OnboardingCodeConflictError extends Error {
  constructor() { super('The provider code submission conflicts with this onboarding.'); this.name = 'OnboardingCodeConflictError'; }
}

export class OnboardingCodeNotFoundError extends Error {
  constructor() { super('The onboarding session is unavailable.'); this.name = 'OnboardingCodeNotFoundError'; }
}

interface OnboardingRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly portal_session_id: string;
  readonly flow_variant: string;
  readonly configuration_ref: string;
  readonly provider_app_id: string;
  readonly provider_environment: string;
  readonly auth_variant: string;
  readonly capability_manifest_version: string;
  readonly graph_api_version: string;
  readonly provider_state_hash: string;
  readonly status: string;
  readonly provider_state_consumed_at: string | Date | null;
  readonly expires_at: string | Date;
  readonly version: number | string;
}

interface ExistingCodeRow {
  readonly onboarding_id: string;
  readonly idempotency_key_hash: string;
  readonly request_hash: string;
  readonly code_ref: string;
  readonly expires_at: string | Date;
}

interface MembershipRow { readonly principal_id: string; readonly portal_session_id: string; }

function dateValue(value: string | Date): number {
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return parsed.getTime();
}

function compareDigest(left: string, right: string): boolean {
  if (left.length !== 64 || right.length !== 64 || !/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function affectedRows(result: unknown): number {
  if (Array.isArray(result)) return result.length === 0 ? 0 : affectedRows(result[0]);
  if (typeof result === 'object' && result !== null && 'affectedRows' in result) {
    return Number((result as { affectedRows?: number | string }).affectedRows ?? 0);
  }
  return 0;
}

export class MysqlOnboardingCodeSubmissionStore implements OnModuleDestroy {
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(private readonly database: DurableWorkDatabase, private readonly jobs: DurableJobStore) {
    this.cleanupTimer = setInterval(() => { void this.eraseExpiredCodes().catch(() => undefined); }, 60_000);
    this.cleanupTimer.unref();
  }

  async accept(input: AcceptOnboardingCodeInput): Promise<AcceptedOnboardingCode> {
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction('READ COMMITTED', async (manager) => {
      const tenantRows = await manager.query(
        'SELECT id FROM ca_meta_tenants WHERE id = ? FOR UPDATE', [input.record.tenantId],
      ) as Array<{ id: string }>;
      if (tenantRows.length !== 1) throw new OnboardingCodeNotFoundError();
      await this.assertCurrentActor(manager, input);

      const existingIdempotencyRows = await manager.query(
        `SELECT onboarding_id, idempotency_key_hash, request_hash, code_ref, expires_at
         FROM ca_meta_onboarding_codes WHERE tenant_id = ? AND idempotency_key_hash = ? LIMIT 1 FOR UPDATE`,
        [input.record.tenantId, input.idempotencyHash],
      ) as ExistingCodeRow[];
      const existingIdempotency = existingIdempotencyRows[0];
      if (existingIdempotency) {
        if (existingIdempotency.onboarding_id !== input.record.id ||
          !compareDigest(existingIdempotency.idempotency_key_hash, input.idempotencyHash) ||
          !compareDigest(existingIdempotency.request_hash, input.requestHash) ||
          dateValue(existingIdempotency.expires_at) <= Date.now()) throw new OnboardingCodeConflictError();
        const accepted = await this.enqueue(manager, input, existingIdempotency.code_ref);
        return Object.freeze({ jobId: accepted.id, duplicate: true });
      }

      const existingCodes = await manager.query(
        `SELECT onboarding_id, idempotency_key_hash, request_hash, code_ref, expires_at
         FROM ca_meta_onboarding_codes WHERE tenant_id = ? AND onboarding_id = ? LIMIT 1 FOR UPDATE`,
        [input.record.tenantId, input.record.id],
      ) as ExistingCodeRow[];
      const existingCode = existingCodes[0];
      if (existingCode) {
        if (!compareDigest(existingCode.idempotency_key_hash, input.idempotencyHash) ||
          !compareDigest(existingCode.request_hash, input.requestHash) ||
          dateValue(existingCode.expires_at) <= Date.now()) throw new OnboardingCodeConflictError();
        const accepted = await this.enqueue(manager, input, existingCode.code_ref);
        return Object.freeze({ jobId: accepted.id, duplicate: true });
      }

      const records = await manager.query(
        `SELECT id, tenant_id, principal_id, portal_session_id, flow_variant, configuration_ref,
                provider_app_id, provider_environment, auth_variant,
                capability_manifest_version, graph_api_version, provider_state_hash, status,
                provider_state_consumed_at, expires_at, version
         FROM ca_meta_onboarding_sessions
         WHERE id = ? AND tenant_id = ? AND principal_id = ? AND portal_session_id = ? LIMIT 1 FOR UPDATE`,
        [input.record.id, input.record.tenantId, input.principalId, input.portalSessionId],
      ) as OnboardingRow[];
      const record = records[0];
      if (!record || record.id !== input.record.id || record.tenant_id !== input.record.tenantId ||
        record.flow_variant !== input.record.flowVariant || record.configuration_ref !== input.record.configurationRef ||
        record.provider_app_id !== input.record.providerAppId || record.provider_environment !== input.record.providerEnvironment ||
        record.auth_variant !== input.record.authVariant ||
        record.capability_manifest_version !== input.record.capabilityManifestVersion ||
        record.graph_api_version !== input.record.graphApiVersion ||
        !compareDigest(record.provider_state_hash, input.record.providerStateHash) ||
        record.status !== 'AWAITING_PROVIDER' || record.provider_state_consumed_at !== null ||
        dateValue(record.expires_at) <= Date.now()) throw new OnboardingCodeConflictError();

      await manager.query(
        `INSERT INTO ca_meta_onboarding_codes
          (code_ref, tenant_id, onboarding_id, idempotency_key_hash, request_hash, code_hash, key_version,
           nonce, ciphertext, authentication_tag, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?,
           LEAST(?, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 120 SECOND)), UTC_TIMESTAMP(6))`,
        [input.codeRef, input.record.tenantId, input.record.id, input.idempotencyHash, input.requestHash,
          input.sealedCode.codeHash, input.sealedCode.nonce, input.sealedCode.ciphertext,
          input.sealedCode.authenticationTag, input.record.expiresAt],
      );

      const updated = await manager.query(
        `UPDATE ca_meta_onboarding_sessions
         SET status = 'CODE_RECEIVED', readiness = 'UNKNOWN',
             steps_json = JSON_ARRAY(
               JSON_OBJECT('name', 'authorization', 'status', 'PENDING'),
               JSON_OBJECT('name', 'asset-verification', 'status', 'PENDING'),
               JSON_OBJECT('name', 'subscription', 'status', 'PENDING'),
               JSON_OBJECT('name', 'projection', 'status', 'PENDING')
             ),
             next_action = 'WAIT', provider_state_consumed_at = UTC_TIMESTAMP(6),
             last_updated_at = UTC_TIMESTAMP(6), version = version + 1
         WHERE id = ? AND tenant_id = ? AND version = ? AND status = 'AWAITING_PROVIDER'
           AND provider_state_consumed_at IS NULL AND expires_at > UTC_TIMESTAMP(6)`,
        [input.record.id, input.record.tenantId, Number(record.version)],
      );
      const changed = affectedRows(updated);
      if (changed !== 1) throw new OnboardingCodeConflictError();

      const queued = await this.enqueue(manager, input, input.codeRef);
      return Object.freeze({ jobId: queued.id, duplicate: false });
    });
  }

  private async assertCurrentActor(manager: EntityManager, input: AcceptOnboardingCodeInput): Promise<void> {
    const rows = await manager.query(
      `SELECT m.principal_id, ps.id AS portal_session_id
       FROM ca_meta_memberships AS m
       INNER JOIN ca_meta_principals AS p ON p.id = m.principal_id AND p.kind = 'USER' AND p.status = 'ACTIVE'
       INNER JOIN ca_meta_tenants AS t ON t.id = m.tenant_id AND t.status = 'ACTIVE'
       INNER JOIN ca_meta_portal_sessions AS ps ON ps.id = ? AND ps.principal_id = m.principal_id AND ps.tenant_id = m.tenant_id
         AND ps.revoked_at IS NULL AND ps.idle_expires_at > UTC_TIMESTAMP(6)
         AND ps.absolute_expires_at > UTC_TIMESTAMP(6)
       WHERE m.tenant_id = ? AND m.principal_id = ? AND m.status = 'ACTIVE' AND m.principal_kind = 'USER'
         AND (JSON_CONTAINS(m.roles, JSON_QUOTE('owner')) OR JSON_CONTAINS(m.roles, JSON_QUOTE('admin'))
           OR JSON_CONTAINS(m.roles, JSON_QUOTE('operator')))
       LIMIT 1 FOR UPDATE`,
      [input.portalSessionId, input.record.tenantId, input.principalId],
    ) as MembershipRow[];
    if (rows.length !== 1 || rows[0]?.principal_id !== input.principalId || rows[0]?.portal_session_id !== input.portalSessionId) {
      throw new OnboardingCodeNotFoundError();
    }
  }

  private async enqueue(manager: EntityManager, input: AcceptOnboardingCodeInput, codeRef: string) {
    return this.jobs.enqueueWithin(manager, {
      tenantId: input.record.tenantId,
      type: 'ONBOARDING_STEP',
      idempotencyKey: `onboarding-code:${input.idempotencyHash}`,
      // Stable correlation makes HTTP retries resolve to the same durable job.
      correlationId: input.record.id,
      causationId: input.record.id,
      resourceScopeRef: input.record.id,
      payload: { kind: 'ONBOARDING_STEP', onboardingRef: input.record.id, stepRef: 'authorization', codeRef },
    });
  }

  async eraseExpiredCodes(): Promise<void> {
    const dataSource = await this.database.getDataSource();
    await dataSource.transaction('READ COMMITTED', async (manager) => {
      const expired = await manager.query(
        `SELECT code_ref, tenant_id, onboarding_id, consumed_at FROM ca_meta_onboarding_codes
         WHERE expires_at <= UTC_TIMESTAMP(6) ORDER BY expires_at, code_ref LIMIT 64 FOR UPDATE SKIP LOCKED`,
      ) as Array<{ code_ref: string; tenant_id: string; onboarding_id: string; consumed_at: string | Date | null }>;
      for (const code of expired) {
        if (code.consumed_at === null) {
          await manager.query(
            `UPDATE ca_meta_onboarding_sessions
             SET status = 'PARTIAL', readiness = 'PARTIAL', next_action = 'REAUTHORIZE',
                 steps_json = JSON_SET(steps_json, '$[0].status', 'FAILED'),
                 last_updated_at = UTC_TIMESTAMP(6), version = version + 1
             WHERE tenant_id = ? AND id = ? AND status IN ('CODE_RECEIVED', 'EXCHANGING')
               AND expires_at > UTC_TIMESTAMP(6)`, [code.tenant_id, code.onboarding_id],
          );
        }
        await manager.query('DELETE FROM ca_meta_onboarding_codes WHERE code_ref = ? AND expires_at <= UTC_TIMESTAMP(6)', [code.code_ref]);
      }
    });
  }

  async onModuleDestroy(): Promise<void> { clearInterval(this.cleanupTimer); }
}

export interface OnboardingCodeConsumer {
  consumeOnce(input: { readonly tenantId: string; readonly onboardingId: string; readonly codeRef: string }): Promise<{
    readonly context: ConsumedOnboardingCodeContext;
    readonly code: string;
  } | undefined>;
}

export interface ConsumedOnboardingCodeContext extends OnboardingCodeContext {
  readonly principalId: string;
  readonly portalSessionId: string;
  readonly capabilityManifestVersion: string;
  readonly graphApiVersion: string;
}

interface ConsumableCodeRow extends OnboardingCodeContext {
  readonly principal_id: string;
  readonly portal_session_id: string;
  readonly capability_manifest_version: string;
  readonly graph_api_version: string;
  readonly code_hash: string;
  readonly key_version: number | string;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly authentication_tag: Buffer;
}

/** Reads and erases a staged authorization code atomically before any provider call. */
export class MysqlOnboardingCodeConsumer implements OnboardingCodeConsumer {
  constructor(private readonly database: DurableWorkDatabase, private readonly protector: OnboardingCodeProtector) {}

  async consumeOnce(input: { readonly tenantId: string; readonly onboardingId: string; readonly codeRef: string }): Promise<{
    readonly context: ConsumedOnboardingCodeContext;
    readonly code: string;
  } | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(input.codeRef)) return undefined;
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction('READ COMMITTED', async (manager) => {
      const rows = await manager.query(
        `SELECT s.tenant_id AS tenantId, s.id AS onboardingId, s.flow_variant AS flowVariant,
                s.auth_variant AS authVariant, s.configuration_ref AS configurationRef,
                s.principal_id, s.portal_session_id, s.capability_manifest_version,
                s.graph_api_version, c.code_hash, c.key_version, c.nonce, c.ciphertext,
                c.authentication_tag
         FROM ca_meta_onboarding_codes c
         INNER JOIN ca_meta_onboarding_sessions s ON s.tenant_id = c.tenant_id AND s.id = c.onboarding_id
         WHERE c.tenant_id = ? AND c.onboarding_id = ? AND c.code_ref = ?
           AND c.consumed_at IS NULL AND c.expires_at > UTC_TIMESTAMP(6)
           AND s.status = 'EXCHANGING' AND s.expires_at > UTC_TIMESTAMP(6)
         LIMIT 1 FOR UPDATE`,
        [input.tenantId, input.onboardingId, input.codeRef],
      ) as ConsumableCodeRow[];
      const row = rows[0];
      if (!row || Number(row.key_version) !== 1 || !Buffer.isBuffer(row.nonce) ||
        !Buffer.isBuffer(row.ciphertext) || !Buffer.isBuffer(row.authentication_tag)) return undefined;
      const sealed: SealedOnboardingCode = {
        codeHash: row.code_hash,
        nonce: row.nonce,
        ciphertext: row.ciphertext,
        authenticationTag: row.authentication_tag,
      };
      const code = this.protector.open(row, sealed);
      const result = await manager.query(
        `UPDATE ca_meta_onboarding_codes
         SET nonce = NULL, ciphertext = NULL, authentication_tag = NULL, consumed_at = UTC_TIMESTAMP(6)
         WHERE tenant_id = ? AND onboarding_id = ? AND code_ref = ? AND consumed_at IS NULL
           AND expires_at > UTC_TIMESTAMP(6)`,
        [input.tenantId, input.onboardingId, input.codeRef],
      );
      if (affectedRows(result) !== 1) throw new OnboardingCodeConflictError();
      return Object.freeze({
        context: Object.freeze({
          tenantId: row.tenantId,
          onboardingId: row.onboardingId,
          flowVariant: row.flowVariant,
          authVariant: row.authVariant,
          configurationRef: row.configurationRef,
          principalId: row.principal_id,
          portalSessionId: row.portal_session_id,
          capabilityManifestVersion: row.capability_manifest_version,
          graphApiVersion: row.graph_api_version,
        }),
        code,
      });
    });
  }
}
