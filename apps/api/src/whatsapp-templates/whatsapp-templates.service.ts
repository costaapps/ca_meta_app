import { createHash } from 'node:crypto';
import type { components } from '@ca-meta/contracts';
import { IdentityDeniedError } from '../identity/identity.errors.js';
import { isVerifiedPortalSession, type VerifiedPortalSession } from '../identity/identity.trust.js';
import type { AuthorizedTenantScope, TenantOperation } from '../identity/identity.types.js';
import type { VerifiedServiceTenantScope } from '../identity/identity.types.js';
import { isVerifiedServiceTenantScope, TenantAuthorizationService, TenantContextService } from '../identity/identity.service.js';
import type { MetaEnvironment } from '../meta-assets/meta-assets.types.js';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { DurableJobStore } from '../jobs/job-store.js';
import { TemplateInputError, parseTemplateCreateRequest, type TemplateCreateRequest } from './template-body.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9._~+/%=-]{1,512}$/;
const PROVIDER_ID = /^\d{1,32}$/;

export interface WhatsAppTemplatesAccount {
  readonly tenantId: string;
  readonly assetId: string;
  readonly appConfigurationId: string;
  readonly environment: MetaEnvironment;
  /** Internal server-only mapping; never read from a browser request or returned by this service. */
  readonly providerWabaId: string;
}

export interface WhatsAppTemplatesAccountDirectory {
  resolve(scope: AuthorizedTenantScope, assetId: string): Promise<WhatsAppTemplatesAccount | undefined>;
  resolveForWorker(scope: VerifiedServiceTenantScope, assetId: string, appConfigurationId: string,
    environment: MetaEnvironment): Promise<WhatsAppTemplatesAccount | undefined>;
}

export interface WhatsAppTemplatesProvider {
  list(account: WhatsAppTemplatesAccount, input: { readonly cursor?: string; readonly limit: number; readonly requestId: string }):
    Promise<components['schemas']['TemplateListPage']>;
}

export const META_WHATSAPP_TEMPLATES_ACCOUNT_DIRECTORY = Symbol('META_WHATSAPP_TEMPLATES_ACCOUNT_DIRECTORY');
export const META_WHATSAPP_TEMPLATES_PROVIDER = Symbol('META_WHATSAPP_TEMPLATES_PROVIDER');
/** Set true only when the reviewed API admission and matching worker adapter are both installed. */
export const META_WHATSAPP_TEMPLATES_CREATE_ENABLED = Symbol('META_WHATSAPP_TEMPLATES_CREATE_ENABLED');

export class WhatsAppTemplateNotFoundError extends Error {
  constructor() { super('WhatsApp template account was not found.'); this.name = 'WhatsAppTemplateNotFoundError'; }
}
export class WhatsAppTemplatesUnavailableError extends Error {
  constructor() { super('WhatsApp template operations are unavailable.'); this.name = 'WhatsAppTemplatesUnavailableError'; }
}
export class WhatsAppTemplateIdempotencyConflictError extends Error {
  constructor() { super('The template idempotency key was already used for a different request.'); this.name = 'WhatsAppTemplateIdempotencyConflictError'; }
}

/** Only a server-resolved, verified WABA asset with a candidate operation grant is an eligible target. */
export class MysqlWhatsAppTemplatesAccountDirectory implements WhatsAppTemplatesAccountDirectory {
  constructor(private readonly database: DurableWorkDatabase, private readonly environment: MetaEnvironment) {}

  async resolve(scope: AuthorizedTenantScope, assetId: string): Promise<WhatsAppTemplatesAccount | undefined> {
    if (!UUID.test(scope.tenantId) || !UUID.test(assetId)) return undefined;
    return await this.resolveForTenant(scope.tenantId, assetId, this.environment);
  }

  async resolveForWorker(scope: VerifiedServiceTenantScope, assetId: string, appConfigurationId: string,
    environment: MetaEnvironment): Promise<WhatsAppTemplatesAccount | undefined> {
    if (!isVerifiedServiceTenantScope(scope) || !UUID.test(scope.tenantId) || !UUID.test(assetId) ||
        !UUID.test(appConfigurationId) || environment !== this.environment) return undefined;
    return await this.resolveForTenant(scope.tenantId, assetId, environment, appConfigurationId);
  }

