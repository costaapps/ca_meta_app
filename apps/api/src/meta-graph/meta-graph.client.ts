import type { CredentialResolverService } from '../credentials/credential-resolver.service.js';
import type { MetaAppConfigRegistry } from '../meta-config/meta-app-config.registry.js';
import type { MetaAppConfiguration } from '../meta-config/meta-app-config.configuration.js';
import type { MetaOperation } from '../meta-config/capability-manifest.js';
import { MetaGraphTransportFailure } from './meta-graph.transport.js';
import type {
  MetaGraphCallResult, MetaGraphCollectionResult, MetaGraphExecutionContext, MetaGraphHost, MetaGraphInput,
  MetaGraphJson, MetaGraphMethod, MetaGraphMetrics, MetaGraphQuery, MetaGraphSafeError,
  MetaGraphSafeErrorCategory, MetaGraphTransport, MetaGraphTransportRequest, MetaGraphTransportResponse,
} from './meta-graph.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const CURSOR = /^[A-Za-z0-9._~+/%=-]{1,1024}$/;
const FIELDS = /^[A-Za-z0-9_.,:{}()\[\]]{1,512}$/;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_ITEMS = 10_000;
const MAX_RETRIES = 2;
const MAX_COLLECTION_RETRIES = 16;
const RATE_WINDOW_MS = 60_000;
const MAX_BUCKETS = 1_000;
const RETRY_AFTER_MAX = 30;
const HOSTS: Readonly<Record<MetaGraphExecutionContext['authVariant'], MetaGraphHost>> = Object.freeze({
  FACEBOOK_LOGIN_FOR_BUSINESS: 'graph.facebook.com',
  INSTAGRAM_VIA_FACEBOOK_LOGIN: 'graph.facebook.com',
  INSTAGRAM_LOGIN: 'graph.instagram.com',
  WHATSAPP_EMBEDDED_SIGNUP: 'graph.facebook.com',
  WHATSAPP_BUSINESS_APP_ONBOARDING: 'graph.facebook.com',
});
const SECRET_KEY = /^(?:access[_-]?token|token|client[_-]?secret|input[_-]?token|fb[_-]?exchange[_-]?token|refresh[_-]?token|authorization|code|headers?|cookie|set[_-]?cookie|password|secret|error|paging)$/i;

