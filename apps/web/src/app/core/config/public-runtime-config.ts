import { InjectionToken } from '@angular/core';
import { environment } from '../../../environments/environment';

interface PublicRuntimeConfig {
  readonly version: 1;
  readonly metaApiBaseUrl: string;
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

export function resolveMetaApiBaseUrl(value: unknown, fallback: string): string {
  const safeFallback = validateBaseUrl(fallback);
  if (value === undefined) return safeFallback;
  if (!isRecord(value)) throw new Error('Public runtime configuration must be an object.');

  const keys = Object.keys(value).sort();
  if (keys.length === 0) return safeFallback;
  if (keys.join(',') !== 'metaApiBaseUrl,version' || value['version'] !== 1) {
    throw new Error('Public runtime configuration does not match the supported schema.');
  }

  return validateBaseUrl(value['metaApiBaseUrl']);
}

export const META_API_BASE_URL = new InjectionToken<string>('META_API_BASE_URL', {
  providedIn: 'root',
  factory: () => {
    const runtimeConfig = typeof window === 'undefined' ? undefined : window.__CA_META_PUBLIC_CONFIG__;
    return resolveMetaApiBaseUrl(runtimeConfig, environment.metaApiBaseUrl);
  },
});

export type { PublicRuntimeConfig };
