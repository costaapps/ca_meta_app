import type { EntityManager } from 'typeorm';
import type { CredentialResolverService } from '../credentials/credential-resolver.service.js';
import type { CredentialResolverOperation, MetaAuthVariant, MetaFlowVariant } from '../credentials/credential-resolver.types.js';
import type { MetaEnvironment } from '../meta-assets/meta-assets.types.js';
import type { MetaAppConfigRegistry } from '../meta-config/meta-app-config.registry.js';
import type { MetaGraphClient } from '../meta-graph/meta-graph.client.js';
import type { MetaGraphCallResult, MetaGraphExecutionContext, MetaGraphInput, MetaGraphJson } from '../meta-graph/meta-graph.types.js';
import { isVerifiedJobExecutionContext, type VerifiedJobExecutionContext } from '../jobs/job-execution-authorization.js';
import type { ClaimedJob, JobFinalization, JobOutcome } from '../jobs/job-store.js';
import type { JobHandler } from '../worker/durable-worker.js';
import type { JobPayload } from '../jobs/event-validation.js';
import { isVerifiedServiceTenantScope } from '../identity/identity.service.js';
import type { VerifiedServiceTenantScope } from '../identity/identity.types.js';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';

type NotificationActionPayload = Extract<JobPayload, { kind: 'NOTIFICATION_ACTION' }>;
type NotificationActionRequest = NotificationActionPayload['request'];

export interface NotificationActionTarget {
  readonly tenantId: string;
  readonly notificationId: string;
  readonly assetId: string;
  readonly appConfigurationId: string;
  readonly environment: MetaEnvironment;
  readonly assetKind: string;
  readonly providerAssetId: string;
  readonly providerTargetRef: string;
  readonly flowVariant: MetaFlowVariant;
  readonly authVariant: MetaAuthVariant;
}

export interface NotificationActionDirectory {
  resolve(input: {
    readonly serviceScope: VerifiedServiceTenantScope;
    readonly payload: NotificationActionPayload;
  }): Promise<NotificationActionTarget | undefined>;
}

interface NotificationActionTargetRow {
  tenant_id: string;
  notification_id: string;
  asset_id: string;
  app_configuration_id: string;
  environment: string;
  asset_kind: string;
  provider_asset_id: string;
  provider_target_ref: string | null;
  flow_variant: string;
  auth_variant: string;
}

/** Resolves only a notification-owned target and active verified asset authorization in the job tenant. */
export class MysqlNotificationActionDirectory implements NotificationActionDirectory {
  constructor(private readonly database: DurableWorkDatabase) {}

