import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type { MetaAppConfigRegistry } from '../meta-config/meta-app-config.registry.js';
import type { MetaGraphHost, MetaGraphTransport, MetaGraphTransportRequest, MetaGraphTransportResponse } from './meta-graph.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const CURSOR = /^[A-Za-z0-9._~+/%=-]{1,1024}$/;
const HOST: Readonly<Record<MetaGraphTransportRequest['authVariant'], MetaGraphHost>> = Object.freeze({
  FACEBOOK_LOGIN_FOR_BUSINESS: 'graph.facebook.com', INSTAGRAM_VIA_FACEBOOK_LOGIN: 'graph.facebook.com',
  INSTAGRAM_LOGIN: 'graph.instagram.com', WHATSAPP_EMBEDDED_SIGNUP: 'graph.facebook.com',
  WHATSAPP_BUSINESS_APP_ONBOARDING: 'graph.facebook.com',
});

export class MetaGraphTransportFailure extends Error {
  constructor(readonly kind: 'CONNECT_TIMEOUT' | 'HEADERS_TIMEOUT' | 'READ_TIMEOUT' | 'OVERALL_TIMEOUT' | 'RESPONSE_TOO_LARGE' | 'NETWORK') {
    super('Graph transport failed.');
  }
}

function safeUsage(raw: string | string[] | undefined): string | undefined {
  const text = typeof raw === 'string' && raw.length <= 4_096 ? raw : undefined; if (!text) return undefined;
  let max: number | undefined;
  const visit = (value: unknown, depth = 0): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 6) return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'call_count' && typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 100) max = Math.max(max ?? 0, item);
      else if (Array.isArray(item)) for (const nested of item.slice(0, 32)) visit(nested, depth + 1);
      else visit(item, depth + 1);
    }
  };
  try { visit(JSON.parse(text)); } catch { return undefined; }
  return max === undefined ? undefined : JSON.stringify({ call_count: max });
}
function safeHeaders(headers: IncomingHttpHeaders): Readonly<Record<string, string | undefined>> {
  const retry = headers['retry-after']; const trace = headers['x-fb-trace-id'];
  return Object.freeze({
    'retry-after': typeof retry === 'string' && retry.length <= 64 ? retry : undefined,
    'x-fb-trace-id': typeof trace === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(trace) ? trace : undefined,
    'x-app-usage': safeUsage(headers['x-app-usage']),
    'x-business-use-case-usage': safeUsage(headers['x-business-use-case-usage']),
  });
}

function routeAllowed(input: MetaGraphTransportRequest, pathname: string): boolean {
  const segments = pathname.split('/').slice(1);
  if (segments.length < 2 || segments[0] !== input.graphApiVersion || !ID.test(segments[1]!)) return false;
  const edge = segments.slice(2).join('/');
  switch (input.operation) {
    case 'READ_STATUS': return input.method === 'GET' && edge === '';
    case 'ASSET_DISCOVERY': return input.method === 'GET' && (segments[1] === 'me'
      ? input.flowVariant === 'FACEBOOK' && input.authVariant === 'FACEBOOK_LOGIN_FOR_BUSINESS' && edge === 'accounts'
      : edge === 'owned_whatsapp_business_accounts'
        ? input.flowVariant === 'WHATSAPP_EXCLUSIVE' && input.authVariant === 'WHATSAPP_EMBEDDED_SIGNUP'
        : ['accounts', 'businesses', 'instagram_accounts', 'owned_pages', 'phone_numbers'].includes(edge));
    case 'SEND_MESSAGE': return input.method === 'POST' && edge === 'messages';
    case 'MANAGE_TEMPLATES': return ['GET', 'POST'].includes(input.method) && edge === 'message_templates';
    case 'MANAGE_COMMENTS': return (input.method === 'GET' && edge === 'comments') || (input.method === 'POST' && edge === 'replies');
    case 'SUBSCRIBE_WEBHOOKS': return ['GET', 'POST'].includes(input.method) && edge === 'subscribed_apps';
    case 'PHONE_REGISTRATION_CONVENTIONAL': return input.flowVariant === 'WHATSAPP_EXCLUSIVE' &&
      input.authVariant === 'WHATSAPP_EMBEDDED_SIGNUP' && input.method === 'POST' && edge === 'register';
    default: return false;
  }
}

function containsPinKey(value: unknown, depth = 0): boolean {
  if (depth > 20) return true;
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsPinKey(item, depth + 1));
  return Object.entries(value).some(([key, item]) => key.toLowerCase() === 'pin' || containsPinKey(item, depth + 1));
}

function safeBody(input: MetaGraphTransportRequest): boolean {
  if (input.operation !== 'PHONE_REGISTRATION_CONVENTIONAL') {
    if (input.body === undefined) return true;
    try { return !containsPinKey(JSON.parse(input.body)); } catch { return false; }
  }
  if (!input.body) return false;
  try {
    const value: unknown = JSON.parse(input.body);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const body = value as Record<string, unknown>;
    return Object.keys(body).length === 2 && Object.keys(body).every((key) => key === 'messaging_product' || key === 'pin') &&
      body['messaging_product'] === 'whatsapp' && typeof body['pin'] === 'string' && /^\d{6}$/.test(body['pin']);
  } catch { return false; }
}

