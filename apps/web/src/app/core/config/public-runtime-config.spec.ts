import { describe, expect, it } from 'vitest';
import { resolveMetaApiBaseUrl, validateExactHttpsOrigins } from './public-runtime-config';

describe('resolveMetaApiBaseUrl', () => {
  it('uses the compiled fallback when runtime config is absent or empty', () => {
    expect(resolveMetaApiBaseUrl(undefined, '')).toBe('');
    expect(resolveMetaApiBaseUrl({}, '')).toBe('');
  });

  it('accepts the supported versioned same-origin API paths', () => {
    expect(resolveMetaApiBaseUrl({ version: 1, metaApiBaseUrl: '/api' }, '')).toBe('/api');
    expect(resolveMetaApiBaseUrl({ version: 1, metaApiBaseUrl: '/api/v1' }, '')).toBe('/api/v1');
  });

  it('rejects unknown keys, unversioned values and cross-origin endpoints', () => {
    expect(() => resolveMetaApiBaseUrl({ version: 1, metaApiBaseUrl: '/api', token: 'x' }, '')).toThrow();
    expect(() => resolveMetaApiBaseUrl({ version: 2, metaApiBaseUrl: '/api' }, '')).toThrow();
    expect(() => resolveMetaApiBaseUrl({ version: 1, metaApiBaseUrl: 'https://api.example' }, '')).toThrow();
    expect(() => resolveMetaApiBaseUrl({ version: 1, metaApiBaseUrl: '//evil.example' }, '')).toThrow();
    expect(() => resolveMetaApiBaseUrl({ version: 1, metaApiBaseUrl: '/api/../../outside' }, '')).toThrow();
  });

  it('does not accept an unsafe compiled fallback', () => {
    expect(() => resolveMetaApiBaseUrl(undefined, 'https://api.example')).toThrow();
  });

  it('accepts only exact HTTPS origins for embed and provider allowlists', () => {
    expect(validateExactHttpsOrigins(['https://suite4.synthetic.invalid', 'https://suite4-stage.synthetic.invalid:8443']))
      .toEqual(['https://suite4.synthetic.invalid', 'https://suite4-stage.synthetic.invalid:8443']);
    expect(() => validateExactHttpsOrigins(['https://*.example.test'])).toThrow();
    expect(() => validateExactHttpsOrigins(['https://example.test/path'])).toThrow();
    expect(() => validateExactHttpsOrigins(['https://example.test', 'https://example.test'])).toThrow();
  });

  it('accepts and validates the versioned public embed settings without accepting arbitrary keys', () => {
    expect(resolveMetaApiBaseUrl({ version: 1, metaApiBaseUrl: '/api', suite4EmbedOrigins: [] }, ''))
      .toBe('/api');
    expect(() => resolveMetaApiBaseUrl({ version: 1, metaApiBaseUrl: '/api', suite4EmbedOrigins: ['http://suite4.test'] }, ''))
      .toThrow();
    expect(() => resolveMetaApiBaseUrl({ version: 1, metaApiBaseUrl: '/api', apiSecret: 'forbidden' }, ''))
      .toThrow();
  });
});
