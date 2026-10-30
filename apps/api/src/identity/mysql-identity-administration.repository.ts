import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createPool, type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import type { ApiEnvironment } from '../config/environment.js';
import { IdentityDeniedError } from './identity.errors.js';
import type {
  IdentityAdministrationCommand,
  IdentityAdministrationRepository,
  IdentityAdministrationResult,
} from './identity-administration.repository.js';
import { isAuthorizedTenantScope } from './identity.types.js';
import {
  isVerifiedIdentityAssertion,
  isVerifiedPlatformIdentityAdmin,
  isVerifiedPortalSession,
} from './identity.trust.js';

interface AdminAuditRow extends RowDataPacket {
  authority_kind: string;
  action: string;
  request_hash: string;
  result_tenant_id: string;
  target_principal_id: string | null;
}

interface PrincipalRow extends RowDataPacket {
  id: string;
  kind: string;
  status: string;
}

interface MembershipRow extends RowDataPacket {
  roles: unknown;
  status: string;
  version: number | string;
}

interface OwnerRow extends RowDataPacket {
  principal_id: string;
  roles: unknown;
  status: string;
}

const ADMIN_ROLES = new Set(['owner', 'admin']);

function actorRef(principalId: string): string {
  return createHash('sha256').update(principalId, 'utf8').digest('hex');
}

function roles(value: unknown): readonly string[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) as unknown; } catch { throw new Error('Stored membership roles are invalid.'); }
  }
  if (!Array.isArray(parsed) || parsed.some((role) => typeof role !== 'string')) throw new Error('Stored membership roles are invalid.');
  return parsed as string[];
}

function currentTime(): Date { return new Date(); }

@Injectable()
export class MysqlIdentityAdministrationRepository implements IdentityAdministrationRepository, OnApplicationShutdown {
  private readonly pool: Pool;

  constructor(environment: ApiEnvironment['database']) {
    this.pool = createPool({
      host: environment.host,
      port: environment.port,
      database: environment.name,
      user: environment.user,
      password: environment.password,
      connectTimeout: environment.connectTimeoutMs,
      connectionLimit: 5,
      waitForConnections: true,
      queueLimit: 50,
      multipleStatements: false,
      charset: 'utf8mb4',
      dateStrings: true,
    });
  }

