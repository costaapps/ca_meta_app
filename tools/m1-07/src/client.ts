import createClient from 'openapi-fetch';
import type { paths } from './generated/openapi.js';

/**
 * Typed public browser client for the proposed v1 API.
 * The host must be selected by the application deployment; this function has no live default.
 */
export function createMetaApiClient(baseUrl: string, fetcher?: typeof fetch) {
  return createClient<paths>({
    baseUrl,
    credentials: 'include',
    ...(fetcher ? { fetch: fetcher } : {}),
  });
}
