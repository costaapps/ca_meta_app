import { describe, expect, it } from 'vitest';
import {
  embedRoutePath,
  isAuthoritativeReadyStatus,
  oauthReturnSignalFromSearch,
  parseOAuthReturnSignal,
  validateOAuthReturnEvent,
  validateParentMessageEvent,
  type EmbedCorrelation,
} from './embed-contract';

const parentWindow = {};
const popupWindow = {};
const correlation: EmbedCorrelation = {
  version: 1,
  nonce: 'nonce-123456789012345678901234',
  correlationId: 'corr-123456789012345678901234',
  requestId: 'req-123456789012345678901234',
};
const bootstrap = {
  type: 'EMBED_BOOTSTRAP',
  ...correlation,
  ticket: 'synthetic.short-lived-ticket-value',
};

describe('Suite4 embed protocol', () => {
  it('accepts only the matching parent source, exact origin, nonce and correlations', () => {
    const event = { source: parentWindow, origin: 'https://suite4.synthetic.invalid', data: bootstrap };
    expect(validateParentMessageEvent(event, {
      parentWindow,
      allowedOrigins: ['https://suite4.synthetic.invalid'],
      correlation,
    })).toMatchObject({ type: 'EMBED_BOOTSTRAP', ticket: bootstrap.ticket });
    expect(validateParentMessageEvent({ ...event, source: {} }, {
      parentWindow,
      allowedOrigins: ['https://suite4.synthetic.invalid'],
      correlation,
    })).toBeUndefined();
    expect(validateParentMessageEvent({ ...event, origin: 'https://evil.synthetic.invalid' }, {
      parentWindow,
      allowedOrigins: ['https://suite4.synthetic.invalid'],
      correlation,
    })).toBeUndefined();
    expect(validateParentMessageEvent({ ...event, data: { ...bootstrap, nonce: 'stale-nonce-12345678901234567890' } }, {
      parentWindow,
      allowedOrigins: ['https://suite4.synthetic.invalid'],
      correlation,
    })).toBeUndefined();
    expect(validateParentMessageEvent({ ...event, data: { ...bootstrap, correlationId: 'other-correlation-123456789' } }, {
      parentWindow,
      allowedOrigins: ['https://suite4.synthetic.invalid'],
      correlation,
    })).toBeUndefined();
  });

  it('rejects tenant, URL and extra fields and maps navigation identifiers to fixed local routes', () => {
    for (const data of [
      { ...bootstrap, tenantRef: 'tenant-a' },
      { ...bootstrap, returnUrl: 'https://evil.synthetic.invalid' },
      { ...bootstrap, nonce: 'short' },
    ]) {
      expect(validateParentMessageEvent({ source: parentWindow, origin: 'https://suite4.synthetic.invalid', data }, {
        parentWindow,
        allowedOrigins: ['https://suite4.synthetic.invalid'],
        correlation,
      })).toBeUndefined();
    }
    expect(embedRoutePath('channels')).toBe('/channels');
    expect(embedRoutePath('top-level')).toBe('/setup');
  });

  it('accepts only an opaque popup return ID from the exact popup and origin', () => {
    const signal = { type: 'OAUTH_RETURN_SIGNAL', onboardingRef: 'onboarding-opaque-reference-123' };
    const expected = { popupWindow, portalOrigin: 'https://portal.synthetic.invalid', onboardingRef: signal.onboardingRef };
    expect(validateOAuthReturnEvent({ source: popupWindow, origin: expected.portalOrigin, data: signal }, expected)).toEqual(signal);
    expect(validateOAuthReturnEvent({ source: {}, origin: expected.portalOrigin, data: signal }, expected)).toBeUndefined();
    expect(validateOAuthReturnEvent({ source: popupWindow, origin: 'https://evil.synthetic.invalid', data: signal }, expected)).toBeUndefined();
    expect(parseOAuthReturnSignal({ ...signal, auth_success: true })).toBeUndefined();
    expect(parseOAuthReturnSignal({ ...signal, status: 'FINISH' })).toBeUndefined();
    expect(parseOAuthReturnSignal({ type: 'OAUTH_RETURN_SIGNAL', onboardingRef: 'short' })).toBeUndefined();
    expect(oauthReturnSignalFromSearch('?onboardingRef=onboarding-opaque-reference-123&code=provider-secret&state=provider-state'))
      .toEqual({ type: 'OAUTH_RETURN_SIGNAL', onboardingRef: 'onboarding-opaque-reference-123' });
    expect(oauthReturnSignalFromSearch('?auth_success=true&status=FINISH')).toBeUndefined();
  });

  it('reports success only for a closed, server-shaped READY response', () => {
    const response = {
      id: 'onboarding-opaque-reference-123',
      flowVariant: 'WHATSAPP_CLOUD_API',
      status: 'READY',
      readiness: 'READY',
      steps: [{ name: 'authorization', status: 'SUCCEEDED' }],
      nextAction: 'NONE',
      lastUpdatedAt: '2026-10-30T12:00:00Z',
      requestId: 'server-request-1234567890',
    };
    expect(isAuthoritativeReadyStatus(response, response.id)).toBe(true);
    expect(isAuthoritativeReadyStatus({ ...response, auth_success: true }, response.id)).toBe(false);
    expect(isAuthoritativeReadyStatus({ ...response, status: 'AWAITING_PROVIDER', readiness: 'UNKNOWN' }, response.id)).toBe(false);
  });
});
