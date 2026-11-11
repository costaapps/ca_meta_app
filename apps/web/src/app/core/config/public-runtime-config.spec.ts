// @vitest-environment jsdom
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { environment } from '../../../environments/environment';
import {
  META_API_BASE_URL,
  PROVIDER_AUTHORIZATION_ORIGINS,
  resolveMetaApiBaseUrl,
  SUITE4_EMBED_ORIGINS,
  validateExactHttpsOrigins,
} from './public-runtime-config';

describe('resolveMetaApiBaseUrl', () => {
  it('uses the compiled fallback when runtime config is absent or empty', () => {
    expect(resolveMetaApiBaseUrl(undefined, '')).toBe('');
    expect(resolveMetaApiBaseUrl({}, '')).toBe('');
  });

  it('treats an injected empty runtime config object as absent and uses validated defaults', () => {
    const original = window.__CA_META_PUBLIC_CONFIG__;
    window.__CA_META_PUBLIC_CONFIG__ = {};
    try {
      TestBed.configureTestingModule({});
      expect(TestBed.inject(META_API_BASE_URL)).toBe(environment.metaApiBaseUrl);
      expect(TestBed.inject(SUITE4_EMBED_ORIGINS)).toEqual([]);
      expect(TestBed.inject(PROVIDER_AUTHORIZATION_ORIGINS)).toEqual([]);
    } finally {
      TestBed.resetTestingModule();
      if (original === undefined) delete window.__CA_META_PUBLIC_CONFIG__;
      else window.__CA_META_PUBLIC_CONFIG__ = original;
    }
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
