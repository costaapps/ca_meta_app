import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createPool, type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import type { ApiEnvironment } from '../config/environment.js';
import { IdentityDeniedError } from '../identity/identity.errors.js';
import { parseMembershipRoles } from '../identity/mysql-identity.repository.js';
import type { MembershipRole } from '../identity/identity.types.js';
import type {
  InvitedIdentityTarget,
  MagicLinkDeliveryClaim,
  MagicLinkIssuedSession,
  MagicLinkSessionMaterial,
  MagicLinkStore,
  MagicLinkTenantOption,
} from './magic-link.store.js';

interface IdentityTargetRow extends RowDataPacket {
  principal_id: string;
  tenant_id: string;
  membership_version: number | string;
}

interface DeliveryRow extends RowDataPacket {
  queue_id: string;
  link_id: string;
  recipient_ciphertext: Buffer;
}

interface MagicLinkRow extends RowDataPacket {
  id: string;
  purpose: string;
  principal_id: string;
  tenant_id: string;
  membership_version: number | string;
  expires_at: string;
  attempt_count: number | string;
  max_attempts: number | string;
  consumed_at: string | null;
}

interface MembershipRow extends RowDataPacket {
  principal_id: string;
  principal_kind: string;
  principal_status: string;
  tenant_id: string;
  tenant_status: string;
  membership_status: string;
  roles: unknown;
}

interface SessionExpiryRow extends RowDataPacket {
  absolute_expires_at: string;
}

function dateValue(value: string): Date {
  return new Date(`${value.replace(' ', 'T')}Z`);
}

function encodeRecipient(value: string, recoveryKey: string): Buffer {
  const key = createHmac('sha256', recoveryKey).update('magic-link-recipient-key-v1', 'utf8').digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
}

