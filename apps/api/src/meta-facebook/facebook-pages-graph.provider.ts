import { createHash } from 'node:crypto';
import type { CredentialResolverService } from '../credentials/credential-resolver.service.js';
import type { CredentialResolutionActor, CredentialResolutionContext, CredentialResolutionHandle } from '../credentials/credential-resolver.types.js';
import type { MetaAppConfigRegistry } from '../meta-config/meta-app-config.registry.js';
import type { MetaGraphExecutionContext } from '../meta-graph/meta-graph.types.js';
import type { FacebookPageListPage, FacebookPagesContext, FacebookPagesProvider } from './facebook-pages.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TASK = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface FacebookPageDiscoveryCredentialContext {
  readonly authorizationRef: string;
  readonly resolutionContext: CredentialResolutionContext;
  readonly actor: CredentialResolutionActor;
}

/** Server-side lookup only; browser data cannot supply an asset ID or worker actor. */
export interface FacebookPageDiscoveryCredentialContextResolver {
  resolve(input: FacebookPagesContext & { readonly authorizationRef: string; readonly signal: AbortSignal }):
    Promise<FacebookPageDiscoveryCredentialContext | undefined>;
}

export class FacebookPageDiscoveryCredentialContextNotConfigured implements FacebookPageDiscoveryCredentialContextResolver {
  async resolve(): Promise<undefined> { return undefined; }
}

export interface FacebookPageTokenRecord {
  readonly providerPageId: string;
  readonly pageName: string | null;
  readonly pageTasks: readonly string[];
  readonly pageAccessToken: string;
}

/** This port is implemented only by a vault-owned, tenant-scoped atomic credential enrollment service. */
export interface FacebookPageCredentialVaultEnrollmentPort {
  enrollPageCredentialsAtomically(input: {
    readonly flowVariant: 'FACEBOOK';
    readonly authVariant: 'FACEBOOK_LOGIN_FOR_BUSINESS';
    readonly tenantId: string;
    readonly appConfigurationId: string;
    readonly environment: CredentialResolutionContext['environment'];
    readonly authorizationAssetRef: string;
    readonly correlationId: string;
    readonly enrollmentRef: string;
    readonly pages: readonly FacebookPageTokenRecord[];
    readonly signal: AbortSignal;
  }): Promise<readonly { readonly providerPageId: string; readonly credentialRef: string }[]>;
}

export interface FacebookPagesGraphDiscoveryInput {
  readonly endpoint: 'FACEBOOK_PAGES_DISCOVERY';
  readonly resourceId: 'me';
  readonly context: MetaGraphExecutionContext;
  readonly credentialHandle: CredentialResolutionHandle;
  readonly credentialCapability: 'ASSET_DISCOVERY';
  readonly operation: 'ASSET_DISCOVERY';
  readonly correlationId: string;
}

export interface FacebookPagesGraphDiscoveryResult {
  readonly outcome: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  readonly pages: readonly {
    readonly providerPageId: string;
    readonly pageName: string | null;
    readonly pageTasks: readonly string[];
    readonly credentialRef: string;
  }[];
  readonly safeErrorCode?: string;
}

export type FacebookPageCredentialConsumer = (input: {
  readonly flowVariant: 'FACEBOOK';
  readonly authVariant: 'FACEBOOK_LOGIN_FOR_BUSINESS';
  readonly tenantId: string;
  readonly appConfigurationId: string;
  readonly environment: CredentialResolutionContext['environment'];
  readonly authorizationAssetRef: string;
  readonly correlationId: string;
  readonly enrollmentRef: string;
  readonly pages: readonly FacebookPageTokenRecord[];
  readonly signal?: AbortSignal;
}) => Promise<{ readonly credentialRefs: readonly { readonly providerPageId: string; readonly credentialRef: string }[] }>;

/** Structural interface for M4.04's specialized method; generic collect() intentionally cannot return tokens. */
export interface FacebookPagesGraphDiscoveryClient {
  discoverFacebookPages(input: FacebookPagesGraphDiscoveryInput, enrollmentRef: string,
    consumer: FacebookPageCredentialConsumer, options?: { readonly maxPages?: number; readonly maxItems?: number; readonly signal?: AbortSignal }):
    Promise<FacebookPagesGraphDiscoveryResult>;
}