  async execute(command: IdentityAdministrationCommand): Promise<IdentityAdministrationResult> {
    if (!this.isTrustedCommand(command)) throw new IdentityDeniedError();
    try {
      return await this.executeOnce(command);
    } catch (error) {
      // Concurrent identical requests can race at the unique idempotency key; replay after rollback.
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_DUP_ENTRY') {
        return this.executeOnce(command);
      }
      throw error;
    }
  }

  async onApplicationShutdown(): Promise<void> { await this.pool.end(); }

  private isTrustedCommand(command: IdentityAdministrationCommand): boolean {
    if (command.action === 'BOOTSTRAP_TENANT') {
      return isVerifiedPlatformIdentityAdmin(command.actor) && isVerifiedIdentityAssertion(command.target);
    }
    return isVerifiedPortalSession(command.actor) && isAuthorizedTenantScope(command.scope) &&
      command.scope.principalId === command.actor.principalId && command.scope.tenantId === command.actor.tenantId &&
      (command.action === 'REVOKE_MEMBERSHIP' || isVerifiedIdentityAssertion(command.target));
  }

  private async executeOnce(command: IdentityAdministrationCommand): Promise<IdentityAdministrationResult> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const isBootstrap = command.action === 'BOOTSTRAP_TENANT';
      const principalActorId = isBootstrap ? undefined : command.actor.principalId;
      const ref = isBootstrap ? command.actor.actorRef : actorRef(principalActorId as string);
      let tenantActorRoles: readonly string[] | undefined;
      if (!isBootstrap) tenantActorRoles = await this.lockActorMembership(connection, command.actor.principalId, command.scope.tenantId);
      const authority = isBootstrap
        ? 'PLATFORM_IDENTITY_ADMIN'
        : tenantActorRoles?.includes('owner') ? 'TENANT_OWNER' : 'TENANT_ADMIN';
      const existing = await this.findIdempotent(connection, ref, command.idempotencyKey);
      if (existing) {
        if (existing.request_hash !== command.requestHash || existing.action !== command.action || existing.authority_kind !== authority) {
          throw new IdentityAdministrationConflictError();
        }
        await connection.commit();
        return Object.freeze({
          tenantId: existing.result_tenant_id,
          ...(existing.target_principal_id ? { principalId: existing.target_principal_id } : {}),
          replayed: true,
        });
      }

      let tenantId: string;
      let targetPrincipalId: string | undefined;
      let auditTenantId: string | null;
      if (command.action === 'BOOTSTRAP_TENANT') {
        targetPrincipalId = await this.getOrCreatePrincipal(connection, command.target.issuer, command.target.subject);
        tenantId = command.tenantId;
        auditTenantId = tenantId;
        const now = currentTime();
        await connection.execute(
          `INSERT INTO ca_meta_tenants (id, status, version, created_at, updated_at)
           VALUES (?, 'ACTIVE', 1, ?, ?)`, [tenantId, now, now],
        );
        await connection.execute(
          `INSERT INTO ca_meta_memberships
           (tenant_id, principal_id, principal_kind, roles, status, version, created_at, updated_at)
           VALUES (?, ?, 'USER', JSON_ARRAY('owner'), 'ACTIVE', 1, ?, ?)`, [tenantId, targetPrincipalId, now, now],
        );
      } else {
        tenantId = command.scope.tenantId;
        auditTenantId = tenantId;
        const actingRoles = tenantActorRoles ?? [];
        if (!actingRoles.some((role) => ADMIN_ROLES.has(role))) throw new IdentityDeniedError();
        if (command.action === 'GRANT_MEMBERSHIP') {
          if (command.role === 'admin' && !actingRoles.includes('owner')) throw new IdentityDeniedError();
          targetPrincipalId = await this.getOrCreatePrincipal(connection, command.target.issuer, command.target.subject);
          await this.grant(connection, tenantId, targetPrincipalId, command.role);
        } else {
          targetPrincipalId = command.targetPrincipalId;
          await this.revoke(connection, tenantId, actingRoles, targetPrincipalId);
        }
      }

      const now = currentTime();
      await connection.execute(
        `INSERT INTO ca_meta_identity_admin_audit
         (id, authority_kind, actor_ref, tenant_id, action, target_principal_id, reason_code,
          idempotency_key, request_hash, result_tenant_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), authority, ref, auditTenantId, command.action, targetPrincipalId ?? null,
          command.reasonCode, command.idempotencyKey, command.requestHash, tenantId, now],
      );
      await connection.commit();
      return Object.freeze({ tenantId, ...(targetPrincipalId ? { principalId: targetPrincipalId } : {}), replayed: false });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async findIdempotent(
    connection: PoolConnection,
    ref: string,
    idempotencyKey: string,
  ): Promise<AdminAuditRow | undefined> {
    const [rows] = await connection.execute<AdminAuditRow[]>(
      `SELECT authority_kind, action, request_hash, result_tenant_id, target_principal_id
       FROM ca_meta_identity_admin_audit
       WHERE actor_ref = ? AND idempotency_key = ? FOR UPDATE`,
      [ref, idempotencyKey],
    );
    return rows[0];
  }

  private async getOrCreatePrincipal(connection: PoolConnection, issuer: string, subject: string): Promise<string> {
    const [rows] = await connection.execute<PrincipalRow[]>(
      'SELECT id, kind, status FROM ca_meta_principals WHERE issuer = ? AND subject = ? FOR UPDATE', [issuer, subject],
    );
    const existing = rows[0];
    if (existing) {
      if (existing.kind !== 'USER' || existing.status !== 'ACTIVE') throw new IdentityDeniedError();
      return existing.id;
    }
    const id = randomUUID();
    const now = currentTime();
    await connection.execute(
      `INSERT INTO ca_meta_principals (id, kind, issuer, subject, status, version, created_at, updated_at)
       VALUES (?, 'USER', ?, ?, 'ACTIVE', 1, ?, ?)`, [id, issuer, subject, now, now],
    );
    return id;
  }

  private async lockActorMembership(connection: PoolConnection, principalId: string, tenantId: string): Promise<readonly string[]> {
    const [rows] = await connection.execute<MembershipRow[]>(
      `SELECT m.roles, m.status, m.version
       FROM ca_meta_memberships m
       JOIN ca_meta_principals p ON p.id = m.principal_id AND p.kind = 'USER' AND p.status = 'ACTIVE'
       JOIN ca_meta_tenants t ON t.id = m.tenant_id AND t.status = 'ACTIVE'
       WHERE m.tenant_id = ? AND m.principal_id = ? FOR UPDATE`, [tenantId, principalId],
    );
    if (!rows[0] || rows[0].status !== 'ACTIVE') throw new IdentityDeniedError();
    const result = roles(rows[0].roles);
    if (!result.some((role) => ADMIN_ROLES.has(role))) throw new IdentityDeniedError();
    return result;
  }

  private async grant(connection: PoolConnection, tenantId: string, principalId: string, role: string): Promise<void> {
    const [rows] = await connection.execute<MembershipRow[]>(
      'SELECT roles, status, version FROM ca_meta_memberships WHERE tenant_id = ? AND principal_id = ? FOR UPDATE',
      [tenantId, principalId],
    );
    const existing = rows[0];
    if (existing && roles(existing.roles).includes('owner') && role !== 'owner') {
      const owners = await this.activeOwners(connection, tenantId);
      if (owners <= 1) throw new IdentityDeniedError();
    }
    const now = currentTime();
    if (existing) {
      await connection.execute(
        `UPDATE ca_meta_memberships SET roles = JSON_ARRAY(?), status = 'ACTIVE', version = version + 1,
          updated_at = ?, revoked_at = NULL WHERE tenant_id = ? AND principal_id = ?`, [role, now, tenantId, principalId],
      );
    } else {
      await connection.execute(
        `INSERT INTO ca_meta_memberships
         (tenant_id, principal_id, principal_kind, roles, status, version, created_at, updated_at)
         VALUES (?, ?, 'USER', JSON_ARRAY(?), 'ACTIVE', 1, ?, ?)`, [tenantId, principalId, role, now, now],
      );
    }
  }

  private async revoke(
    connection: PoolConnection,
    tenantId: string,
    actingRoles: readonly string[],
    targetPrincipalId: string,
  ): Promise<void> {
    const [rows] = await connection.execute<MembershipRow[]>(
      'SELECT roles, status, version FROM ca_meta_memberships WHERE tenant_id = ? AND principal_id = ? FOR UPDATE',
      [tenantId, targetPrincipalId],
    );
    const target = rows[0];
    if (!target || target.status !== 'ACTIVE') throw new IdentityDeniedError();
    const targetRoles = roles(target.roles);
    if (targetRoles.includes('owner')) {
      if (!actingRoles.includes('owner') || await this.activeOwners(connection, tenantId) <= 1) throw new IdentityDeniedError();
    }
    if (actingRoles.includes('admin') && targetRoles.some((role) => role === 'owner' || role === 'admin')) {
      throw new IdentityDeniedError();
    }
    const now = currentTime();
    await connection.execute(
      `UPDATE ca_meta_memberships SET status = 'REVOKED', version = version + 1, updated_at = ?, revoked_at = ?
       WHERE tenant_id = ? AND principal_id = ?`, [now, now, tenantId, targetPrincipalId],
    );
  }

  private async activeOwners(connection: PoolConnection, tenantId: string): Promise<number> {
    const [rows] = await connection.execute<OwnerRow[]>(
      `SELECT principal_id, roles, status FROM ca_meta_memberships WHERE tenant_id = ? FOR UPDATE`, [tenantId],
    );
    return rows.filter((row) => row.status === 'ACTIVE' && roles(row.roles).includes('owner')).length;
  }
}

export class IdentityAdministrationConflictError extends Error {
  constructor() {
    super('The idempotency key was already used for a different identity administration command.');
    this.name = 'IdentityAdministrationConflictError';
  }
}