interface Route { operation: MetaOperation; method: MetaGraphMethod; edge: string; pages: boolean; body: boolean }
interface Limits { connectTimeoutMs: number; headersTimeoutMs: number; readTimeoutMs: number; overallTimeoutMs: number; maxPages: number; maxItems: number; maxConcurrencyPerApp: number; maxConcurrencyGlobal: number; maxRequestsPerAppWindow: number; maxResponseBytes: number }
export interface MetaGraphClientOptions extends Partial<Limits> {
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
}
interface RequestResult { response?: MetaGraphTransportResponse; error?: MetaGraphSafeError; attempts: number; retries: number }
interface Bucket { startAt: number; count: number }

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function err(category: MetaGraphSafeErrorCategory, attrs: Partial<Omit<MetaGraphSafeError, 'category' | 'retryable' | 'ambiguous'>> = {}, retryable = false, ambiguous = false): MetaGraphSafeError {
  return Object.freeze({ category, ...attrs, retryable, ambiguous });
}
function route(input: MetaGraphInput): Route | undefined {
  if (!input || typeof input !== 'object') return undefined;
  if (input.endpoint === 'ASSET_EDGE_LIST') {
    if (!record(input.context)) return undefined;
    const flow = input.context['flowVariant'];
    const auth = input.context['authVariant'];
    if (typeof flow !== 'string' || typeof auth !== 'string' || !['FACEBOOK', 'INSTAGRAM', 'WHATSAPP_EXCLUSIVE', 'WHATSAPP_COEXISTENCE'].includes(flow)) return undefined;
    const byFlow: Readonly<Record<MetaGraphExecutionContext['flowVariant'], readonly string[]>> = {
      FACEBOOK: ['accounts', 'owned_pages'],
      INSTAGRAM: auth === 'INSTAGRAM_LOGIN' ? ['instagram_accounts'] : ['accounts', 'owned_pages', 'instagram_accounts'],
      WHATSAPP_EXCLUSIVE: ['businesses', 'phone_numbers'],
      WHATSAPP_COEXISTENCE: ['businesses', 'phone_numbers'],
    };
    if (!byFlow[flow as MetaGraphExecutionContext['flowVariant']]?.includes(input.edge)) return undefined;
  }
  switch (input.endpoint) {
    case 'OBJECT_READ': return { operation: 'READ_STATUS', method: 'GET', edge: '', pages: false, body: false };
    case 'ASSET_EDGE_LIST': return { operation: 'ASSET_DISCOVERY', method: 'GET', edge: `/${input.edge}`, pages: true, body: false };
    case 'TEMPLATES_LIST': return { operation: 'MANAGE_TEMPLATES', method: 'GET', edge: '/message_templates', pages: true, body: false };
    case 'COMMENTS_LIST': return { operation: 'MANAGE_COMMENTS', method: 'GET', edge: '/comments', pages: true, body: false };
    case 'SUBSCRIBED_APPS_LIST': return { operation: 'SUBSCRIBE_WEBHOOKS', method: 'GET', edge: '/subscribed_apps', pages: true, body: false };
    case 'SEND_MESSAGE': return { operation: 'SEND_MESSAGE', method: 'POST', edge: '/messages', pages: false, body: true };
    case 'TEMPLATE_CREATE': return { operation: 'MANAGE_TEMPLATES', method: 'POST', edge: '/message_templates', pages: false, body: true };
    case 'COMMENT_REPLY': return { operation: 'MANAGE_COMMENTS', method: 'POST', edge: '/replies', pages: false, body: true };
    case 'SUBSCRIBE_APP': return { operation: 'SUBSCRIBE_WEBHOOKS', method: 'POST', edge: '/subscribed_apps', pages: false, body: true };
    default: return undefined;
  }
}
function validQuery(value: MetaGraphQuery | undefined): boolean {
  if (value === undefined) return true;
  if (!record(value) || Object.keys(value).some((key) => !['fields', 'limit', 'after', 'since', 'until'].includes(key))) return false;
  if (value.fields !== undefined && (typeof value.fields !== 'string' || !FIELDS.test(value.fields))) return false;
  if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > MAX_PAGE_SIZE)) return false;
  if (value.after !== undefined && (typeof value.after !== 'string' || !CURSOR.test(value.after))) return false;
  return ['since', 'until'].every((key) => (value as Record<string, unknown>)[key] === undefined ||
    (Number.isSafeInteger((value as Record<string, number>)[key]) && (value as Record<string, number>)[key]! >= 0));
}
function secretKey(key: string): boolean { return SECRET_KEY.test(key) || /(?:^|[_-])(?:access|input|refresh|fb_exchange|client)[_-]?(?:token|secret)(?:$|[_-])/i.test(key); }
function validBody(value: unknown, depth = 0): value is MetaGraphJson {
  if (depth > 20) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 32_768 && !/[\u0000-\u001f\u007f]/.test(value);
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1_000 && value.every((item) => validBody(item, depth + 1));
  if (!record(value) || Object.keys(value).length > 256) return false;
  return Object.entries(value).every(([key, item]) => key.length <= 128 && !secretKey(key) && validBody(item, depth + 1));
}
function sanitize(value: unknown, credential: string, depth = 0): MetaGraphJson {
  if (depth > 24) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return credential.length >= 8 && value.includes(credential) ? '' : value.slice(0, 16_384);
  if (Array.isArray(value)) return Object.freeze(value.slice(0, 1_000).map((item) => sanitize(item, credential, depth + 1)));
  if (!record(value)) return null;
  const out: Record<string, MetaGraphJson> = Object.create(null) as Record<string, MetaGraphJson>;
  for (const [key, item] of Object.entries(value).slice(0, 1_000)) if (!secretKey(key)) out[key.slice(0, 128)] = sanitize(item, credential, depth + 1);
  return Object.freeze(out);
}
function providerNumber(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : undefined; }
function providerType(value: unknown): string | undefined { return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : undefined; }
function traceId(value: unknown): string | undefined { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined; }
function retryAfter(value: string | undefined, max: number): number | undefined { return value && /^\d{1,4}$/.test(value) ? Math.min(max, Number(value)) : undefined; }
function queryPath(path: string, query?: MetaGraphQuery): string {
  if (!query) return path;
  const p = new URLSearchParams();
  for (const key of ['fields', 'limit', 'after', 'since', 'until'] as const) if (query[key] !== undefined) p.set(key, String(query[key]));
  const q = p.toString(); return q ? `${path}?${q}` : path;
}
function normalizeError(status: number, body: Record<string, unknown> | undefined,
  headers: Readonly<Record<string, string | undefined>>, maxRetry: number): MetaGraphSafeError {
  const rawError = body?.['error'];
  const provider = record(rawError) ? rawError : undefined;
  const code = providerNumber(provider?.['code']);
  const subcode = providerNumber(provider?.['error_subcode']);
  const common = {
    ...(providerType(provider?.['type']) ? { providerType: providerType(provider?.['type']) } : {}),
    ...(status > 0 ? { httpStatus: status } : {}), ...(code !== undefined ? { providerCode: code } : {}),
    ...(subcode !== undefined ? { providerSubcode: subcode } : {}),
    ...(traceId(provider?.['fbtrace_id'] ?? headers['x-fb-trace-id']) ? { traceId: traceId(provider?.['fbtrace_id'] ?? headers['x-fb-trace-id']) } : {}),
  };
  if (status === 429) { const delay = retryAfter(headers['retry-after'], maxRetry); return err('RATE_LIMITED', { ...common, ...(delay !== undefined ? { retryAfterSeconds: delay } : {}), recommendedAction: 'RETRY_LATER' }, true); }
  if (code === 190 || status === 401) return err('CREDENTIAL_REJECTED', { ...common, recommendedAction: 'REAUTHENTICATE' });
  if (code === 10 || code === 200 || status === 403) return err('PERMISSION_REQUIRED', { ...common, recommendedAction: 'REVIEW_PERMISSION' });
  if (status >= 500) return err('TRANSIENT_PROVIDER_FAILURE', { ...common, recommendedAction: 'RETRY_LATER' }, true);
  if (status >= 300 && status < 400) return err('REDIRECT_REFUSED', common);
  if (status >= 400) return err('INVALID_REQUEST', common);
  return err('PROVIDER_ERROR', common);
}
function parse(response: MetaGraphTransportResponse, maxRetry: number): { body?: Record<string, unknown>; error?: MetaGraphSafeError } {
  let body: unknown; try { body = JSON.parse(response.body); } catch { return { error: err('RESPONSE_INVALID', { httpStatus: response.statusCode }) }; }
  if (!record(body)) return { error: err('RESPONSE_INVALID', { httpStatus: response.statusCode }) };
  if (Object.prototype.hasOwnProperty.call(body, 'error') || response.statusCode < 200 || response.statusCode >= 300) {
    return { error: normalizeError(response.statusCode, body, response.headers, maxRetry) };
  }
  return { body };
}
function nextCursor(value: unknown, host: MetaGraphHost, path: string, original?: MetaGraphQuery): { valid: boolean; cursor?: string; query?: MetaGraphQuery } {
  if (value === undefined || value === null) return { valid: true };
  if (typeof value !== 'string' || value.length > 4_096) return { valid: false };
  let url: URL; try { url = new URL(value); } catch { return { valid: false }; }
  if (url.protocol !== 'https:' || url.origin !== `https://${host}` || url.username || url.password || url.port || url.hash || url.pathname !== path) return { valid: false };
  const counts = new Map<string, number>(); for (const key of url.searchParams.keys()) counts.set(key, (counts.get(key) ?? 0) + 1);
  if ([...counts.keys()].some((key) => !['after', 'access_token', 'fields', 'limit', 'since', 'until'].includes(key)) || [...counts.values()].some((count) => count > 1)) return { valid: false };
  if ((url.searchParams.get('access_token')?.length ?? 0) > 8_192) return { valid: false };
  const cursor = url.searchParams.get('after'); if (!cursor || !CURSOR.test(cursor)) return { valid: false };
  for (const [key, value] of Object.entries(original ?? {})) if (key !== 'after' && url.searchParams.has(key) && url.searchParams.get(key) !== String(value)) return { valid: false };
  const merged: Record<string, string | number> = {};
  for (const key of ['fields', 'limit', 'since', 'until'] as const) {
    const fromNext = url.searchParams.get(key);
    const fromOriginal = original?.[key];
    const value = fromNext ?? fromOriginal;
    if (value === undefined) continue;
    if (key === 'fields') {
      if (typeof value !== 'string' || !FIELDS.test(value)) return { valid: false };
      merged[key] = value;
    } else {
      const numeric = fromNext === null ? value : Number(value);
      if (typeof numeric !== 'number' || !Number.isSafeInteger(numeric) || numeric < (key === 'limit' ? 1 : 0) || (key === 'limit' && numeric > MAX_PAGE_SIZE)) return { valid: false };
      merged[key] = numeric;
    }
  }
  const query = Object.freeze({ ...merged, after: cursor }) as MetaGraphQuery;
  if (!validQuery(query)) return { valid: false };
  return { valid: true, cursor, query };
}
function bodyFits(value: unknown): boolean { try { const json = JSON.stringify(value); return json !== undefined && Buffer.byteLength(json, 'utf8') <= MAX_REQUEST_BYTES; } catch { return false; } }
function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  const chosen = value ?? fallback; if (!Number.isSafeInteger(chosen) || chosen < min || chosen > max) throw new RangeError('Invalid Graph client limit.'); return chosen;
}