/**
 * M4.08 adapter for the exact MetaGraphClient discovery method. It is not registered in ApiModule:
 * the authorization-scoped user credential context and vault enrollment service are not available.
 */
export class MetaGraphFacebookPagesProvider implements Pick<FacebookPagesProvider, 'listManagedPages'> {
  constructor(
    private readonly credentials: Pick<CredentialResolverService, 'resolve'>,
    private readonly contextResolver: FacebookPageDiscoveryCredentialContextResolver,
    private readonly configs: MetaAppConfigRegistry,
    private readonly graph: FacebookPagesGraphDiscoveryClient,
    private readonly enrollment: FacebookPageCredentialVaultEnrollmentPort,
  ) {}

  async listManagedPages(input: FacebookPagesContext & { readonly authorizationRef: string; readonly idempotencyKey: string;
    readonly signal: AbortSignal }): Promise<FacebookPageListPage> {
    if (input.flowVariant !== 'FACEBOOK_LOGIN' || input.authVariant !== 'FACEBOOK_LOGIN_FOR_BUSINESS' ||
        !UUID.test(input.tenantId) || !UUID.test(input.authorizationRef) || input.idempotencyKey.length < 16 ||
        input.idempotencyKey.length > 128 || input.signal.aborted) {
      return Object.freeze({ outcome: 'FAILED', pages: Object.freeze([]), safeErrorCode: 'FACEBOOK_DISCOVERY_CONTEXT_INVALID' });
    }
    let discovery: FacebookPageDiscoveryCredentialContext | undefined;
    try { discovery = await this.contextResolver.resolve(input); } catch { discovery = undefined; }
    if (!discovery || discovery.authorizationRef !== input.authorizationRef || !isExactResolverContext(discovery, input)) {
      return Object.freeze({ outcome: 'FAILED', pages: Object.freeze([]), safeErrorCode: 'FACEBOOK_USER_CREDENTIAL_NOT_AVAILABLE' });
    }
    let handle: CredentialResolutionHandle;
    try {
      const resolved = await this.credentials.resolve(discovery.resolutionContext, discovery.actor);
      if (resolved.status !== 'READY' || resolved.capability !== 'ASSET_DISCOVERY') {
        return Object.freeze({ outcome: 'FAILED', pages: Object.freeze([]), safeErrorCode: 'FACEBOOK_USER_CREDENTIAL_NOT_AVAILABLE' });
      }
      handle = resolved.handle;
    } catch {
      return Object.freeze({ outcome: 'FAILED', pages: Object.freeze([]), safeErrorCode: 'FACEBOOK_USER_CREDENTIAL_NOT_AVAILABLE' });
    }
    const profile = this.configs.resolve('FACEBOOK', 'FACEBOOK_LOGIN_FOR_BUSINESS', discovery.resolutionContext.environment);
    if (!profile || profile.configurationRef !== input.configurationRef || profile.versions.graphApi.status !== 'VERIFIED') {
      return Object.freeze({ outcome: 'FAILED', pages: Object.freeze([]), safeErrorCode: 'FACEBOOK_GRAPH_CONFIGURATION_NOT_CONFIRMED' });
    }
    const enrollmentRef = deterministicUuid(`${input.tenantId}\0${input.authorizationRef}\0${input.idempotencyKey}`);
    const graphContext: MetaGraphExecutionContext = Object.freeze({ ...discovery.resolutionContext,
      flowVariant: 'FACEBOOK', authVariant: 'FACEBOOK_LOGIN_FOR_BUSINESS', configurationRef: profile.configurationRef,
      providerObjectId: 'me' });
    let result: FacebookPagesGraphDiscoveryResult;
    try {
      result = await this.graph.discoverFacebookPages(Object.freeze({ endpoint: 'FACEBOOK_PAGES_DISCOVERY', resourceId: 'me',
        context: graphContext, credentialHandle: handle, credentialCapability: 'ASSET_DISCOVERY',
        operation: 'ASSET_DISCOVERY', correlationId: discovery.actor.correlationId }), enrollmentRef,
      async (batch) => {
        if (batch.flowVariant !== 'FACEBOOK' || batch.authVariant !== 'FACEBOOK_LOGIN_FOR_BUSINESS' ||
            batch.tenantId !== graphContext.tenantId || batch.appConfigurationId !== graphContext.appConfigurationId ||
            batch.environment !== graphContext.environment || batch.authorizationAssetRef !== graphContext.assetId ||
            batch.correlationId !== discovery!.actor.correlationId || batch.enrollmentRef !== enrollmentRef ||
            (batch.signal !== undefined && batch.signal !== input.signal) || input.signal.aborted) {
          throw new Error('Facebook credential enrollment context is invalid.');
        }
        const credentialRefs = await this.enrollment.enrollPageCredentialsAtomically({
          flowVariant: batch.flowVariant, authVariant: batch.authVariant, tenantId: batch.tenantId,
          appConfigurationId: batch.appConfigurationId, environment: batch.environment,
          authorizationAssetRef: batch.authorizationAssetRef, correlationId: batch.correlationId,
          enrollmentRef: batch.enrollmentRef, pages: batch.pages, signal: input.signal,
        });
        return Object.freeze({ credentialRefs: Object.freeze(credentialRefs.map((entry) => Object.freeze({ ...entry }))) });
      }, { maxPages: 50, maxItems: 500, signal: input.signal });
    } catch {
      return Object.freeze({ outcome: 'FAILED', pages: Object.freeze([]), safeErrorCode: 'FACEBOOK_CREDENTIAL_ENROLLMENT_UNAVAILABLE' });
    }
    const pages = mapSafePages(result);
    if (!pages) return Object.freeze({ outcome: 'FAILED', pages: Object.freeze([]), safeErrorCode: 'FACEBOOK_DISCOVERY_RESULT_INVALID' });
    return Object.freeze({ outcome: result.outcome, pages: Object.freeze(pages),
      ...(safeCode(result.safeErrorCode) ? { safeErrorCode: result.safeErrorCode } : {}) });
  }
}

