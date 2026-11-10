import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import {
  decodeCoexistenceMessage,
  hasReviewedCoexistenceContract,
  type CoexistenceProviderAdapter,
} from './coexistence-provider-adapter';

const origin = 'https://provider.synthetic.invalid';
const evidence = 'https://docs.synthetic.invalid/reviewed-fixture';

function adapter(contract?: CoexistenceProviderAdapter['contract']): CoexistenceProviderAdapter {
  return {
    ...(contract ? { contract } : {}),
    prepareForUserGesture: () => undefined,
    decodeMessage: (data) => data as never,
  };
}

const reviewedFixture = {
  authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING',
  sdkVersion: 'synthetic-sdk-version',
  embeddedSignupVersion: 'synthetic-signup-version',
  featureType: 'synthetic-feature-type',
  messageOrigin: origin,
  sourceSemantics: 'synthetic source binding documented by fixture only',
  eventSchemaEvidence: evidence,
  originAndSourceEvidence: evidence,
} as const;

describe('Coexistence provider adapter gate', () => {
  it('stays disabled without exact reviewed Coexistence evidence', () => {
    expect(hasReviewedCoexistenceContract(adapter(), [origin])).toBe(false);
    expect(hasReviewedCoexistenceContract(adapter(reviewedFixture), [])).toBe(false);
    expect(hasReviewedCoexistenceContract(adapter({ ...reviewedFixture, featureType: '' }), [origin])).toBe(false);
    expect(hasReviewedCoexistenceContract(adapter({ ...reviewedFixture, authVariant: 'WHATSAPP_EMBEDDED_SIGNUP' as never }), [origin])).toBe(false);
  });

  it('requires the separate Business App onboarding variant and exact allowlisted HTTPS origin', () => {
    expect(hasReviewedCoexistenceContract(adapter(reviewedFixture), [origin])).toBe(true);
    expect(hasReviewedCoexistenceContract(adapter({ ...reviewedFixture, messageOrigin: 'https://provider.synthetic.invalid.evil' }), [origin]))
      .toBe(false);
    expect(hasReviewedCoexistenceContract(adapter({ ...reviewedFixture, messageOrigin: 'https://provider.synthetic.invalid/path' }), [origin]))
      .toBe(false);
    expect(hasReviewedCoexistenceContract(adapter({ ...reviewedFixture, eventSchemaEvidence: 'http://docs.synthetic.invalid/schema' }), [origin]))
      .toBe(false);
  });

  it('accepts only closed normalized events from the adapter and bounds authorization code length', () => {
    const fake = adapter(reviewedFixture);
    expect(decodeCoexistenceMessage(fake, { type: 'finished' })).toEqual({ type: 'finished' });
    expect(decodeCoexistenceMessage(fake, { type: 'cancelled' })).toEqual({ type: 'cancelled' });
    expect(decodeCoexistenceMessage(fake, { type: 'authorization_code', authorizationCode: 'synthetic-code' }))
      .toEqual({ type: 'authorization_code', authorizationCode: 'synthetic-code' });
    expect(decodeCoexistenceMessage(fake, { type: 'finished', auth_success: true })).toBeUndefined();
    expect(decodeCoexistenceMessage(fake, { type: 'authorization_code', authorizationCode: '' })).toBeUndefined();
    expect(decodeCoexistenceMessage(fake, { type: 'authorization_code', authorizationCode: 'x'.repeat(16_385) } as never))
      .toBeUndefined();
    expect(decodeCoexistenceMessage(fake, { tenantId: 'tenant-from-browser', status: 'READY' })).toBeUndefined();
  });
});