function safePath(input: MetaGraphTransportRequest): boolean {
  if (!input.path.startsWith('/') || input.path.length > 4096 || input.path.includes('#') || input.path.includes('\\') || input.path.startsWith('//')) return false;
  const parts = input.path.split('?'); if (parts.length > 2) return false;
  const [pathname, query = ''] = parts;
  if (!pathname || !routeAllowed(input, pathname)) return false;
  const pageDiscoveryPath = /^\/v\d{1,2}\.\d{1,3}\/me\/accounts$/.test(pathname);
  if (!query) return !pageDiscoveryPath;
  const allowed = new Set(['fields', 'limit', 'after', 'since', 'until']); const params = new URLSearchParams(query); const seen = new Set<string>();
  for (const [key, value] of params) {
    if (!allowed.has(key) || seen.has(key) || value.length > 1_024 || /[\u0000-\u001f\u007f]/.test(value)) return false;
    seen.add(key);
  }
  if (pageDiscoveryPath && (params.get('fields') !== 'name,access_token,tasks' || params.get('limit') !== '100' ||
      params.has('since') || params.has('until') || (params.has('after') && !CURSOR.test(params.get('after') ?? '')))) return false;
  return true;
}

/** HTTPS-only; repeats the M4.01 operation/version gate and permits only route templates. */
export class NodeMetaGraphTransport implements MetaGraphTransport {
  constructor(private readonly configs: MetaAppConfigRegistry) {}

  async send(input: MetaGraphTransportRequest): Promise<MetaGraphTransportResponse> {
    const profile = this.configs.resolve(input.flowVariant, input.authVariant, input.environment);
    const capability = this.configs.bootstrap().profiles.find((row) => row.flowVariant === input.flowVariant && row.authVariant === input.authVariant)
      ?.capabilities.find((row) => row.operation === input.operation);
    const headerNames = Object.keys(input.headers).map((key) => key.toLowerCase());
    if (!profile || profile.configurationRef !== input.configurationRef || profile.versions.graphApi.status !== 'VERIFIED' ||
        input.graphApiVersion !== profile.versions.graphApi.value || !capability?.enabled || input.host !== HOST[input.authVariant] ||
        !UUID.test(input.correlationId) || !safePath(input) || !safeBody(input) || headerNames.some((key) => !['accept', 'authorization', 'content-type'].includes(key)) ||
        input.headers['accept'] !== 'application/json' ||
        (input.body === undefined ? input.headers['content-type'] !== undefined : input.headers['content-type'] !== 'application/json') ||
        !/^Bearer [^\s\r\n]{8,8192}$/.test(input.headers['authorization'] ?? '') ||
        (input.body !== undefined && Buffer.byteLength(input.body, 'utf8') > 64 * 1024) ||
        !Number.isSafeInteger(input.connectTimeoutMs) || input.connectTimeoutMs < 1 || input.connectTimeoutMs > 15_000 ||
        !Number.isSafeInteger(input.headersTimeoutMs) || input.headersTimeoutMs < 1 || input.headersTimeoutMs > 15_000 ||
        !Number.isSafeInteger(input.readTimeoutMs) || input.readTimeoutMs < 1 || input.readTimeoutMs > 15_000 ||
        !Number.isSafeInteger(input.overallTimeoutMs) || input.overallTimeoutMs < 1 || input.overallTimeoutMs > 30_000 ||
        !Number.isSafeInteger(input.maxResponseBytes) || input.maxResponseBytes < 1 || input.maxResponseBytes > 1_000_000) {
      throw new MetaGraphTransportFailure('NETWORK');
    }

    return await new Promise((resolve, reject) => {
      let settled = false; let size = 0; let connectTimer: ReturnType<typeof setTimeout> | undefined;
      let headersTimer: ReturnType<typeof setTimeout> | undefined; let readTimer: ReturnType<typeof setTimeout> | undefined;
      let req: ReturnType<typeof httpsRequest> | undefined; const chunks: Buffer[] = [];
      const clearTimers = () => { clearTimeout(overallTimer); clearTimeout(connectTimer); clearTimeout(headersTimer); clearTimeout(readTimer); };
      const fail = (kind: MetaGraphTransportFailure['kind']) => {
        if (settled) return; settled = true; clearTimers(); req?.destroy(); reject(new MetaGraphTransportFailure(kind));
      };
      const overallTimer = setTimeout(() => fail('OVERALL_TIMEOUT'), input.overallTimeoutMs);
      const resetReadTimer = () => { clearTimeout(readTimer); readTimer = setTimeout(() => fail('READ_TIMEOUT'), input.readTimeoutMs); };
      req = httpsRequest({ protocol: 'https:', hostname: input.host, method: input.method, path: input.path,
        headers: input.headers, agent: false, rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: input.host, maxHeaderSize: 16 * 1024 }, (response) => {
        clearTimeout(connectTimer); clearTimeout(headersTimer); resetReadTimer();
        response.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length;
          if (size > input.maxResponseBytes) { response.destroy(); fail('RESPONSE_TOO_LARGE'); return; }
          chunks.push(bytes); resetReadTimer();
        });
        response.on('error', () => fail('NETWORK'));
        response.on('end', () => {
          if (settled) return; settled = true; clearTimers();
          resolve(Object.freeze({ statusCode: response.statusCode ?? 0, headers: safeHeaders(response.headers), body: Buffer.concat(chunks, size).toString('utf8') }));
        });
      });
      req.on('socket', (socket) => {
        connectTimer = setTimeout(() => fail('CONNECT_TIMEOUT'), input.connectTimeoutMs);
        const tls = socket as TLSSocket;
        const connected = () => {
          clearTimeout(connectTimer);
          headersTimer = setTimeout(() => fail('HEADERS_TIMEOUT'), input.headersTimeoutMs);
        };
        // `agent: false` creates a fresh socket for each request, so secureConnect
        // cannot have fired before this socket listener is attached.
        tls.once('secureConnect', connected);
      });
      req.on('error', () => fail('NETWORK'));
      req.end(input.body);
    });
  }
}