function isExactResolverContext(value: FacebookPageDiscoveryCredentialContext, input: FacebookPagesContext): boolean {
  const context = value.resolutionContext;
  return context.provider === 'META' && context.tenantId === input.tenantId && UUID.test(context.appConfigurationId) &&
    ['development', 'test', 'staging', 'production'].includes(context.environment) && UUID.test(context.assetId) &&
    context.operation === 'ASSET_DISCOVERY' && value.actor.serviceScope.tenantId === input.tenantId &&
    UUID.test(value.actor.serviceScope.principalId) && UUID.test(value.actor.correlationId);
}

function mapSafePages(result: FacebookPagesGraphDiscoveryResult): FacebookPageListPage['pages'] | undefined {
  if (!result || typeof result !== 'object' || !['SUCCEEDED', 'PARTIAL', 'FAILED'].includes(result.outcome) ||
      !Array.isArray(result.pages) || result.pages.length > 500) return undefined;
  const ids = new Set<string>();
  const credentials = new Set<string>();
  const pages: FacebookPageListPage['pages'][number][] = [];
  for (const page of result.pages) {
    if (!page || typeof page !== 'object' || typeof page.providerPageId !== 'string' ||
        !PAGE_ID.test(page.providerPageId) || ids.has(page.providerPageId) || typeof page.credentialRef !== 'string' || !UUID.test(page.credentialRef) ||
        credentials.has(page.credentialRef) || (page.pageName !== null && (typeof page.pageName !== 'string' ||
          page.pageName.length > 255 || /[\u0000-\u001f\u007f]/.test(page.pageName))) || !Array.isArray(page.pageTasks) ||
        page.pageTasks.length > 64) return undefined;
    const pageTasks: string[] = [];
    for (const task of page.pageTasks as readonly unknown[]) {
      if (typeof task !== 'string' || !TASK.test(task)) return undefined;
      pageTasks.push(task);
    }
    if (new Set(pageTasks).size !== pageTasks.length) return undefined;
    ids.add(page.providerPageId);
    credentials.add(page.credentialRef);
    pages.push(Object.freeze({ id: page.providerPageId, name: page.pageName, credentialRef: page.credentialRef,
      tasks: Object.freeze(pageTasks) }));
  }
  return Object.freeze(pages);
}

function safeCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value);
}

function deterministicUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