  private async resolveForTenant(tenantId: string, assetId: string, environment: MetaEnvironment,
    appConfigurationId?: string): Promise<WhatsAppTemplatesAccount | undefined> {
    const database = await this.database.getDataSource();
    const rows = await database.query(
      `SELECT a.id AS asset_id, a.tenant_id, a.app_configuration_id, a.environment, a.external_id AS provider_waba_id
       FROM ca_meta_assets a
       WHERE a.tenant_id = ? AND a.id = ? AND a.provider = 'META' AND a.environment = ?
         AND (? IS NULL OR a.app_configuration_id = ?)
         AND a.asset_kind = 'WHATSAPP_BUSINESS_ACCOUNT'
         AND EXISTS (
           SELECT 1
           FROM ca_meta_asset_authorizations aa
           INNER JOIN ca_meta_authorizations auth ON auth.tenant_id = aa.tenant_id
             AND auth.id = aa.authorization_id AND auth.app_configuration_id = aa.app_configuration_id
             AND auth.provider = aa.provider AND auth.environment = aa.environment
           INNER JOIN ca_meta_asset_grants g ON g.tenant_id = aa.tenant_id
             AND g.authorization_id = aa.authorization_id AND g.asset_id = aa.asset_id
             AND g.app_configuration_id = aa.app_configuration_id AND g.provider = aa.provider
             AND g.environment = aa.environment
           WHERE aa.tenant_id = a.tenant_id AND aa.asset_id = a.id
             AND aa.app_configuration_id = a.app_configuration_id AND aa.provider = a.provider
             AND aa.environment = a.environment AND aa.state = 'ACTIVE' AND aa.verification_state = 'VERIFIED'
             AND auth.authorization_state IN ('ACTIVE', 'PARTIAL')
             AND auth.flow_variant = 'WHATSAPP_EXCLUSIVE' AND auth.auth_variant = 'WHATSAPP_EMBEDDED_SIGNUP'
             AND g.grant_name = 'whatsapp_business_management' AND g.status = 'GRANTED'
         )
       LIMIT 1`,
      [tenantId, assetId, environment, appConfigurationId ?? null, appConfigurationId ?? null],
    ) as Array<{ asset_id: string; tenant_id: string; app_configuration_id: string; environment: string; provider_waba_id: string }>;
    const row = rows[0];
    if (!row || row.asset_id !== assetId || row.tenant_id !== tenantId ||
        !UUID.test(row.app_configuration_id) || row.environment !== environment || !PROVIDER_ID.test(row.provider_waba_id)) return undefined;
    return Object.freeze({ tenantId: row.tenant_id, assetId: row.asset_id, appConfigurationId: row.app_configuration_id,
      environment: this.environment, providerWabaId: row.provider_waba_id });
  }
}

export class WhatsAppTemplatesService {
  constructor(
    private readonly contexts: TenantContextService,
    private readonly authorization: TenantAuthorizationService,
    private readonly accounts: WhatsAppTemplatesAccountDirectory,
    private readonly provider: WhatsAppTemplatesProvider | null,
    private readonly createEnabled: boolean,
    private readonly database: DurableWorkDatabase,
    private readonly jobs: DurableJobStore,
  ) {}

  async list(session: VerifiedPortalSession, tenantContextRef: string, assetId: string,
    input: { readonly cursor?: string; readonly limit: number }, requestId: string):
    Promise<components['schemas']['TemplateListPage']> {
    if (!validPagination(input)) throw new TemplateInputError();
    const { account } = await this.authorizedAccount(session, tenantContextRef, assetId, 'CONNECT');
    if (!this.provider) throw new WhatsAppTemplatesUnavailableError();
    try {
      const page = await this.provider.list(account, { ...input, requestId });
      return sanitizeTemplatePage(page, requestId);
    } catch (error) {
      if (error instanceof TemplateInputError || error instanceof WhatsAppTemplatesUnavailableError) throw error;
      throw new WhatsAppTemplatesUnavailableError();
    }
  }

