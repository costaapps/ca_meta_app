import { safeReturnUrl } from './safe-return-url';

describe('safeReturnUrl', () => {
  it('keeps only a local supported route and an explicit Instagram auth variant', () => {
    expect(safeReturnUrl('/connections/new/instagram?authVariant=INSTAGRAM_LOGIN')).toBe(
      '/connections/new/instagram?authVariant=INSTAGRAM_LOGIN',
    );
  });

  it('does not carry cUUID, ticket or callback success claims into a post-entry redirect', () => {
    expect(safeReturnUrl('/setup?cUUID=tenant-secret&auth_success=true&ticket=synthetic')).toBe('/connections');
    expect(safeReturnUrl('/connections?cUUID=old-tenant&ticket=synthetic')).toBe('/connections');
  });

  it('rejects external and unsupported return URLs', () => {
    expect(safeReturnUrl('//attacker.invalid/')).toBe('/connections');
    expect(safeReturnUrl('https://attacker.invalid/')).toBe('/connections');
    expect(safeReturnUrl('/oauth/return?onboardingRef=synthetic-reference-123456')).toBe('/connections');
  });
});