export class InMemoryMetaGraphMetrics implements MetaGraphMetrics {
  private readonly counts = new Map<string, number>();
  record(input: Parameters<MetaGraphMetrics['record']>[0]): void {
    const key = [input.operation, input.product, input.environment, input.outcome, input.category].join('|');
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
  snapshot(): Readonly<Record<string, number>> { return Object.freeze(Object.fromEntries(this.counts)); }
}

function safeUsageCallCount(headers: Readonly<Record<string, string | undefined>>): number | undefined {
  let maximum: number | undefined;
  for (const key of ['x-app-usage', 'x-business-use-case-usage']) {
    const raw = headers[key]; if (!raw || raw.length > 4_096) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      const scan = (value: unknown, depth = 0): void => {
        if (!record(value) || depth > 6) return;
        for (const [name, item] of Object.entries(value)) {
          if (name === 'call_count' && typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 100) maximum = Math.max(maximum ?? 0, item);
          else if (record(item)) scan(item, depth + 1);
          else if (Array.isArray(item)) for (const nested of item.slice(0, 32)) scan(nested, depth + 1);
        }
      };
      scan(parsed);
    } catch { /* Invalid provider usage hints are ignored. */ }
  }
  return maximum;
}

class RequestQuota {
  private readonly buckets = new Map<string, Bucket>();
  constructor(private readonly max: number, private readonly now: () => number) {}
  observe(key: string, headers: Readonly<Record<string, string | undefined>>): void {
    const usage = safeUsageCallCount(headers); if (usage === undefined) return;
    const now = this.now(); let bucket = this.buckets.get(key);
    if (!bucket) { if (this.buckets.size >= MAX_BUCKETS) return; bucket = { startAt: now, count: 0 }; this.buckets.set(key, bucket); }
    if (now - bucket.startAt >= RATE_WINDOW_MS) { bucket.startAt = now; bucket.count = 0; }
    bucket.count = Math.max(bucket.count, Math.ceil(this.max * usage / 100));
  }
  consume(key: string): number | undefined {
    const now = this.now(); for (const [id, bucket] of this.buckets) if (now - bucket.startAt >= RATE_WINDOW_MS) this.buckets.delete(id);
    let bucket = this.buckets.get(key);
    if (!bucket) { if (this.buckets.size >= MAX_BUCKETS) return Number.POSITIVE_INFINITY; bucket = { startAt: now, count: 0 }; this.buckets.set(key, bucket); }
    if (bucket.count >= this.max) return Math.max(1, RATE_WINDOW_MS - (now - bucket.startAt));
    bucket.count += 1; return 0;
  }
}

