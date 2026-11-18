import type { ClaimedJob, JobOutcome } from '../jobs/job-store.js';
import type { VerifiedJobExecutionContext } from '../jobs/job-execution-authorization.js';
import { isVerifiedJobExecutionContext } from '../jobs/job-execution-authorization.js';
import type { TemplateCreateRequest } from './template-body.js';
import { parseTemplateCreateRequest } from './template-body.js';
import type { JobHandler } from '../worker/durable-worker.js';
import type { CredentialResolverService } from '../credentials/credential-resolver.service.js';
import type { MetaAppConfigRegistry } from '../meta-config/meta-app-config.registry.js';
import type { MetaGraphClient } from '../meta-graph/meta-graph.client.js';
import type { MetaGraphExecutionContext, MetaGraphInput, MetaGraphJson } from '../meta-graph/meta-graph.types.js';
import type { WhatsAppTemplatesAccountDirectory } from './whatsapp-templates.service.js';
import { templateBodyProviderComponents } from './template-body.js';
import { isVerifiedServiceTenantScope } from '../identity/identity.service.js';

export interface WhatsAppTemplateDispatchInput {
  readonly tenantId: string;
  readonly assetId: string;
  readonly appConfigurationId: string;
  readonly environment: 'development' | 'test' | 'staging' | 'production';
  readonly request: TemplateCreateRequest;
  readonly serviceScope: VerifiedJobExecutionContext['serviceScope'];
  readonly correlationId: string;
}

export type TemplateDispatchResult = { readonly kind: 'ACCEPTED' } | { readonly kind: 'REJECTED' } | { readonly kind: 'NO_EFFECT' } | { readonly kind: 'UNKNOWN' };
export type TemplateReconciliationResult = { readonly kind: 'FOUND' } | { readonly kind: 'NOT_FOUND' | 'AMBIGUOUS' };

/** A future adapter must resolve MANAGE_TEMPLATES through M3.08 and use the M4.01 Graph client. */
export interface WhatsAppTemplateDispatchAdapter {
  submit(input: WhatsAppTemplateDispatchInput, signal: AbortSignal): Promise<TemplateDispatchResult | null | undefined>;
  /** Read-only and exact-account scoped: compare name, language and BODY content; never submit here. */
  reconcile(input: WhatsAppTemplateDispatchInput, signal: AbortSignal): Promise<TemplateReconciliationResult | null | undefined>;
}

/**
 * Reuses the M3.08 operation resolver and M4.01 Graph client. The class exists as an
 * injection point, while API/worker registration stays disabled until capability evidence is reviewed.
 */
export class MetaGraphWhatsAppTemplateDispatchAdapter implements WhatsAppTemplateDispatchAdapter {
  constructor(
    private readonly configurations: MetaAppConfigRegistry,
    private readonly credentials: Pick<CredentialResolverService, 'resolve'>,
    private readonly graph: Pick<MetaGraphClient, 'execute' | 'collect'>,
    private readonly accounts: WhatsAppTemplatesAccountDirectory,
  ) {}

  async submit(input: WhatsAppTemplateDispatchInput, signal: AbortSignal): Promise<TemplateDispatchResult> {
    const resolved = await this.resolve(input);
    if (!resolved) return { kind: 'NO_EFFECT' };
    if (signal.aborted) return { kind: 'NO_EFFECT' };
    const createInput: Extract<MetaGraphInput, { readonly endpoint: 'TEMPLATE_CREATE' }> = Object.freeze({
      endpoint: 'TEMPLATE_CREATE', context: resolved.context, credentialHandle: resolved.handle,
      credentialCapability: 'MANAGE_TEMPLATES', operation: 'MANAGE_TEMPLATES',
      correlationId: input.correlationId, resourceId: resolved.context.providerObjectId,
      body: templateBodyProviderComponents(input.request) as Readonly<Record<string, MetaGraphJson>>,
    });
    const result = await this.graph.execute(createInput);
    if (result.outcome === 'UNKNOWN' || result.ambiguous) return { kind: 'UNKNOWN' };
    if (result.outcome === 'FAILED') return { kind: 'REJECTED' };
    // A 2xx with a provider error or a body without a verifiable template reference is not success evidence.
    if (!record(result.data) || typeof result.data['id'] !== 'string' || !/^\d{1,32}$/.test(result.data['id'])) {
      return { kind: 'UNKNOWN' };
    }
    return { kind: 'ACCEPTED' };
  }

  async reconcile(input: WhatsAppTemplateDispatchInput, signal: AbortSignal): Promise<TemplateReconciliationResult> {
    const resolved = await this.resolve(input);
    if (!resolved || signal.aborted) return { kind: 'AMBIGUOUS' };
    const listInput: Extract<MetaGraphInput, { readonly endpoint: 'TEMPLATES_LIST' }> = Object.freeze({
      endpoint: 'TEMPLATES_LIST', context: resolved.context, credentialHandle: resolved.handle,
      credentialCapability: 'MANAGE_TEMPLATES', operation: 'MANAGE_TEMPLATES',
      correlationId: input.correlationId, resourceId: resolved.context.providerObjectId,
      query: Object.freeze({ fields: 'id,name,language,category,components', limit: 100 }),
    });
    const result = await this.graph.collect(listInput, { maxPages: 100, maxItems: 10_000 });
    if (result.outcome !== 'SUCCEEDED') return { kind: 'AMBIGUOUS' };
    return classifyTemplateReconciliationCandidates(result.data, input.request);
  }

