import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createPool, type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import type { ApiEnvironment } from '../config/environment.js';
import { parseMembershipRoles } from './mysql-identity.repository.js';
import type { MembershipRole } from './identity.types.js';
import type { StoredPortalSession, VerifiedPortalSession } from './identity.trust.js';
import { IdentityDeniedError } from './identity.errors.js';
import type { PortalPreAuthRecord, PortalSessionIssueRecord, PortalSessionRecord, PortalSessionStore } from './portal-session.service.js';

interface PreAuthRow extends RowDataPacket {
  id: string;
  challenge_hash: string;
  browser_cookie_hash: string;
  entry_mode: string;
  expires_at: string;
  consumed_at: string | null;
}

interface ActiveSessionRow extends RowDataPacket {
  id: string;
  principal_id: string;
  tenant_id: string;
  context_version: number | string;
  context_ref_hash: string;
  csrf_token_hash: string;
  secret_hash?: string;
  idle_expires_at: string;
  absolute_expires_at: string;
}

interface PrincipalMembershipRow extends RowDataPacket {
  principal_id: string;
  principal_kind: string;
  principal_status: string;
  tenant_id: string;
  tenant_status: string;
  membership_status: string;
  roles: unknown;
}

interface TicketRow extends RowDataPacket {
  pre_auth_id: string;
  session_id: string;
  ticket_sha256: string | null;
  ticket_expires_at: string;
}

interface ExpiryRow extends RowDataPacket { readonly absolute_expires_at: string; }

function dateValue(value: string): Date {
  return new Date(`${value.replace(' ', 'T')}Z`);
}

function safeRoles(value: unknown): readonly MembershipRole[] {
  try {
    return parseMembershipRoles(value);
  } catch {
    throw new IdentityDeniedError();
  }
}

function validMembership(row: PrincipalMembershipRow | undefined, requestedTenantId: string): row is PrincipalMembershipRow {
  return !!row && row.tenant_id === requestedTenantId && row.principal_kind === 'USER' &&
    row.principal_status === 'ACTIVE' && row.tenant_status === 'ACTIVE' && row.membership_status === 'ACTIVE';
}

async function rollback(connection: PoolConnection): Promise<void> {
  await connection.rollback().catch(() => undefined);
}

@Injectable()
export class MysqlPortalSessionStore implements PortalSessionStore, OnApplicationShutdown {
  private readonly pool: Pool;
  private readonly idleTimeoutSeconds: number;
  private readonly absoluteTimeoutSeconds: number;
  private readonly cleanupTimer: NodeJS.Timeout;
  private cleanupInFlight: Promise<{ readonly ticketJtisDeleted: number; readonly preAuthDeleted: number }> | undefined;

  constructor(environment: Pick<ApiEnvironment, 'database' | 'portalSessionIdleTimeoutSeconds' | 'portalSessionAbsoluteTimeoutSeconds'>) {
    this.idleTimeoutSeconds = environment.portalSessionIdleTimeoutSeconds;
    this.absoluteTimeoutSeconds = environment.portalSessionAbsoluteTimeoutSeconds;
    this.pool = createPool({
      host: environment.database.host,
      port: environment.database.port,
      database: environment.database.name,
      user: environment.database.user,
      password: environment.database.password,
      connectTimeout: environment.database.connectTimeoutMs,
      connectionLimit: 10,
      waitForConnections: true,
      queueLimit: 100,
      multipleStatements: false,
      charset: 'utf8mb4',
      dateStrings: true,
      timezone: 'Z',
    });
    this.cleanupTimer = setInterval(() => {
      void this.purgeExpiredRecords().catch(() => undefined);
    }, 60_000);
    this.cleanupTimer.unref();
  }