export class MetaGraphClient {
  private readonly limits: Limits;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly quota: RequestQuota;
  private readonly activeByApp = new Map<string, number>();
  private activeGlobal = 0;

  constructor(
    private readonly configs: MetaAppConfigRegistry,
    private readonly credentials: Pick<CredentialResolverService, 'withCredentialForContext'>,
    private readonly transport: MetaGraphTransport,
    private readonly metrics: MetaGraphMetrics,
    options: MetaGraphClientOptions = {},
  ) {
    this.limits = Object.freeze({
      connectTimeoutMs: bounded(options.connectTimeoutMs, 2_000, 1, 15_000),
      headersTimeoutMs: bounded(options.headersTimeoutMs, 3_000, 1, 15_000),
      readTimeoutMs: bounded(options.readTimeoutMs, 5_000, 1, 15_000),
      overallTimeoutMs: bounded(options.overallTimeoutMs, 10_000, 1, 30_000),
      maxPages: bounded(options.maxPages, MAX_PAGES, 1, MAX_PAGES),
      maxItems: bounded(options.maxItems, MAX_ITEMS, 1, MAX_ITEMS),
      maxConcurrencyPerApp: bounded(options.maxConcurrencyPerApp, 4, 1, 32),
      maxConcurrencyGlobal: bounded(options.maxConcurrencyGlobal, 32, 1, 128),
      maxRequestsPerAppWindow: bounded(options.maxRequestsPerAppWindow, 120, 1, 10_000),
      maxResponseBytes: bounded(options.maxResponseBytes, MAX_RESPONSE_BYTES, 1_024, MAX_RESPONSE_BYTES),
    });
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.quota = new RequestQuota(this.limits.maxRequestsPerAppWindow, this.now);
  }