  private async resolve(input: WhatsAppTemplateDispatchInput): Promise<{
    readonly context: MetaGraphExecutionContext;
    readonly handle: Awaited<ReturnType<CredentialResolverService['resolve']>>['handle'];
  } | undefined> {
    if (!isVerifiedServiceTenantScope(input.serviceScope) || input.serviceScope.tenantId !== input.tenantId ||
        input.environment !== 'development' && input.environment !== 'test' && input.environment !== 'staging' && input.environment !== 'production') {
      return undefined;
    }
    const account = await this.accounts.resolveForWorker(input.serviceScope, input.assetId, input.appConfigurationId, input.environment);
    if (!account) return undefined;
    const profile = this.configurations.resolve('WHATSAPP_EXCLUSIVE', 'WHATSAPP_EMBEDDED_SIGNUP', input.environment);
    if (!profile || profile.versions.graphApi.status !== 'VERIFIED') return undefined;
    const actor = Object.freeze({ serviceScope: input.serviceScope, correlationId: input.correlationId });
    let credential: Awaited<ReturnType<CredentialResolverService['resolve']>>;
    try {
      credential = await this.credentials.resolve({ tenantId: input.tenantId, provider: 'META',
        appConfigurationId: input.appConfigurationId, environment: input.environment,
        assetId: input.assetId, operation: 'MANAGE_TEMPLATES' }, actor);
    } catch { return undefined; }
    if (credential.status !== 'READY' || credential.capability !== 'MANAGE_TEMPLATES') return undefined;
    const context: MetaGraphExecutionContext = Object.freeze({ tenantId: input.tenantId, provider: 'META',
      appConfigurationId: input.appConfigurationId, environment: input.environment, assetId: input.assetId,
      operation: 'MANAGE_TEMPLATES', flowVariant: 'WHATSAPP_EXCLUSIVE', authVariant: 'WHATSAPP_EMBEDDED_SIGNUP',
      configurationRef: profile.configurationRef, providerObjectId: account.providerWabaId });
    return Object.freeze({ context, handle: credential.handle });
  }
}

export function createTemplateCreateJobHandler(adapter: WhatsAppTemplateDispatchAdapter): JobHandler {
  return async (job: ClaimedJob, signal: AbortSignal, authorization: VerifiedJobExecutionContext): Promise<JobOutcome> => {
    if (!isVerifiedJobExecutionContext(authorization) || !job || job.type !== 'TEMPLATE_CREATE' ||
        job.payload.kind !== 'TEMPLATE_CREATE' || authorization.tenantId !== job.tenantId ||
        authorization.resourceRef !== job.payload.assetId || authorization.serviceScope.tenantId !== job.tenantId ||
        !/^[0-9a-f-]{36}$/i.test(job.payload.assetId) || !/^[0-9a-f-]{36}$/i.test(job.payload.appConfigurationId)) {
      return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
    }
    let request: TemplateCreateRequest;
    try { request = parseTemplateCreateRequest(job.payload.request); } catch {
      return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
    }
    const input: WhatsAppTemplateDispatchInput = Object.freeze({
      tenantId: job.tenantId,
      assetId: job.payload.assetId,
      appConfigurationId: job.payload.appConfigurationId,
      environment: job.payload.environment,
      request,
      serviceScope: authorization.serviceScope,
      correlationId: job.correlationId,
    });

    return await submitAndReconcileTemplateCreate(adapter, input, signal);
  };
}

/** One submission at most; ambiguous replies get one read-only observation and never a resubmit. */
export async function submitAndReconcileTemplateCreate(adapter: WhatsAppTemplateDispatchAdapter,
  input: WhatsAppTemplateDispatchInput, signal: AbortSignal): Promise<JobOutcome> {
  let submitted: TemplateDispatchResult | null | undefined;
  try { submitted = await adapter.submit(input, signal); } catch { submitted = undefined; }
  if (submitted?.kind === 'ACCEPTED') return { kind: 'SUCCEEDED' };
  if (submitted?.kind === 'REJECTED' || submitted?.kind === 'NO_EFFECT') {
    return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'HANDLER_FAILED' };
  }

  // A timed-out/empty/explicitly ambiguous reply is observed read-only. A miss does not authorize retry.
  let observed: TemplateReconciliationResult | null | undefined;
  try { observed = await adapter.reconcile(input, signal); } catch { observed = undefined; }
  if (observed?.kind === 'FOUND') return { kind: 'SUCCEEDED' };
  return { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' };
}

/**
 * Lists are scoped to the internal WABA and can detect a possible name/language collision, but Meta's
 * current API exposes no confirmed request correlation here. Even one exact match may predate this job,
 * so it must remain ambiguous rather than being reported as successful submission.
 */
export function classifyTemplateReconciliationCandidates(rows: readonly unknown[], request: TemplateCreateRequest): TemplateReconciliationResult {
  const matchingNames = rows.filter((row) => record(row) && row['name'] === request.name && row['language'] === request.language);
  return matchingNames.length === 0 ? { kind: 'NOT_FOUND' } : { kind: 'AMBIGUOUS' };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