  async resolve(input: { readonly serviceScope: VerifiedServiceTenantScope; readonly payload: NotificationActionPayload }): Promise<NotificationActionTarget | undefined> {
    if (!isVerifiedServiceTenantScope(input.serviceScope) || input.serviceScope.tenantId.length === 0) return undefined;
    const dataSource = await this.database.getDataSource();
    const rows = await dataSource.query(
      `SELECT n.tenant_id, n.id AS notification_id, a.id AS asset_id, a.app_configuration_id,
              a.environment, a.asset_kind, a.external_id AS provider_asset_id, n.provider_target_ref,
              auth.flow_variant, auth.auth_variant
       FROM ca_meta_notifications n
       JOIN ca_meta_assets a ON a.tenant_id = n.tenant_id AND a.id = n.asset_id
       JOIN ca_meta_asset_authorizations aa ON aa.tenant_id = a.tenant_id AND aa.asset_id = a.id
         AND aa.app_configuration_id = a.app_configuration_id AND aa.provider = a.provider AND aa.environment = a.environment
         AND aa.state = 'ACTIVE' AND aa.verification_state = 'VERIFIED'
       JOIN ca_meta_authorizations auth ON auth.tenant_id = aa.tenant_id AND auth.id = aa.authorization_id
         AND auth.app_configuration_id = aa.app_configuration_id AND auth.provider = aa.provider
         AND auth.environment = aa.environment AND auth.authorization_state IN ('ACTIVE', 'PARTIAL')
       WHERE n.tenant_id = ? AND n.id = ? AND n.asset_id = ? AND n.status = 'UNREAD'
         AND a.app_configuration_id = ? AND a.environment = ?
         AND n.provider_target_ref IS NOT NULL
         AND ((n.kind = 'MESSAGE_RECEIVED' AND a.asset_kind = 'WHATSAPP_PHONE_NUMBER')
           OR (n.kind = 'COMMENT_RECEIVED' AND a.asset_kind IN ('FACEBOOK_PAGE', 'INSTAGRAM_BUSINESS_ACCOUNT', 'INSTAGRAM_CREATOR_ACCOUNT')))
       LIMIT 2`,
      [input.serviceScope.tenantId, input.payload.notificationId, input.payload.assetId,
        input.payload.appConfigurationId, input.payload.environment],
    ) as NotificationActionTargetRow[];
    if (rows.length !== 1) return undefined;
    const row = rows[0];
    if (!row || row.tenant_id !== input.serviceScope.tenantId || row.notification_id !== input.payload.notificationId ||
        row.asset_id !== input.payload.assetId || row.app_configuration_id !== input.payload.appConfigurationId ||
        row.environment !== input.payload.environment || !validProviderRef(row.provider_asset_id) ||
        !row.provider_target_ref || !validProviderRef(row.provider_target_ref) ||
        !validFlow(row.flow_variant) || !validAuth(row.auth_variant)) return undefined;
    return Object.freeze({ tenantId: row.tenant_id, notificationId: row.notification_id, assetId: row.asset_id,
      appConfigurationId: row.app_configuration_id, environment: row.environment as MetaEnvironment,
      assetKind: row.asset_kind, providerAssetId: row.provider_asset_id, providerTargetRef: row.provider_target_ref,
      flowVariant: row.flow_variant, authVariant: row.auth_variant });
  }
}

export interface NotificationActionProviderInput {
  readonly context: MetaGraphExecutionContext;
  readonly credentialHandle: Awaited<ReturnType<CredentialResolverService['resolve']>>['handle'];
  readonly operation: 'SEND_MESSAGE' | 'MANAGE_COMMENTS';
  readonly targetRef: string;
  readonly request: NotificationActionRequest;
  readonly correlationId: string;
}

export interface NotificationActionProvider {
  execute(input: NotificationActionProviderInput, signal: AbortSignal): Promise<MetaGraphCallResult | null | undefined>;
}

export type NotificationActionResult = { readonly kind: 'SUCCEEDED' } | { readonly kind: 'FAILED_NO_EFFECT' } | { readonly kind: 'UNKNOWN' };

export interface NotificationActionAdapter {
  execute(input: {
    readonly tenantId: string;
    readonly notificationId: string;
    readonly assetId: string;
    readonly appConfigurationId: string;
    readonly environment: MetaEnvironment;
    readonly request: NotificationActionRequest;
    readonly serviceScope: VerifiedServiceTenantScope;
    readonly correlationId: string;
  }, signal: AbortSignal): Promise<NotificationActionResult | null | undefined>;
}

/** Resolves an asset-bound credential before handing a one-use handle to the provider adapter. */
export class MetaGraphNotificationActionAdapter implements NotificationActionAdapter {
  constructor(
    private readonly directory: NotificationActionDirectory,
    private readonly configurations: MetaAppConfigRegistry,
    private readonly credentials: Pick<CredentialResolverService, 'resolve'>,
    private readonly provider: NotificationActionProvider,
  ) {}

