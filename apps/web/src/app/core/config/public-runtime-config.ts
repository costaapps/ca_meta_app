import { InjectionToken } from '@angular/core';
import { environment } from '../../../environments/environment';

interface PublicRuntimeConfig {
  readonly version: 1;
  readonly metaApiBaseUrl: string;
  readonly suite4EmbedOrigins?: readonly string[];
  readonly providerAuthorizationOrigins?: readonly string[];
}

declare global {
  interface Window {
    __CA_META_PUBLIC_CONFIG__?: unknown;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateBaseUrl(value: unknown): string {
  if (value === '' || value === '/api' || value === '/api/v1') return value;
  throw new Error('Public runtime configuration contains an unsupported API base path.');
}

export function validateExactHttpsOrigins(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 32) throw new Error('Public runtime origin configuration is invalid.');
  const origins = value.map((candidate) => {
    if (typeof candidate !== 'string' || candidate.length > 512) throw new Error('Public runtime origin configuration is invalid.');
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error('Public runtime origin configuration is invalid.');
    }
    if (parsed.protocol !== 'https:' || parsed.origin !== candidate || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash || candidate.includes('*')) {
      throw new Error('Public runtime origin configuration is invalid.');
    }
    return parsed.origin;
  });
  if (new Set(origins).size !== origins.length) throw new Error('Public runtime origin configuration is invalid.');
  return Object.freeze(origins);
}

function runtimeConfig(value: unknown): PublicRuntimeConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Public runtime configuration must be an object.');
  if (Object.keys(value).length === 0) return undefined;
  const allowedKeys = ['metaApiBaseUrl', 'providerAuthorizationOrigins', 'suite4EmbedOrigins', 'version'];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key)) || value['version'] !== 1) {
    throw new Error('Public runtime configuration does not match the supported schema.');
  }
  return Object.freeze({
    version: 1,
    metaApiBaseUrl: validateBaseUrl(value['metaApiBaseUrl']),
    suite4EmbedOrigins: validateExactHttpsOrigins(value['suite4EmbedOrigins']),
    providerAuthorizationOrigins: validateExactHttpsOrigins(value['providerAuthorizationOrigins']),
  });
}

export function resolveMetaApiBaseUrl(value: unknown, fallback: string): string {
  const safeFallback = validateBaseUrl(fallback);
  if (value === undefined) return safeFallback;
  if (isRecord(value) && Object.keys(value).length === 0) return safeFallback;
  return runtimeConfig(value)?.metaApiBaseUrl ?? safeFallback;
}

function publicConfig(): PublicRuntimeConfig | undefined {
  const runtime = typeof window === 'undefined' ? undefined : window.__CA_META_PUBLIC_CONFIG__;
  return runtimeConfig(runtime);
}

export const META_API_BASE_URL = new InjectionToken<string>('META_API_BASE_URL', {
  providedIn: 'root',
  factory: () => {
    return resolveMetaApiBaseUrl(publicConfig()?.metaApiBaseUrl, environment.metaApiBaseUrl);
  },
});

export const SUITE4_EMBED_ORIGINS = new InjectionToken<readonly string[]>('SUITE4_EMBED_ORIGINS', {
  providedIn: 'root',
  factory: () => publicConfig()?.suite4EmbedOrigins ?? Object.freeze([]),
});

export const PROVIDER_AUTHORIZATION_ORIGINS = new InjectionToken<readonly string[]>('PROVIDER_AUTHORIZATION_ORIGINS', {
  providedIn: 'root',
  factory: () => publicConfig()?.providerAuthorizationOrigins ?? Object.freeze([]),
});

export type { PublicRuntimeConfig };
