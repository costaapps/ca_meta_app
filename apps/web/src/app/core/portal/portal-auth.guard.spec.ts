import { safeReturnUrl } from './safe-return-url';

describe('safeReturnUrl', () => {
  it('keeps only a local supported route and an explicit Instagram auth variant', () => {
    expect(safeReturnUrl('/connections/new/instagram?authVariant=INSTAGRAM_LOGIN')).toBe(
      '/connections/new/instagram?authVariant=INSTAGRAM_LOGIN',
    );
  });

  it('allows one constrained connection detail segment and rejects nested or invalid IDs', () => {
    expect(safeReturnUrl('/connections/asset_123-abc')).toBe('/connections/asset_123-abc');
    expect(safeReturnUrl(`/connections/${'a'.repeat(128)}`)).toBe(`/connections/${'a'.repeat(128)}`);
    expect(safeReturnUrl('/connections/asset_123/child')).toBe('/connections');
    expect(safeReturnUrl(`/connections/${'a'.repeat(129)}`)).toBe('/connections');
    expect(safeReturnUrl('/connections/asset.123')).toBe('/connections');
  });

  it('preserves the exact status route while rejecting nested paths and unsafe query parameters', () => {
    expect(safeReturnUrl('/status')).toBe('/status');
    expect(safeReturnUrl('/status/extra')).toBe('/connections');
    expect(safeReturnUrl('/status?cUUID=tenant-secret&state=synthetic-state')).toBe('/status');
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

  it('drops opaque state parameters from return navigation', () => {
    expect(safeReturnUrl('/connections?filter=active&state=synthetic-state')).toBe('/connections?filter=active');
  });
});