  async execute(input: Parameters<NotificationActionAdapter['execute']>[0], signal: AbortSignal): Promise<NotificationActionResult> {
    if (!isVerifiedServiceTenantScope(input.serviceScope) || input.serviceScope.tenantId !== input.tenantId ||
        !validEnvironment(input.environment) || signal.aborted) return { kind: 'FAILED_NO_EFFECT' };
    let target: NotificationActionTarget | undefined;
    try { target = await this.directory.resolve({ serviceScope: input.serviceScope, payload: {
      kind: 'NOTIFICATION_ACTION', notificationId: input.notificationId, assetId: input.assetId,
      appConfigurationId: input.appConfigurationId, environment: input.environment, request: input.request,
    } }); } catch { return { kind: 'FAILED_NO_EFFECT' }; }
    if (!target || target.tenantId !== input.tenantId || target.notificationId !== input.notificationId ||
        target.assetId !== input.assetId || target.appConfigurationId !== input.appConfigurationId ||
        target.environment !== input.environment || !target.providerTargetRef || !target.providerAssetId ||
        !validFlowForAction(target, input.request)) return { kind: 'FAILED_NO_EFFECT' };

    const operation: CredentialResolverOperation = input.request.action === 'SEND_TEMPLATE' ? 'SEND_MESSAGE' : 'MANAGE_COMMENTS';
    const profile = this.configurations.resolve(target.flowVariant, target.authVariant, target.environment);
    if (!profile || profile.versions.graphApi.status !== 'VERIFIED') return { kind: 'FAILED_NO_EFFECT' };
    let credential: Awaited<ReturnType<CredentialResolverService['resolve']>>;
    try {
      credential = await this.credentials.resolve({ tenantId: input.tenantId, provider: 'META',
        appConfigurationId: input.appConfigurationId, environment: input.environment, assetId: input.assetId, operation },
      { serviceScope: input.serviceScope, correlationId: input.correlationId });
    } catch { return { kind: 'FAILED_NO_EFFECT' }; }
    if (credential.status !== 'READY' || credential.capability !== operation || signal.aborted) return { kind: 'FAILED_NO_EFFECT' };

    const context: MetaGraphExecutionContext = Object.freeze({
      tenantId: input.tenantId, provider: 'META', appConfigurationId: input.appConfigurationId,
      environment: input.environment, assetId: input.assetId, operation,
      flowVariant: target.flowVariant, authVariant: target.authVariant,
      configurationRef: profile.configurationRef, providerObjectId: target.providerAssetId,
    });
    try {
      const result = await this.provider.execute({ context, credentialHandle: credential.handle, operation,
        targetRef: target.providerTargetRef, request: input.request, correlationId: input.correlationId }, signal);
      if (!result || result.outcome === 'UNKNOWN' || result.ambiguous) return { kind: 'UNKNOWN' };
      if (result.outcome === 'FAILED' || result.error) return { kind: 'FAILED_NO_EFFECT' };
      if (result.outcome !== 'SUCCEEDED') return { kind: 'UNKNOWN' };
      return { kind: 'SUCCEEDED' };
    } catch {
      // The provider call may already have taken effect; its outcome is unknown and is never retried.
      return { kind: 'UNKNOWN' };
    }
  }
}

/** Uses the already capability-checked Graph client; runtime registration remains explicitly absent. */
export class MetaGraphNotificationProvider implements NotificationActionProvider {
  constructor(private readonly graph: Pick<MetaGraphClient, 'execute'>) {}

  async execute(input: NotificationActionProviderInput): Promise<MetaGraphCallResult> {
    const request = input.request;
    const graphInput: MetaGraphInput = request.action === 'SEND_TEMPLATE'
      ? Object.freeze({
        endpoint: 'SEND_MESSAGE', context: input.context, credentialHandle: input.credentialHandle,
        credentialCapability: 'SEND_MESSAGE', operation: 'SEND_MESSAGE', correlationId: input.correlationId,
        resourceId: input.context.providerObjectId,
        body: Object.freeze({ messaging_product: 'whatsapp', to: input.targetRef, type: 'template',
          template: Object.freeze({ name: request.templateName, language: Object.freeze({ code: request.language }),
            ...(request.parameters.length > 0 ? { components: Object.freeze([Object.freeze({ type: 'body',
              parameters: Object.freeze(request.parameters.map((text) => Object.freeze({ type: 'text', text }))) })]) } : {}) }) }),
      })
      : Object.freeze({
        endpoint: 'COMMENT_REPLY', context: input.context, credentialHandle: input.credentialHandle,
        credentialCapability: 'MANAGE_COMMENTS', operation: 'MANAGE_COMMENTS', correlationId: input.correlationId,
        resourceId: input.targetRef, body: Object.freeze({ message: request.replyText }),
      });
    return await this.graph.execute(graphInput);
  }
}