  async execute(input: MetaGraphInput): Promise<MetaGraphCallResult> { return await this.run(input, 'SINGLE') as MetaGraphCallResult; }
  async collect(input: MetaGraphInput, limit: { readonly maxPages?: number; readonly maxItems?: number } = {}): Promise<MetaGraphCollectionResult> {
    return await this.run(input, 'COLLECTION', limit) as MetaGraphCollectionResult;
  }
  private async run(input: MetaGraphInput, mode: 'SINGLE' | 'COLLECTION', collectionLimit: { readonly maxPages?: number; readonly maxItems?: number } = {}): Promise<MetaGraphCallResult | MetaGraphCollectionResult> {
    const desc = route(input);
    if (!desc || !this.validInput(input, desc, mode, collectionLimit)) return mode === 'SINGLE' ? callFailure('REQUEST_INVALID') : listFailure('REQUEST_INVALID');
    if (desc.operation !== input.operation || input.context.operation !== input.operation ||
        input.credentialCapability !== input.operation || !UUID.test(input.correlationId) || input.resourceId !== input.context.providerObjectId) {
      return this.finish(input, mode === 'SINGLE' ? callFailure('REQUEST_INVALID') : listFailure('REQUEST_INVALID'));
    }
    const ctx = input.context;
    let profile: MetaAppConfiguration | undefined;
    try { profile = this.configs.resolve(ctx.flowVariant, ctx.authVariant, ctx.environment); } catch { profile = undefined; }
    if (!profile || profile.configurationRef !== ctx.configurationRef || profile.versions.graphApi.status !== 'VERIFIED' ||
        !/^v\d{1,2}\.\d{1,3}$/.test(profile.versions.graphApi.value)) {
      return this.finish(input, mode === 'SINGLE' ? callFailure('CONFIGURATION_UNAVAILABLE') : listFailure('CONFIGURATION_UNAVAILABLE'));
    }
    const publicProfile = this.configs.bootstrap().profiles.find((row) => row.flowVariant === ctx.flowVariant && row.authVariant === ctx.authVariant);
    const capability = publicProfile?.capabilities.find((row) => row.operation === input.operation);
    if (!publicProfile?.enabled || !capability?.enabled) {
      const reason = capability?.reasonCode ?? publicProfile?.reasonCode ?? 'CONFIGURATION_MISSING';
      return this.finish(input, mode === 'SINGLE' ? callFailure('CAPABILITY_DISABLED', reason) : listFailure('CAPABILITY_DISABLED', reason));
    }

    const key = `${ctx.tenantId}:${ctx.appConfigurationId}`;
    const active = this.activeByApp.get(key) ?? 0;
    if (active >= this.limits.maxConcurrencyPerApp || this.activeGlobal >= this.limits.maxConcurrencyGlobal) {
      return this.finish(input, mode === 'SINGLE' ? callFailure('BUSY', undefined, true) : listFailure('BUSY', undefined, true));
    }
    this.activeByApp.set(key, active + 1);
    this.activeGlobal += 1;
    let result: MetaGraphCallResult | MetaGraphCollectionResult | undefined;
    try {
      const body = 'body' in input ? JSON.stringify(input.body) : undefined;
      const host = HOSTS[ctx.authVariant];
      const basePath = `/${profile.versions.graphApi.value}/${input.resourceId}${desc.edge}`;
      const { configurationRef: _configurationRef, providerObjectId: _providerObjectId, ...expectedContext } = ctx;
      await this.credentials.withCredentialForContext(input.credentialHandle, expectedContext, async (secret) => {
        result = mode === 'COLLECTION'
          ? await this.collectPages(input, desc, host, basePath, secret, collectionLimit)
          : await this.callOnce(input, desc, host, queryPath(basePath, input.query), body, secret);
      });
    } catch {
      result = mode === 'SINGLE' ? callFailure('CREDENTIAL_UNAVAILABLE') : listFailure('CREDENTIAL_UNAVAILABLE');
    } finally {
      const next = (this.activeByApp.get(key) ?? 1) - 1;
      if (next <= 0) this.activeByApp.delete(key); else this.activeByApp.set(key, next);
      this.activeGlobal -= 1;
    }
    return this.finish(input, result ?? (mode === 'SINGLE' ? callFailure('CREDENTIAL_UNAVAILABLE') : listFailure('CREDENTIAL_UNAVAILABLE')));
  }