  async create(session: VerifiedPortalSession, tenantContextRef: string, assetId: string, idempotencyKey: string,
    body: unknown, requestId: string): Promise<components['schemas']['JobAccepted']> {
    if (!/^[A-Za-z0-9._~-]{16,128}$/.test(idempotencyKey)) throw new TemplateInputError();
    const request = parseTemplateCreateRequest(body);
    const { scope, account } = await this.authorizedAccount(session, tenantContextRef, assetId, 'CONNECT');
    if (!this.createEnabled) throw new WhatsAppTemplatesUnavailableError();

    const digest = createHash('sha256').update(idempotencyKey, 'utf8').digest('hex');
    const correlationId = stableCorrelationId(scope.tenantId, digest);
    const dataSource = await this.database.getDataSource();
    let jobId: string;
    try {
      const queued = await dataSource.transaction((manager) => this.jobs.enqueueWithin(manager, {
        tenantId: scope.tenantId,
        type: 'TEMPLATE_CREATE',
        idempotencyKey: `templates:${digest}`,
        correlationId,
        resourceScopeRef: account.assetId,
        payload: { kind: 'TEMPLATE_CREATE', assetId: account.assetId,
          appConfigurationId: account.appConfigurationId, environment: account.environment, request },
      }));
      jobId = queued.id;
    } catch (error) {
      if (error instanceof Error && error.message === 'Idempotency key conflicts with an existing job.') {
        throw new WhatsAppTemplateIdempotencyConflictError();
      }
      throw new WhatsAppTemplatesUnavailableError();
    }
    return Object.freeze({ jobId, status: 'PENDING', location: `/api/v1/jobs/${jobId}`, requestId });
  }

  private async authorizedAccount(session: VerifiedPortalSession, tenantContextRef: string, assetId: string,
    operation: TenantOperation): Promise<{ readonly scope: AuthorizedTenantScope; readonly account: WhatsAppTemplatesAccount }> {
    if (!isVerifiedPortalSession(session) || !UUID.test(assetId)) throw new WhatsAppTemplateNotFoundError();
    let scope: AuthorizedTenantScope;
    try {
      scope = await this.contexts.resolveCurrent(session, tenantContextRef);
      await this.authorization.authorize(scope, operation, scope.tenantId);
    } catch (error) {
      if (error instanceof IdentityDeniedError) throw error;
      throw new WhatsAppTemplateNotFoundError();
    }
    const account = await this.accounts.resolve(scope, assetId);
    if (!account || account.tenantId !== scope.tenantId || account.assetId !== assetId || !UUID.test(account.appConfigurationId) ||
        !['development', 'test', 'staging', 'production'].includes(account.environment) || !PROVIDER_ID.test(account.providerWabaId)) {
      throw new WhatsAppTemplateNotFoundError();
    }
    return Object.freeze({ scope, account });
  }
}

function validPagination(input: { readonly cursor?: string; readonly limit: number }): boolean {
  return Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 100 &&
    (input.cursor === undefined || CURSOR.test(input.cursor));
}

function sanitizeTemplatePage(value: unknown, requestId: string): components['schemas']['TemplateListPage'] {
  if (!record(value) || !Array.isArray(value.items) || value.items.length > 100 ||
      !(value.nextCursor === null || (typeof value.nextCursor === 'string' && CURSOR.test(value.nextCursor)))) {
    throw new WhatsAppTemplatesUnavailableError();
  }
  const items: components['schemas']['Template'][] = [];
  for (const item of value.items) {
    if (!record(item) || typeof item.id !== 'string' || item.id.length < 1 || item.id.length > 128 ||
        typeof item.name !== 'string' || item.name.length < 1 || item.name.length > 128 ||
        typeof item.language !== 'string' || item.language.length < 2 || item.language.length > 16 ||
        typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))) {
      throw new WhatsAppTemplatesUnavailableError();
    }
    // Exact current provider status/category meanings are Not confirmed; do not infer approval.
    items.push(Object.freeze({ id: item.id, name: item.name, language: item.language, status: 'UNKNOWN', category: 'UNKNOWN',
      updatedAt: new Date(item.updatedAt).toISOString() }));
  }
  return Object.freeze({ items: Object.freeze(items), nextCursor: value.nextCursor as string | null, requestId });
}

function stableCorrelationId(tenantId: string, digest: string): string {
  const bytes = createHash('sha256').update(`TEMPLATE_CREATE\0${tenantId}\0${digest}`).digest();
  const hex = bytes.toString('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