  /** Bounded, retryable cleanup; the ticket tombstone is removed before its expired pre-auth row. */
  async purgeExpiredRecords(): Promise<{ readonly ticketJtisDeleted: number; readonly preAuthDeleted: number }> {
    if (this.cleanupInFlight) return this.cleanupInFlight;
    const operation = this.purgeExpiredRecordsBatch();
    this.cleanupInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.cleanupInFlight === operation) this.cleanupInFlight = undefined;
    }
  }

  private async purgeExpiredRecordsBatch(): Promise<{ readonly ticketJtisDeleted: number; readonly preAuthDeleted: number }> {
    const [tickets] = await this.pool.execute<ResultSetHeader>(
      `DELETE FROM ca_meta_portal_ticket_jtis
       WHERE ticket_expires_at <= UTC_TIMESTAMP(6)
       ORDER BY ticket_expires_at ASC LIMIT 1000`,
    );
    const [preAuth] = await this.pool.execute<ResultSetHeader>(
      `DELETE FROM ca_meta_portal_pre_auth
       WHERE expires_at <= UTC_TIMESTAMP(6)
         AND NOT EXISTS (
           SELECT 1 FROM ca_meta_portal_ticket_jtis AS ticket WHERE ticket.pre_auth_id = ca_meta_portal_pre_auth.id
         )
       ORDER BY expires_at ASC LIMIT 1000`,
    );
    return Object.freeze({ ticketJtisDeleted: tickets.affectedRows, preAuthDeleted: preAuth.affectedRows });
  }

  async createPreAuth(input: Omit<PortalPreAuthRecord, 'consumedAt' | 'expiresAt'>): Promise<Date> {
    await this.pool.execute(
      `INSERT INTO ca_meta_portal_pre_auth
       (id, challenge_hash, browser_cookie_hash, entry_mode, created_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6), DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 5 MINUTE), NULL)`,
      [input.id, input.challengeHash, input.browserCookieHash, input.entryMode],
    );
    const [rows] = await this.pool.execute<ExpiryRow[]>(
      'SELECT expires_at AS absolute_expires_at FROM ca_meta_portal_pre_auth WHERE id = ? LIMIT 1', [input.id],
    );
    const expiry = rows[0]?.absolute_expires_at;
    if (!expiry) throw new Error('Portal pre-auth expiry could not be read back.');
    return dateValue(expiry);
  }

  async findPreAuth(challengeHash: string, browserCookieHash: string): Promise<PortalPreAuthRecord | undefined> {
    const [rows] = await this.pool.execute<PreAuthRow[]>(
      `SELECT id, challenge_hash, browser_cookie_hash, entry_mode, expires_at, consumed_at
       FROM ca_meta_portal_pre_auth
       WHERE challenge_hash = ? AND browser_cookie_hash = ? AND expires_at > UTC_TIMESTAMP(6)
       LIMIT 1`,
      [challengeHash, browserCookieHash],
    );
    const row = rows[0];
    if (!row || (row.entry_mode !== 'PORTAL_TOP_LEVEL' && row.entry_mode !== 'SUITE4_EMBED')) return undefined;
    return Object.freeze({
      id: row.id,
      challengeHash: row.challenge_hash,
      browserCookieHash: row.browser_cookie_hash,
      entryMode: row.entry_mode,
      expiresAt: dateValue(row.expires_at),
      ...(row.consumed_at ? { consumedAt: dateValue(row.consumed_at) } : {}),
    });
  }

  async createOrRecoverSession(input: PortalSessionIssueRecord): Promise<PortalSessionRecord> {
    const connection = await this.pool.getConnection();
    await connection.beginTransaction();
    try {
      const [preAuthRows] = await connection.execute<PreAuthRow[]>(
        `SELECT id, challenge_hash, browser_cookie_hash, entry_mode, expires_at, consumed_at
         FROM ca_meta_portal_pre_auth WHERE id = ? AND expires_at > UTC_TIMESTAMP(6) FOR UPDATE`,
        [input.preAuth.id],
      );
      const preAuth = preAuthRows[0];
      if (!preAuth || preAuth.challenge_hash !== input.preAuth.challengeHash ||
        preAuth.browser_cookie_hash !== input.preAuth.browserBindingHash ||
        preAuth.entry_mode !== input.preAuth.entryMode) {
        throw new IdentityDeniedError();
      }

      const [ticketRows] = await connection.execute<TicketRow[]>(
        `SELECT pre_auth_id, session_id, ticket_sha256, ticket_expires_at
         FROM ca_meta_portal_ticket_jtis WHERE issuer = ? AND jti_hash = ? AND ticket_expires_at > UTC_TIMESTAMP(6) LIMIT 1`,
        [input.assertion.issuer, input.ticketJtiSha256],
      );
      const existingTicket = ticketRows[0];
      if (existingTicket) {
        const recovered = await this.recoverSession(connection, input, existingTicket, preAuth);
        await connection.commit();
        return recovered;
      }
      const [validityRows] = await connection.execute<Array<RowDataPacket & { ticket_live: number }>>(
        'SELECT (? > UTC_TIMESTAMP(6)) AS ticket_live', [input.ticketExpiresAt],
      );
      if (preAuth.consumed_at !== null || Number(validityRows[0]?.ticket_live ?? 0) !== 1) throw new IdentityDeniedError();

      const [membershipRows] = await connection.execute<PrincipalMembershipRow[]>(
        `SELECT p.id AS principal_id, p.kind AS principal_kind, p.status AS principal_status,
                t.id AS tenant_id, t.status AS tenant_status, m.status AS membership_status, m.roles
         FROM ca_meta_principals AS p
         INNER JOIN ca_meta_memberships AS m ON m.principal_id = p.id AND m.principal_kind = p.kind
         INNER JOIN ca_meta_tenants AS t ON t.id = m.tenant_id
         WHERE p.issuer = ? AND p.subject = ? AND p.kind = 'USER' AND p.status = 'ACTIVE'
           AND m.tenant_id = ? AND m.status = 'ACTIVE' AND t.status = 'ACTIVE'
         LIMIT 1 FOR UPDATE`,
        [input.assertion.issuer, input.assertion.subject, input.requestedTenantId],
      );
      const membership = membershipRows[0];
      if (!validMembership(membership, input.requestedTenantId)) throw new IdentityDeniedError();
      const roles = safeRoles(membership.roles);
      if (input.priorSession) {
        await connection.execute(
          `UPDATE ca_meta_portal_sessions SET revoked_at = UTC_TIMESTAMP(6)
           WHERE id = ? AND revoked_at IS NULL`,
          [input.priorSession.sessionId],
        );
      }
      await connection.execute(
        `INSERT INTO ca_meta_portal_sessions
         (id, principal_id, tenant_id, secret_hash, csrf_token_hash, context_ref_hash, context_version,
          created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6),
                 DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND), DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND), NULL)`,
        [input.sessionId, membership.principal_id, membership.tenant_id, input.sessionCookieHash,
          input.csrfTokenHash, input.contextRefHash, this.idleTimeoutSeconds, this.absoluteTimeoutSeconds],
      );
      await connection.execute(
        `UPDATE ca_meta_portal_pre_auth SET consumed_at = UTC_TIMESTAMP(6)
         WHERE id = ? AND consumed_at IS NULL`,
        [preAuth.id],
      );
      const [ticketInsert] = await connection.execute<ResultSetHeader>(
        `INSERT INTO ca_meta_portal_ticket_jtis
         (issuer, jti_hash, ticket_sha256, pre_auth_id, session_id, ticket_expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
        [input.assertion.issuer, input.ticketJtiSha256, input.ticketSha256, preAuth.id, input.sessionId, input.ticketExpiresAt],
      );
      if (ticketInsert.affectedRows !== 1) throw new IdentityDeniedError();
      const [expiryRows] = await connection.execute<ExpiryRow[]>(
        'SELECT absolute_expires_at FROM ca_meta_portal_sessions WHERE id = ? LIMIT 1', [input.sessionId],
      );
      const absoluteExpiresAt = expiryRows[0]?.absolute_expires_at;
      if (!absoluteExpiresAt) throw new Error('Portal session expiry could not be read back.');
      await connection.commit();
      return Object.freeze({
        sessionId: input.sessionId,
        principalId: membership.principal_id,
        tenantId: membership.tenant_id,
        contextVersion: 1,
        contextRefHash: input.contextRefHash,
        csrfTokenHash: input.csrfTokenHash,
        roles,
        sessionCookie: input.sessionCookie,
        csrfToken: input.csrfToken,
        contextRef: input.contextRef,
        expiresAt: dateValue(absoluteExpiresAt).toISOString(),
      });
    } catch (error) {
      await rollback(connection);
      const mysqlError = error as NodeJS.ErrnoException;
      if (mysqlError.code === 'ER_DUP_ENTRY' || mysqlError.code === 'ER_DUP_KEY') throw new IdentityDeniedError();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async recoverSession(
    connection: PoolConnection,
    input: PortalSessionIssueRecord,
    ticket: TicketRow,
    preAuth: PreAuthRow,
  ): Promise<PortalSessionRecord> {
    if (ticket.pre_auth_id !== preAuth.id || ticket.ticket_sha256 !== input.ticketSha256 || preAuth.consumed_at === null) {
      throw new IdentityDeniedError();
    }
    const [rows] = await connection.execute<ActiveSessionRow[]>(
      `SELECT id, principal_id, tenant_id, context_version, context_ref_hash, csrf_token_hash, secret_hash,
              idle_expires_at, absolute_expires_at
       FROM ca_meta_portal_sessions
       WHERE id = ? AND revoked_at IS NULL AND idle_expires_at > UTC_TIMESTAMP(6)
         AND absolute_expires_at > UTC_TIMESTAMP(6) FOR UPDATE`,
      [ticket.session_id],
    );
    const session = rows[0];
    if (!session || session.secret_hash !== input.sessionCookieHash || Number(session.context_version) !== 1 || session.tenant_id !== input.requestedTenantId ||
      session.context_ref_hash !== input.contextRefHash || session.csrf_token_hash !== input.csrfTokenHash) {
      throw new IdentityDeniedError();
    }
    const [membershipRows] = await connection.execute<PrincipalMembershipRow[]>(
      `SELECT p.id AS principal_id, p.kind AS principal_kind, p.status AS principal_status,
              t.id AS tenant_id, t.status AS tenant_status, m.status AS membership_status, m.roles
       FROM ca_meta_principals AS p
       INNER JOIN ca_meta_memberships AS m ON m.principal_id = p.id AND m.principal_kind = p.kind
       INNER JOIN ca_meta_tenants AS t ON t.id = m.tenant_id
       WHERE p.id = ? AND p.issuer = ? AND p.subject = ? AND p.kind = 'USER' AND p.status = 'ACTIVE'
         AND m.tenant_id = ? AND m.status = 'ACTIVE' AND t.status = 'ACTIVE'
       LIMIT 1 FOR UPDATE`,
      [session.principal_id, input.assertion.issuer, input.assertion.subject, input.requestedTenantId],
    );
    const membership = membershipRows[0];
    if (!validMembership(membership, input.requestedTenantId)) throw new IdentityDeniedError();
    return Object.freeze({
      sessionId: session.id,
      principalId: session.principal_id,
      tenantId: session.tenant_id,
      contextVersion: 1,
      contextRefHash: session.context_ref_hash,
      csrfTokenHash: session.csrf_token_hash,
      roles: safeRoles(membership.roles),
      sessionCookie: input.sessionCookie,
      csrfToken: input.csrfToken,
      contextRef: input.contextRef,
      expiresAt: dateValue(session.absolute_expires_at).toISOString(),
    });
  }

  async findActiveBySecretHash(secretHash: Uint8Array, options: { readonly touchLastSeen?: boolean } = {}): Promise<StoredPortalSession | undefined> {
    const digest = Buffer.from(secretHash).toString('hex');
    if (options.touchLastSeen !== false) {
      await this.pool.execute(
        `UPDATE ca_meta_portal_sessions
         SET last_seen_at = UTC_TIMESTAMP(6), idle_expires_at = LEAST(absolute_expires_at, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND))
         WHERE secret_hash = ? AND revoked_at IS NULL AND idle_expires_at > UTC_TIMESTAMP(6)
           AND absolute_expires_at > UTC_TIMESTAMP(6)`, [this.idleTimeoutSeconds, digest],
      );
    }
    const [rows] = await this.pool.execute<ActiveSessionRow[]>(
      `SELECT id, principal_id, tenant_id, context_version, context_ref_hash, csrf_token_hash
       FROM ca_meta_portal_sessions WHERE secret_hash = ? AND revoked_at IS NULL
         AND idle_expires_at > UTC_TIMESTAMP(6) AND absolute_expires_at > UTC_TIMESTAMP(6) LIMIT 1`, [digest],
    );
    const row = rows[0];
    if (!row) return undefined;
    return Object.freeze({
      sessionId: row.id,
      principalId: row.principal_id,
      tenantId: row.tenant_id,
      contextVersion: Number(row.context_version),
      contextRefHash: row.context_ref_hash,
      csrfTokenHash: row.csrf_token_hash,
    });
  }

  async refreshActivity(session: VerifiedPortalSession): Promise<void> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE ca_meta_portal_sessions
       SET last_seen_at = UTC_TIMESTAMP(6), idle_expires_at = LEAST(absolute_expires_at, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND))
       WHERE id = ? AND principal_id = ? AND tenant_id = ? AND context_version = ? AND context_ref_hash = ?
         AND revoked_at IS NULL AND idle_expires_at > UTC_TIMESTAMP(6) AND absolute_expires_at > UTC_TIMESTAMP(6)`,
      [this.idleTimeoutSeconds, session.sessionId, session.principalId, session.tenantId, session.contextVersion, session.contextRefHash],
    );
    if (result.affectedRows !== 1) throw new IdentityDeniedError('CONTEXT_CHANGED');
  }

  async changeContext(input: {
    readonly session: VerifiedPortalSession;
    readonly requestedTenantId: string;
    readonly contextRef: string;
    readonly contextRefHash: string;
    readonly csrfTokenHash: string;
  }): Promise<{ readonly contextVersion: number; readonly roles: readonly MembershipRole[]; readonly expiresAt: string }> {
    const connection = await this.pool.getConnection();
    await connection.beginTransaction();
    try {
      const [sessionRows] = await connection.execute<ActiveSessionRow[]>(
      `SELECT id, principal_id, tenant_id, context_version, context_ref_hash, csrf_token_hash,
                idle_expires_at, absolute_expires_at
         FROM ca_meta_portal_sessions WHERE id = ? AND revoked_at IS NULL
           AND idle_expires_at > UTC_TIMESTAMP(6) AND absolute_expires_at > UTC_TIMESTAMP(6) FOR UPDATE`,
        [input.session.sessionId],
      );
      const session = sessionRows[0];
      if (!session || session.principal_id !== input.session.principalId || session.tenant_id !== input.session.tenantId ||
        Number(session.context_version) !== input.session.contextVersion || session.context_ref_hash !== input.session.contextRefHash) {
        throw new IdentityDeniedError('CONTEXT_CHANGED');
      }
      const [membershipRows] = await connection.execute<PrincipalMembershipRow[]>(
        `SELECT p.id AS principal_id, p.kind AS principal_kind, p.status AS principal_status,
                t.id AS tenant_id, t.status AS tenant_status, m.status AS membership_status, m.roles
         FROM ca_meta_principals AS p
         INNER JOIN ca_meta_memberships AS m ON m.principal_id = p.id AND m.principal_kind = p.kind
         INNER JOIN ca_meta_tenants AS t ON t.id = m.tenant_id
         WHERE p.id = ? AND p.kind = 'USER' AND p.status = 'ACTIVE' AND m.tenant_id = ?
           AND m.status = 'ACTIVE' AND t.status = 'ACTIVE' LIMIT 1 FOR UPDATE`,
        [session.principal_id, input.requestedTenantId],
      );
      const membership = membershipRows[0];
      if (!validMembership(membership, input.requestedTenantId)) throw new IdentityDeniedError();
      const roles = safeRoles(membership.roles);
      await connection.execute(
        `UPDATE ca_meta_portal_sessions
         SET tenant_id = ?, context_version = context_version + 1, context_ref_hash = ?, csrf_token_hash = ?,
             last_seen_at = UTC_TIMESTAMP(6), idle_expires_at = LEAST(absolute_expires_at, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND))
         WHERE id = ? AND context_version = ? AND tenant_id = ? AND context_ref_hash = ? AND revoked_at IS NULL`,
        [input.requestedTenantId, input.contextRefHash, input.csrfTokenHash, this.idleTimeoutSeconds, input.session.sessionId,
          input.session.contextVersion, input.session.tenantId, input.session.contextRefHash],
      );
      await connection.commit();
      return Object.freeze({
        contextVersion: input.session.contextVersion + 1,
        roles,
        expiresAt: dateValue(session.absolute_expires_at).toISOString(),
      });
    } catch (error) {
      await rollback(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  async revokeSession(sessionId: string, principalId: string): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE ca_meta_portal_sessions SET revoked_at = UTC_TIMESTAMP(6)
       WHERE id = ? AND principal_id = ? AND revoked_at IS NULL`, [sessionId, principalId],
    );
    return result.affectedRows === 1;
  }

  async revokeAuthorizedSession(actor: VerifiedPortalSession, targetSessionId: string): Promise<void> {
    const connection = await this.pool.getConnection();
    await connection.beginTransaction();
    try {
      const [actorRows] = await connection.execute<ActiveSessionRow[]>(
        `SELECT id, principal_id, tenant_id, context_version, context_ref_hash, csrf_token_hash,
                idle_expires_at, absolute_expires_at
         FROM ca_meta_portal_sessions
         WHERE id = ? AND principal_id = ? AND tenant_id = ? AND revoked_at IS NULL
           AND idle_expires_at > UTC_TIMESTAMP(6) AND absolute_expires_at > UTC_TIMESTAMP(6)
         FOR UPDATE`,
        [actor.sessionId, actor.principalId, actor.tenantId],
      );
      const actorRow = actorRows[0];
      if (!actorRow || Number(actorRow.context_version) !== actor.contextVersion || actorRow.context_ref_hash !== actor.contextRefHash) {
        throw new IdentityDeniedError('CONTEXT_CHANGED');
      }

      const [membershipRows] = await connection.execute<PrincipalMembershipRow[]>(
        `SELECT p.id AS principal_id, p.kind AS principal_kind, p.status AS principal_status,
                t.id AS tenant_id, t.status AS tenant_status, m.status AS membership_status, m.roles
         FROM ca_meta_principals AS p
         INNER JOIN ca_meta_memberships AS m ON m.principal_id = p.id AND m.principal_kind = p.kind
         INNER JOIN ca_meta_tenants AS t ON t.id = m.tenant_id
         WHERE p.id = ? AND p.kind = 'USER' AND p.status = 'ACTIVE'
           AND m.tenant_id = ? AND m.status = 'ACTIVE' AND t.status = 'ACTIVE'
         LIMIT 1 FOR UPDATE`,
        [actor.principalId, actor.tenantId],
      );
      const membership = membershipRows[0];
      if (!validMembership(membership, actor.tenantId)) throw new IdentityDeniedError();
      safeRoles(membership.roles);

      const [targetRows] = await connection.execute<Array<RowDataPacket & {
        readonly id: string; readonly principal_id: string; readonly tenant_id: string;
      }>>(
        `SELECT id, principal_id, tenant_id FROM ca_meta_portal_sessions WHERE id = ? FOR UPDATE`, [targetSessionId],
      );
      const target = targetRows[0];
      if (!target || target.principal_id !== actor.principalId || target.tenant_id !== actor.tenantId) {
        throw new IdentityDeniedError();
      }
      await connection.execute(
        `UPDATE ca_meta_portal_sessions SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP(6))
         WHERE id = ? AND principal_id = ? AND tenant_id = ?`,
        [targetSessionId, actor.principalId, actor.tenantId],
      );
      await connection.commit();
    } catch (error) {
      await rollback(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.cleanupTimer);
    await this.cleanupInFlight?.catch(() => undefined);
    await this.pool.end();
  }
}