export function createNotificationActionJobHandler(adapter: NotificationActionAdapter): JobHandler {
  return async (job: ClaimedJob, signal: AbortSignal, authorization: VerifiedJobExecutionContext): Promise<JobOutcome> => {
    if (!isVerifiedJobExecutionContext(authorization) || job.type !== 'NOTIFICATION_ACTION' ||
        job.payload.kind !== 'NOTIFICATION_ACTION' || authorization.tenantId !== job.tenantId ||
        authorization.resourceRef !== job.payload.notificationId || authorization.serviceScope.tenantId !== job.tenantId) {
      return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
    }
    let result: NotificationActionResult | null | undefined;
    try {
      result = await adapter.execute({ tenantId: job.tenantId, notificationId: job.payload.notificationId,
        assetId: job.payload.assetId, appConfigurationId: job.payload.appConfigurationId,
        environment: job.payload.environment, request: job.payload.request,
        serviceScope: authorization.serviceScope, correlationId: job.correlationId }, signal);
    } catch { result = undefined; }
    if (result?.kind === 'SUCCEEDED') return { kind: 'SUCCEEDED' };
    if (result?.kind === 'FAILED_NO_EFFECT') return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'HANDLER_FAILED' };
    return { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' };
  };
}

export function notificationActionFinalizer(manager: EntityManager, job: ClaimedJob, finalization: JobFinalization): Promise<void> {
  if (job.type !== 'NOTIFICATION_ACTION' || job.payload.kind !== 'NOTIFICATION_ACTION') return Promise.resolve();
  const payload = job.payload;
  const receiptStatus = finalization.status === 'SUCCEEDED' ? 'SUCCEEDED'
    : finalization.status === 'UNKNOWN' ? 'UNKNOWN'
      : finalization.status === 'RETRY_PENDING' ? 'PENDING' : 'FAILED';
  return manager.query(
    `UPDATE ca_meta_notification_action_receipts SET status = ?, safe_error_code = ?, updated_at = UTC_TIMESTAMP(6)
     WHERE tenant_id = ? AND notification_id = ? AND operation_id = ?`,
    [receiptStatus, finalization.safeErrorCode, job.tenantId, payload.notificationId, job.id],
  ).then(async () => {
    if (finalization.status === 'SUCCEEDED') {
      await manager.query(
        `UPDATE ca_meta_notifications SET status = 'READ', updated_at = UTC_TIMESTAMP(6)
         WHERE tenant_id = ? AND id = ? AND status = 'UNREAD'`, [job.tenantId, payload.notificationId],
      );
    }
  });
}

function validEnvironment(value: string): value is MetaEnvironment {
  return value === 'development' || value === 'test' || value === 'staging' || value === 'production';
}

function validProviderRef(value: string): boolean { return /^[A-Za-z0-9._:-]{1,191}$/.test(value); }
function validFlow(value: string): value is MetaFlowVariant {
  return value === 'FACEBOOK' || value === 'INSTAGRAM' || value === 'WHATSAPP_EXCLUSIVE' || value === 'WHATSAPP_COEXISTENCE';
}
function validAuth(value: string): value is MetaAuthVariant {
  return value === 'FACEBOOK_LOGIN_FOR_BUSINESS' || value === 'INSTAGRAM_VIA_FACEBOOK_LOGIN' || value === 'INSTAGRAM_LOGIN' ||
    value === 'WHATSAPP_EMBEDDED_SIGNUP' || value === 'WHATSAPP_BUSINESS_APP_ONBOARDING';
}

function validFlowForAction(target: NotificationActionTarget, request: NotificationActionRequest): boolean {
  if (request.action === 'SEND_TEMPLATE') return target.assetKind === 'WHATSAPP_PHONE_NUMBER' &&
    target.flowVariant === 'WHATSAPP_EXCLUSIVE' && target.authVariant === 'WHATSAPP_EMBEDDED_SIGNUP';
  return target.assetKind === 'FACEBOOK_PAGE' && target.flowVariant === 'FACEBOOK' &&
      target.authVariant === 'FACEBOOK_LOGIN_FOR_BUSINESS' ||
    ['INSTAGRAM_BUSINESS_ACCOUNT', 'INSTAGRAM_CREATOR_ACCOUNT'].includes(target.assetKind) &&
      target.flowVariant === 'INSTAGRAM' && ['INSTAGRAM_LOGIN', 'INSTAGRAM_VIA_FACEBOOK_LOGIN'].includes(target.authVariant);
}