  private validInput(input: MetaGraphInput, desc: Route, mode: 'SINGLE' | 'COLLECTION',
    limit: { readonly maxPages?: number; readonly maxItems?: number }): boolean {
    const allowed = new Set(['context', 'credentialHandle', 'credentialCapability', 'operation', 'correlationId', 'resourceId', 'query', 'endpoint', 'edge', 'body']);
    const contextAllowed = new Set(['tenantId', 'provider', 'appConfigurationId', 'environment', 'assetId', 'operation', 'flowVariant', 'authVariant', 'configurationRef', 'providerObjectId']);
    if (!input || !record(input) || Object.keys(input).some((key) => !allowed.has(key)) || !record(input.context) ||
        Object.keys(input.context).some((key) => !contextAllowed.has(key)) || input.context.provider !== 'META' ||
        !UUID.test(input.context.tenantId) || !UUID.test(input.context.appConfigurationId) || !UUID.test(input.context.assetId) || !ID.test(input.context.providerObjectId) ||
        !ID.test(input.resourceId) || !/^[A-Za-z0-9._-]{1,96}$/.test(input.context.configurationRef) || !validQuery(input.query) ||
        (desc.method === 'POST') !== ('body' in input) || ('body' in input && (!record(input.body) || !validBody(input.body) || !bodyFits(input.body))) ||
        (!desc.body && 'body' in input) || (mode === 'COLLECTION' && (!desc.pages || desc.method !== 'GET')) ||
        (limit.maxPages !== undefined && (!Number.isSafeInteger(limit.maxPages) || limit.maxPages < 1 || limit.maxPages > this.limits.maxPages)) ||
        (limit.maxItems !== undefined && (!Number.isSafeInteger(limit.maxItems) || limit.maxItems < 1 || limit.maxItems > this.limits.maxItems))) return false;
    return ['development', 'test', 'staging', 'production'].includes(input.context.environment) &&
      ['FACEBOOK', 'INSTAGRAM', 'WHATSAPP_EXCLUSIVE', 'WHATSAPP_COEXISTENCE'].includes(input.context.flowVariant);
  }

  private async callOnce(input: MetaGraphInput, desc: Route, host: MetaGraphHost, path: string, body: string | undefined,
    secret: string): Promise<MetaGraphCallResult> {
    const sent = await this.send(input, host, desc.method, path, body, secret, MAX_RETRIES);
    if (sent.error) {
      const ambiguous = desc.method === 'POST' && (sent.error.ambiguous || sent.error.category === 'NETWORK_ERROR' || sent.error.category === 'TRANSIENT_PROVIDER_FAILURE');
      const error = ambiguous ? (sent.error.ambiguous ? sent.error : err('AMBIGUOUS_POST', {
        httpStatus: sent.error.httpStatus, recommendedAction: 'RECONCILE',
      }, false, true)) : sent.error;
      return Object.freeze({ outcome: ambiguous ? 'UNKNOWN' : 'FAILED', error, httpStatus: error.httpStatus,
        attempts: sent.attempts, retries: sent.retries, retryable: error.retryable, ambiguous: error.ambiguous });
    }
    if (!sent.response) return callFailure('NETWORK_ERROR', undefined, true, false, sent.attempts, sent.retries);
    const parsed = parse(sent.response, RETRY_AFTER_MAX);
    if (parsed.error) {
      const ambiguous = desc.method === 'POST' && parsed.error.category === 'TRANSIENT_PROVIDER_FAILURE';
      const error = ambiguous ? err('AMBIGUOUS_POST', { httpStatus: parsed.error.httpStatus, recommendedAction: 'RECONCILE' }, false, true) : parsed.error;
      return Object.freeze({ outcome: ambiguous ? 'UNKNOWN' : 'FAILED', error, httpStatus: sent.response.statusCode,
        attempts: sent.attempts, retries: sent.retries, retryable: error.retryable, ambiguous: error.ambiguous });
    }
    return Object.freeze({ outcome: 'SUCCEEDED', data: sanitize(parsed.body, secret), httpStatus: sent.response.statusCode,
      attempts: sent.attempts, retries: sent.retries, retryable: false, ambiguous: false });
  }