function decodeRecipient(value: Buffer, recoveryKey: string): string {
  if (value.length < 29) throw new Error('Invalid local mail queue payload.');
  const key = createHmac('sha256', recoveryKey).update('magic-link-recipient-key-v1', 'utf8').digest();
  const nonce = value.subarray(0, 12);
  const tag = value.subarray(12, 28);
  const ciphertext = value.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function safeRoles(value: unknown): readonly MembershipRole[] {
  try {
    const roles = parseMembershipRoles(value);
    if (roles.length === 0) throw new Error('Empty roles.');
    return roles;
  } catch {
    throw new IdentityDeniedError();
  }
}

function isActiveMembership(row: MembershipRow | undefined, principalId: string, tenantId: string): row is MembershipRow {
  return !!row && row.principal_id === principalId && row.tenant_id === tenantId &&
    row.principal_kind === 'USER' && row.principal_status === 'ACTIVE' &&
    row.tenant_status === 'ACTIVE' && row.membership_status === 'ACTIVE';
}

async function rollback(connection: PoolConnection): Promise<void> {
  await connection.rollback().catch(() => undefined);
}

@Injectable()
export class MysqlMagicLinkStore implements MagicLinkStore, OnApplicationShutdown {
  private readonly pool: Pool;
  private readonly idleTimeoutSeconds: number;
  private readonly absoluteTimeoutSeconds: number;

  constructor(private readonly environment: ApiEnvironment) {
    this.idleTimeoutSeconds = environment.portalSessionIdleTimeoutSeconds;
    this.absoluteTimeoutSeconds = environment.portalSessionAbsoluteTimeoutSeconds;
    this.pool = createPool({
      host: environment.database.host,
      port: environment.database.port,
      database: environment.database.name,
      user: environment.database.user,
      password: environment.database.password,
      connectTimeout: environment.database.connectTimeoutMs,
      connectionLimit: 8,
      waitForConnections: true,
      queueLimit: 100,
      multipleStatements: false,
      charset: 'utf8mb4',
      dateStrings: true,
      timezone: 'Z',
    });
  }

  async findEligibleTarget(emailHash: string): Promise<InvitedIdentityTarget | undefined> {
    const [rows] = await this.pool.execute<IdentityTargetRow[]>(
      `SELECT p.id AS principal_id, m.tenant_id, m.version AS membership_version
       FROM ca_meta_magic_link_identities AS i
       INNER JOIN ca_meta_principals AS p ON p.id = i.principal_id
       INNER JOIN ca_meta_memberships AS m ON m.principal_id = p.id AND m.principal_kind = p.kind
       INNER JOIN ca_meta_tenants AS t ON t.id = m.tenant_id
       WHERE i.email_hash = ? AND i.verified_at IS NOT NULL AND i.revoked_at IS NULL
         AND p.kind = 'USER' AND p.status = 'ACTIVE'
         AND m.status = 'ACTIVE' AND t.status = 'ACTIVE'
       ORDER BY m.tenant_id ASC LIMIT 1`,
      [emailHash],
    );
    const row = rows[0];
    return row ? Object.freeze({ principalId: row.principal_id, tenantId: row.tenant_id, membershipVersion: Number(row.membership_version) }) : undefined;
  }

  async enqueueForInvitedIdentity(input: {
    readonly emailHash: string;
    readonly recipient: string;
    readonly target: InvitedIdentityTarget;
    readonly linkId: string;
    readonly tokenHash: string;
  }): Promise<boolean> {
    const connection = await this.pool.getConnection();
    await connection.beginTransaction();
    try {
      const [rows] = await connection.execute<IdentityTargetRow[]>(
        `SELECT p.id AS principal_id, m.tenant_id, m.version AS membership_version
         FROM ca_meta_magic_link_identities AS i
         INNER JOIN ca_meta_principals AS p ON p.id = i.principal_id
         INNER JOIN ca_meta_memberships AS m ON m.principal_id = p.id AND m.principal_kind = p.kind
         INNER JOIN ca_meta_tenants AS t ON t.id = m.tenant_id
         WHERE i.email_hash = ? AND i.principal_id = ? AND m.tenant_id = ?
           AND i.verified_at IS NOT NULL AND i.revoked_at IS NULL
           AND p.kind = 'USER' AND p.status = 'ACTIVE'
           AND m.status = 'ACTIVE' AND m.version = ? AND t.status = 'ACTIVE'
         LIMIT 1 FOR UPDATE`,
        [input.emailHash, input.target.principalId, input.target.tenantId, input.target.membershipVersion],
      );
      if (!rows[0]) {
        await connection.commit();
        return false;
      }
      const queueId = randomBytes(16).toString('hex');
      await connection.execute(
        `INSERT INTO ca_meta_magic_links
         (id, token_hash, purpose, principal_id, tenant_id, membership_version, created_at, expires_at, attempt_count, max_attempts, consumed_at)
         VALUES (?, ?, 'PORTAL_LOGIN', ?, ?, ?, UTC_TIMESTAMP(6), DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 10 MINUTE), 0, 5, NULL)`,
        [input.linkId, input.tokenHash, input.target.principalId, input.target.tenantId, input.target.membershipVersion],
      );
      await connection.execute(
        `INSERT INTO ca_meta_magic_link_mail_queue
         (id, magic_link_id, tenant_id, request_fingerprint, window_start, recipient_ciphertext,
          status, attempt_count, max_attempts, available_at, lease_owner, lease_expires_at, created_at, delivered_at)
         VALUES (?, ?, ?, ?, FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(UTC_TIMESTAMP(6)) / 60) * 60), ?,
                 'QUEUED', 0, 1, UTC_TIMESTAMP(6), NULL, NULL, UTC_TIMESTAMP(6), NULL)`,
        [queueId, input.linkId, input.target.tenantId, input.emailHash,
          encodeRecipient(input.recipient, this.environment.portalSessionRecoveryKey)],
      );
      await connection.commit();
      return true;
    } catch (error) {
      await rollback(connection);
      const mysqlError = error as NodeJS.ErrnoException;
      if (mysqlError.code === 'ER_DUP_ENTRY' || mysqlError.code === 'ER_DUP_KEY') return false;
      throw error;
    } finally {
      connection.release();
    }
  }

  async claimNextMail(leaseOwner: string): Promise<MagicLinkDeliveryClaim | undefined> {
    const connection = await this.pool.getConnection();
    await connection.beginTransaction();
    try {
      const [rows] = await connection.execute<DeliveryRow[]>(
        `SELECT q.id AS queue_id, q.magic_link_id AS link_id, q.recipient_ciphertext
         FROM ca_meta_magic_link_mail_queue AS q
         INNER JOIN ca_meta_magic_links AS l ON l.id = q.magic_link_id
         INNER JOIN ca_meta_principals AS p ON p.id = l.principal_id
         INNER JOIN ca_meta_memberships AS m ON m.principal_id = p.id AND m.tenant_id = l.tenant_id AND m.principal_kind = p.kind
         INNER JOIN ca_meta_tenants AS t ON t.id = m.tenant_id
         WHERE l.purpose = 'PORTAL_LOGIN' AND l.consumed_at IS NULL AND l.expires_at > UTC_TIMESTAMP(6)
           AND p.kind = 'USER' AND p.status = 'ACTIVE' AND m.status = 'ACTIVE' AND t.status = 'ACTIVE'
           AND q.attempt_count < q.max_attempts AND q.status = 'QUEUED'
           AND q.available_at <= UTC_TIMESTAMP(6)
         ORDER BY q.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      const row = rows[0];
      if (!row) {
        await connection.commit();
        return undefined;
      }
      await connection.execute(
        `UPDATE ca_meta_magic_link_mail_queue
         SET status = 'PROCESSING', attempt_count = attempt_count + 1,
             lease_owner = ?, lease_expires_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 60 SECOND)
         WHERE id = ?`,
        [leaseOwner, row.queue_id],
      );
      await connection.commit();
      return Object.freeze({
        queueId: row.queue_id,
        linkId: row.link_id,
        recipient: decodeRecipient(row.recipient_ciphertext, this.environment.portalSessionRecoveryKey),
      });
    } catch (error) {
      await rollback(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  async markMailDelivered(queueId: string, leaseOwner: string): Promise<void> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE ca_meta_magic_link_mail_queue
       SET status = 'DELIVERED', lease_owner = NULL, lease_expires_at = NULL, delivered_at = UTC_TIMESTAMP(6)
       WHERE id = ? AND status = 'PROCESSING' AND lease_owner = ?`,
      [queueId, leaseOwner],
    );
    if (result.affectedRows !== 1) throw new Error('Magic-link delivery lease was lost.');
  }

  async markMailFailed(queueId: string, leaseOwner: string): Promise<void> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE ca_meta_magic_link_mail_queue
       SET status = 'DEAD',
           lease_owner = NULL, lease_expires_at = NULL
       WHERE id = ? AND status = 'PROCESSING' AND lease_owner = ?`,
      [queueId, leaseOwner],
    );
    if (result.affectedRows !== 1) throw new Error('Magic-link delivery lease was lost.');
  }

  async consumeAndIssueSession(tokenHash: string, material: MagicLinkSessionMaterial): Promise<MagicLinkIssuedSession> {
    const connection = await this.pool.getConnection();
    await connection.beginTransaction();
    let committed = false;
    try {
      const [linkRows] = await connection.execute<MagicLinkRow[]>(
        `SELECT id, purpose, principal_id, tenant_id, membership_version, expires_at, attempt_count, max_attempts, consumed_at
         FROM ca_meta_magic_links WHERE token_hash = ? LIMIT 1 FOR UPDATE`,
        [tokenHash],
      );
      const link = linkRows[0];
      if (!link) throw new IdentityDeniedError();

      const priorAttempts = Number(link.attempt_count);
      const maximumAttempts = Number(link.max_attempts);
      if (!Number.isSafeInteger(priorAttempts) || !Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1) {
        throw new IdentityDeniedError();
      }
      if (priorAttempts < maximumAttempts) {
        await connection.execute(
          'UPDATE ca_meta_magic_links SET attempt_count = attempt_count + 1 WHERE id = ?',
          [link.id],
        );
      }
      const [validityRows] = await connection.execute<Array<RowDataPacket & { link_valid: number }>>(
        `SELECT (? = 'PORTAL_LOGIN' AND ? IS NULL AND ? > UTC_TIMESTAMP(6) AND ? < ?) AS link_valid`,
        [link.purpose, link.consumed_at, link.expires_at, priorAttempts, maximumAttempts],
      );
      if (Number(validityRows[0]?.link_valid ?? 0) !== 1) {
        await connection.commit();
        committed = true;
        throw new IdentityDeniedError();
      }

      const [membershipRows] = await connection.execute<MembershipRow[]>(
        `SELECT p.id AS principal_id, p.kind AS principal_kind, p.status AS principal_status,
                t.id AS tenant_id, t.status AS tenant_status, m.status AS membership_status, m.roles
         FROM ca_meta_principals AS p
         INNER JOIN ca_meta_memberships AS m ON m.principal_id = p.id AND m.principal_kind = p.kind
         INNER JOIN ca_meta_tenants AS t ON t.id = m.tenant_id
         WHERE p.id = ? AND m.tenant_id = ? AND p.kind = 'USER' AND p.status = 'ACTIVE'
           AND m.status = 'ACTIVE' AND m.version = ? AND t.status = 'ACTIVE'
         LIMIT 1 FOR UPDATE`,
        [link.principal_id, link.tenant_id, link.membership_version],
      );
      const membership = membershipRows[0];
      if (!isActiveMembership(membership, link.principal_id, link.tenant_id)) {
        await connection.commit();
        committed = true;
        throw new IdentityDeniedError();
      }
      const roles = safeRoles(membership.roles);

      if (material.priorSessionSecretHash && /^[a-f0-9]{64}$/.test(material.priorSessionSecretHash)) {
        await connection.execute(
          `UPDATE ca_meta_portal_sessions
           SET revoked_at = UTC_TIMESTAMP(6)
           WHERE secret_hash = ? AND revoked_at IS NULL AND idle_expires_at > UTC_TIMESTAMP(6)
             AND absolute_expires_at > UTC_TIMESTAMP(6)`,
          [material.priorSessionSecretHash],
        );
      }

      await connection.execute(
        `INSERT INTO ca_meta_portal_sessions
         (id, principal_id, tenant_id, secret_hash, csrf_token_hash, context_ref_hash, context_version,
          created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6),
                 DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND), DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND), NULL)`,
        [material.sessionId, link.principal_id, link.tenant_id, material.sessionCookieHash,
          material.csrfTokenHash, material.contextRefHash, this.idleTimeoutSeconds, this.absoluteTimeoutSeconds],
      );
      const [consumeResult] = await connection.execute<ResultSetHeader>(
        `UPDATE ca_meta_magic_links SET consumed_at = UTC_TIMESTAMP(6)
         WHERE id = ? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP(6) AND attempt_count <= max_attempts`,
        [link.id],
      );
      if (consumeResult.affectedRows !== 1) throw new IdentityDeniedError();

      const [tenantRows] = await connection.execute<MembershipRow[]>(
        `SELECT p.id AS principal_id, p.kind AS principal_kind, p.status AS principal_status,
                t.id AS tenant_id, t.status AS tenant_status, m.status AS membership_status, m.roles
         FROM ca_meta_principals AS p
         INNER JOIN ca_meta_memberships AS m ON m.principal_id = p.id AND m.principal_kind = p.kind
         INNER JOIN ca_meta_tenants AS t ON t.id = m.tenant_id
         WHERE p.id = ? AND p.kind = 'USER' AND p.status = 'ACTIVE'
           AND m.status = 'ACTIVE' AND t.status = 'ACTIVE' ORDER BY t.id ASC`,
        [link.principal_id],
      );
      const availableTenants: readonly MagicLinkTenantOption[] = Object.freeze(tenantRows
        .filter((row) => row.principal_id === link.principal_id && row.principal_kind === 'USER' &&
          row.principal_status === 'ACTIVE' && row.membership_status === 'ACTIVE' && row.tenant_status === 'ACTIVE')
        .map((row) => Object.freeze({ tenantRef: row.tenant_id, roles: Object.freeze([...safeRoles(row.roles)]) })));
      if (availableTenants.length === 0 || !availableTenants.some((option) => option.tenantRef === link.tenant_id)) {
        throw new IdentityDeniedError();
      }

      const [expiryRows] = await connection.execute<SessionExpiryRow[]>(
        'SELECT absolute_expires_at FROM ca_meta_portal_sessions WHERE id = ? LIMIT 1', [material.sessionId],
      );
      const absoluteExpiresAt = expiryRows[0]?.absolute_expires_at;
      if (!absoluteExpiresAt) throw new Error('Portal session expiry could not be read back.');
      await connection.commit();
      committed = true;
      return Object.freeze({
        ...material,
        principalId: link.principal_id,
        tenantId: link.tenant_id,
        roles,
        expiresAt: dateValue(absoluteExpiresAt).toISOString(),
        availableTenants,
      });
    } catch (error) {
      if (!committed) await rollback(connection);
      const mysqlError = error as NodeJS.ErrnoException;
      if (mysqlError.code === 'ER_DUP_ENTRY' || mysqlError.code === 'ER_DUP_KEY') throw new IdentityDeniedError();
      throw error;
    } finally {
      connection.release();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
