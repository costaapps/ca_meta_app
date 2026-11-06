import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise';
import type { ApiEnvironment } from '../config/environment.js';
import type { IdentityRepository, LegacyTenantMapping } from './identity.repository.js';
import type {
  MembershipRole,
  MembershipStatus,
  PrincipalIdentity,
  PrincipalKind,
  PrincipalStatus,
  ServiceScope,
  ServiceTenantGrant,
  TenantMembership,
  TenantStatus,
} from './identity.types.js';

const MEMBERSHIP_ROLES = new Set<MembershipRole>(['owner', 'admin', 'operator', 'viewer']);
const SERVICE_SCOPES = new Set<ServiceScope>([
  'TENANT_RESOURCE_READ',
  'META_CONNECTION_EXECUTE',
  'CREDENTIAL_USE',
  'WEBHOOK_ROUTE',
  'MAGIC_LINK_DELIVERY',
]);

interface PrincipalRow extends RowDataPacket {
  id: string;
  kind: string;
  issuer: string;
  subject: string;
  status: string;
  version: number | string;
}

interface MembershipRow extends RowDataPacket {
  tenant_id: string;
  principal_id: string;
  principal_kind: string;
  principal_status: string;
  tenant_status: string;
  roles: unknown;
  status: string;
  version: number | string;
}

interface ServiceGrantRow extends RowDataPacket {
  tenant_id: string;
  principal_id: string;
  principal_kind: string;
  principal_status: string;
  tenant_status: string;
  scope: string;
}

interface LegacyMappingRow extends RowDataPacket {
  tenant_id: string;
  legacy_database_id: string;
  legacy_company_id: string;
  environment: string;
}

function enumValue<T extends string>(value: string, values: ReadonlySet<T>): T {
  if (!values.has(value as T)) throw new Error('Identity data contains an unsupported enum value.');
  return value as T;
}

function parseRoles(value: unknown): readonly MembershipRole[] {
  let roles: unknown = value;
  if (typeof roles === 'string') {
    try {
      roles = JSON.parse(roles) as unknown;
    } catch {
      throw new Error('Identity data contains an invalid role set.');
    }
  }
  if (!Array.isArray(roles) || roles.length === 0 || roles.length > MEMBERSHIP_ROLES.size) {
    throw new Error('Identity data contains an invalid role set.');
  }
  const result = roles.map((role) => {
    if (typeof role !== 'string' || !MEMBERSHIP_ROLES.has(role as MembershipRole)) {
      throw new Error('Identity data contains an unsupported role.');
    }
    return role as MembershipRole;
  });
  if (new Set(result).size !== result.length) throw new Error('Identity data contains duplicate roles.');
  return Object.freeze(result);
}

function mapPrincipal(row: PrincipalRow): PrincipalIdentity {
  return Object.freeze({
    id: row.id,
    kind: enumValue<PrincipalKind>(row.kind, new Set(['USER', 'SERVICE'])),
    issuer: row.issuer,
    subject: row.subject,
    status: enumValue<PrincipalStatus>(row.status, new Set(['ACTIVE', 'DISABLED'])),
    version: Number(row.version),
  });
}

function mapMembership(row: MembershipRow): TenantMembership {
  return Object.freeze({
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    principalKind: enumValue<PrincipalKind>(row.principal_kind, new Set(['USER', 'SERVICE'])),
    principalStatus: enumValue<PrincipalStatus>(row.principal_status, new Set(['ACTIVE', 'DISABLED'])),
    tenantStatus: enumValue<TenantStatus>(row.tenant_status, new Set(['ACTIVE', 'SUSPENDED'])),
    roles: parseRoles(row.roles),
    status: enumValue<MembershipStatus>(row.status, new Set(['INVITED', 'ACTIVE', 'REVOKED', 'SUSPENDED'])),
    version: Number(row.version),
  });
}

@Injectable()
export class MysqlIdentityRepository implements IdentityRepository, OnApplicationShutdown {
  private readonly pool: Pool;

  constructor(environment: ApiEnvironment['database']) {
    this.pool = createPool({
      host: environment.host,
      port: environment.port,
      database: environment.name,
      user: environment.user,
      password: environment.password,
      connectTimeout: environment.connectTimeoutMs,
      connectionLimit: 10,
      waitForConnections: true,
      queueLimit: 100,
      multipleStatements: false,
      charset: 'utf8mb4',
      dateStrings: true,
    });
  }