  private async send(input: MetaGraphInput, host: MetaGraphHost, method: MetaGraphMethod, path: string,
    body: string | undefined, secret: string, retryBudget: number): Promise<RequestResult> {
    if (secret.length < 8 || secret.length > 8_192 || /[\r\n\u0000]/.test(secret)) return { error: err('CREDENTIAL_UNAVAILABLE'), attempts: 0, retries: 0 };
    const key = `${input.context.tenantId}:${input.context.appConfigurationId}`;
    const max = method === 'GET' ? Math.min(MAX_RETRIES + 1, retryBudget + 1) : 1;
    let attempts = 0; let retries = 0; let last: MetaGraphSafeError | undefined;
    while (attempts < max) {
      const quotaWait = this.quota.consume(key);
      if (quotaWait !== 0) return { error: err('REQUEST_BUDGET_EXHAUSTED', {
        ...(Number.isFinite(quotaWait) ? { retryAfterSeconds: Math.ceil(quotaWait! / 1_000) } : {}), recommendedAction: 'RETRY_LATER',
      }, Number.isFinite(quotaWait)), attempts, retries };
      attempts += 1;
      try {
        const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${secret}` };
        if (body !== undefined) headers['content-type'] = 'application/json';
        const response = await this.transport.send(Object.freeze({ host, method, path, headers: Object.freeze(headers),
          flowVariant: input.context.flowVariant, authVariant: input.context.authVariant, environment: input.context.environment,
          configurationRef: input.context.configurationRef, operation: input.operation, graphApiVersion: path.split('/')[1]!, correlationId: input.correlationId,
          ...(body !== undefined ? { body } : {}), connectTimeoutMs: this.limits.connectTimeoutMs, headersTimeoutMs: this.limits.headersTimeoutMs,
          readTimeoutMs: this.limits.readTimeoutMs, overallTimeoutMs: this.limits.overallTimeoutMs, maxResponseBytes: this.limits.maxResponseBytes } satisfies MetaGraphTransportRequest));
        this.quota.observe(key, response.headers);
        if (method === 'GET' && (response.statusCode === 429 || response.statusCode >= 500) && attempts < max) {
          retries += 1; await this.sleep(this.retryDelay(response.headers['retry-after'], attempts)); continue;
        }
        return { response, attempts, retries };
      } catch (error) {
        const failure = error instanceof MetaGraphTransportFailure ? error : undefined;
        const tooLarge = failure?.kind === 'RESPONSE_TOO_LARGE';
        const phase = failure?.kind === 'CONNECT_TIMEOUT' ? 'CONNECT' : failure?.kind === 'HEADERS_TIMEOUT' ? 'HEADERS' :
          failure?.kind === 'READ_TIMEOUT' ? 'READ' : failure?.kind === 'OVERALL_TIMEOUT' ? 'OVERALL' : undefined;
        const transient = err(tooLarge ? 'RESPONSE_TOO_LARGE' : 'NETWORK_ERROR', {
          ...(phase ? { timeoutPhase: phase } : {}), recommendedAction: 'RETRY_LATER',
        }, !tooLarge);
        if (method !== 'GET') return { error: err('AMBIGUOUS_POST', {
          ...(phase ? { timeoutPhase: phase } : {}), recommendedAction: 'RECONCILE',
        }, false, true), attempts, retries };
        last = transient;
        if (tooLarge || attempts >= max) break;
        retries += 1; await this.sleep(this.retryDelay(undefined, attempts));
      }
    }
    return { error: last ?? err('NETWORK_ERROR', { recommendedAction: 'RETRY_LATER' }, true), attempts, retries };
  }

  private retryDelay(header: string | undefined, attempt: number): number {
    const explicit = retryAfter(header, RETRY_AFTER_MAX);
    const sample = this.random(); const jitter = Number.isFinite(sample) && sample >= 0 && sample < 1 ? Math.floor(sample * 250) : 0;
    return explicit !== undefined ? explicit * 1_000 : Math.min(5_000, 100 * 2 ** Math.max(0, attempt - 1) + jitter);
  }

  private finish<T extends MetaGraphCallResult | MetaGraphCollectionResult>(input: MetaGraphInput, result: T): T {
    const operations: readonly string[] = ['ASSET_DISCOVERY', 'SEND_MESSAGE', 'MANAGE_COMMENTS', 'MANAGE_TEMPLATES', 'READ_STATUS', 'SUBSCRIBE_WEBHOOKS', 'SYNC_HISTORY'];
    const flows: readonly string[] = ['FACEBOOK', 'INSTAGRAM', 'WHATSAPP_EXCLUSIVE', 'WHATSAPP_COEXISTENCE'];
    const environments: readonly string[] = ['development', 'test', 'staging', 'production'];
    if (operations.includes(input.operation) && flows.includes(input.context.flowVariant) && environments.includes(input.context.environment)) {
      this.metrics.record(Object.freeze({ operation: input.operation, product: input.context.flowVariant, environment: input.context.environment,
        outcome: result.outcome, category: result.error?.category ?? 'NONE', attempts: result.attempts, retries: result.retries }));
    }
    return result;
  }


  private async collectPages(input: MetaGraphInput, desc: Route, host: MetaGraphHost, base: string, secret: string,
    limits: { readonly maxPages?: number; readonly maxItems?: number }): Promise<MetaGraphCollectionResult> {
    const maxPages = limits.maxPages ?? this.limits.maxPages;
    const maxItems = limits.maxItems ?? this.limits.maxItems;
    const data: MetaGraphJson[] = [];
    const seen = new Set<string>();
    let cursor = input.query?.after ?? null;
    let currentQuery: MetaGraphQuery | undefined = input.query;
    if (cursor) seen.add(cursor);
    let pages = 0; let attempts = 0; let retries = 0; let budget = MAX_COLLECTION_RETRIES;
    for (let index = 0; index < maxPages; index += 1) {
      const query: MetaGraphQuery = Object.freeze({ ...currentQuery, ...(cursor ? { after: cursor } : {}) });
      const sent = await this.send(input, host, 'GET', queryPath(base, query), undefined, secret, Math.min(MAX_RETRIES, budget));
      attempts += sent.attempts; retries += sent.retries; budget -= sent.retries;
      if (sent.error || !sent.response) {
        const error = sent.error ?? err('NETWORK_ERROR', { recommendedAction: 'RETRY_LATER' }, true);
        return listResult(data.length ? 'PARTIAL' : 'FAILED', data, error, pages ? { after: cursor, pagesProcessed: pages, itemsProcessed: data.length } : undefined, sent.response?.statusCode, attempts, retries);
      }
      const parsed = parse(sent.response, RETRY_AFTER_MAX);
      if (parsed.error || !Array.isArray(parsed.body?.['data'])) {
        const error = parsed.error ?? err('RESPONSE_INVALID', { httpStatus: sent.response.statusCode });
        return listResult(data.length ? 'PARTIAL' : 'FAILED', data, error, pages ? { after: cursor, pagesProcessed: pages, itemsProcessed: data.length } : undefined, sent.response.statusCode, attempts, retries);
      }
      const items = parsed.body['data'] as unknown[];
      if (items.length > maxItems - data.length) {
        return listResult('PARTIAL', data, err('LIMIT_REACHED'), { after: cursor, pagesProcessed: pages, itemsProcessed: data.length }, sent.response.statusCode, attempts, retries);
      }
      for (const item of items) data.push(sanitize(item, secret));
      pages += 1;
      const paging = record(parsed.body['paging']) ? parsed.body['paging'] : undefined;
      const next = nextCursor(paging?.['next'], host, base, input.query);
      if (!next.valid) return listResult('PARTIAL', data, err('PAGINATION_INVALID'),
        { after: cursor, pagesProcessed: pages, itemsProcessed: data.length }, sent.response.statusCode, attempts, retries);
      if (!next.cursor) return listResult('SUCCEEDED', data, undefined, undefined, sent.response.statusCode, attempts, retries);
      if (seen.has(next.cursor)) return listResult('PARTIAL', data, err('PAGINATION_LOOP'),
        { after: cursor, pagesProcessed: pages, itemsProcessed: data.length }, sent.response.statusCode, attempts, retries);
      seen.add(next.cursor);
      if (pages >= maxPages || data.length >= maxItems) return listResult('PARTIAL', data, err('LIMIT_REACHED'),
        { after: next.cursor, pagesProcessed: pages, itemsProcessed: data.length }, sent.response.statusCode, attempts, retries);
      cursor = next.cursor;
      currentQuery = next.query;
    }
    return listResult('PARTIAL', data, err('LIMIT_REACHED'), { after: cursor, pagesProcessed: pages, itemsProcessed: data.length }, undefined, attempts, retries);
  }
}

function callFailure(category: MetaGraphSafeErrorCategory, capabilityReason?: string, retryable = false,
  ambiguous = false, attempts = 0, retries = 0): MetaGraphCallResult {
  const error = err(category, capabilityReason ? { capabilityReason } : {}, retryable, ambiguous);
  return Object.freeze({ outcome: ambiguous ? 'UNKNOWN' : 'FAILED', error, attempts, retries, retryable: error.retryable, ambiguous: error.ambiguous });
}
function listFailure(category: MetaGraphSafeErrorCategory, capabilityReason?: string, retryable = false): MetaGraphCollectionResult {
  const error = err(category, capabilityReason ? { capabilityReason } : {}, retryable);
  return listResult('FAILED', [], error, undefined, undefined, 0, 0);
}
function listResult(outcome: MetaGraphCollectionResult['outcome'], data: readonly MetaGraphJson[], error: MetaGraphSafeError | undefined,
  checkpoint: MetaGraphCollectionResult['checkpoint'], status: number | undefined, attempts: number, retries: number): MetaGraphCollectionResult {
  return Object.freeze({ outcome, data: Object.freeze([...data]), ...(checkpoint ? { checkpoint: Object.freeze(checkpoint) } : {}),
    ...(error ? { error } : {}), ...(status !== undefined ? { httpStatus: status } : {}), attempts, retries,
    retryable: error?.retryable ?? false, ambiguous: error?.ambiguous ?? false });
}