  async findPrincipalByIssuerSubject(issuer: string, subject: string): Promise<PrincipalIdentity | undefined> {
    const [rows] = await this.pool.execute<PrincipalRow[]>(
      `SELECT id, kind, issuer, subject, status, version
       FROM ca_meta_principals WHERE issuer = ? AND subject = ? LIMIT 1`,
      [issuer, subject],
    );
    return rows[0] ? mapPrincipal(rows[0]) : undefined;
  }

  async findMembership(principalId: string, tenantId: string): Promise<TenantMembership | undefined> {
    const [rows] = await this.pool.execute<MembershipRow[]>(
      `SELECT m.tenant_id, m.principal_id, m.principal_kind,
              p.status AS principal_status, t.status AS tenant_status,
              m.roles, m.status, m.version
       FROM ca_meta_memberships AS m
       INNER JOIN ca_meta_principals AS p ON p.kind = m.principal_kind AND p.id = m.principal_id
       INNER JOIN ca_meta_tenants AS t ON t.id = m.tenant_id
       WHERE m.principal_id = ? AND m.tenant_id = ? LIMIT 1`,
      [principalId, tenantId],
    );
    return rows[0] ? mapMembership(rows[0]) : undefined;
  }

  async listActiveMemberships(principalId: string): Promise<readonly TenantMembership[]> {
    const [rows] = await this.pool.execute<MembershipRow[]>(
      `SELECT m.tenant_id, m.principal_id, m.principal_kind,
              p.status AS principal_status, t.status AS tenant_status,
              m.roles, m.status, m.version
       FROM ca_meta_memberships AS m
       INNER JOIN ca_meta_principals AS p ON p.kind = m.principal_kind AND p.id = m.principal_id
       INNER JOIN ca_meta_tenants AS t ON t.id = m.tenant_id
       WHERE m.principal_id = ? AND m.principal_kind = 'USER'
         AND m.status = 'ACTIVE' AND p.status = 'ACTIVE' AND t.status = 'ACTIVE'
       ORDER BY m.tenant_id`,
      [principalId],
    );
    return Object.freeze(rows.map(mapMembership));
  }

  async findServiceTenantGrant(principalId: string, tenantId: string): Promise<ServiceTenantGrant | undefined> {
    const [rows] = await this.pool.execute<ServiceGrantRow[]>(
      `SELECT s.tenant_id, s.principal_id, s.principal_kind,
              p.status AS principal_status, t.status AS tenant_status, s.scope
       FROM ca_meta_service_identity_scopes AS s
       INNER JOIN ca_meta_principals AS p ON p.kind = s.principal_kind AND p.id = s.principal_id
       INNER JOIN ca_meta_tenants AS t ON t.id = s.tenant_id
       WHERE s.principal_id = ? AND s.tenant_id = ? AND s.status = 'ACTIVE'
       ORDER BY s.scope`,
      [principalId, tenantId],
    );
    if (rows.length === 0) return undefined;
    const first = rows[0];
    if (!first) return undefined;
    const scopes = rows.map((row) => enumValue<ServiceScope>(row.scope, SERVICE_SCOPES));
    if (new Set(scopes).size !== scopes.length) throw new Error('Identity data contains duplicate service scopes.');
    return Object.freeze({
      tenantId: first.tenant_id,
      principalId: first.principal_id,
      principalKind: enumValue<PrincipalKind>(first.principal_kind, new Set(['USER', 'SERVICE'])),
      principalStatus: enumValue<PrincipalStatus>(first.principal_status, new Set(['ACTIVE', 'DISABLED'])),
      tenantStatus: enumValue<TenantStatus>(first.tenant_status, new Set(['ACTIVE', 'SUSPENDED'])),
      scopes: Object.freeze(scopes),
    });
  }

  async findLegacyTenantMapping(
    tenantId: string,
    legacyDatabaseId: string,
    legacyCompanyId: string,
    environment: string,
  ): Promise<LegacyTenantMapping | undefined> {
    const [rows] = await this.pool.execute<LegacyMappingRow[]>(
      `SELECT tenant_id, legacy_database_id, legacy_company_id, environment
       FROM ca_meta_tenant_legacy_maps
       WHERE tenant_id = ? AND legacy_database_id = ? AND legacy_company_id = ? AND environment = ? LIMIT 1`,
      [tenantId, legacyDatabaseId, legacyCompanyId, environment],
    );
    const row = rows[0];
    return row ? Object.freeze({
      tenantId: row.tenant_id,
      legacyDatabaseId: row.legacy_database_id,
      legacyCompanyId: row.legacy_company_id,
      environment: row.environment,
    }) : undefined;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

export function parseMembershipRoles(value: unknown): readonly MembershipRole[] {
  return parseRoles(value);
}
