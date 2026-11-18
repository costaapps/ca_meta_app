import { enabledMetaBootstrapFixture } from './fixtures/meta-flow-bootstrap.enabled.fixture';
import { MetaFlowCatalogService, parseMetaFlowCatalog } from './meta-flow-catalog.service';

describe('MetaFlowCatalogService', () => {
  const service = new MetaFlowCatalogService({} as never, '/api');

  it('accepts the enabled M4.04 bootstrap profile, drops public setup fields, and keeps four product cards', () => {
    const catalog = parseMetaFlowCatalog(enabledMetaBootstrapFixture);

    expect(catalog).not.toBeNull();
    const cards = service.cards(catalog!);
    expect(cards.map((card) => card.id)).toEqual([
      'WHATSAPP_EXCLUSIVE', 'WHATSAPP_COEXISTENCE', 'INSTAGRAM', 'FACEBOOK',
    ]);
    expect(cards).toHaveLength(4);
    expect(cards[0].enabled).toBe(true);
    expect(cards[0].profiles).toHaveLength(1);
    expect(cards[0].profiles[0].capabilities.map((capability) => capability.operation)).toContain('PHONE_REGISTRATION_CONVENTIONAL');
    expect(catalog!.profiles.flatMap((profile) => profile.capabilities)).toHaveLength(26);
    expect(cards.slice(1).every((card) => !card.enabled)).toBe(true);
    expect(JSON.stringify(catalog)).not.toMatch(/providerAppId|publicConfigId|appDomain|javascriptSdkVersion|embeddedSignupVersion/);
  });

  it('keeps both Instagram auth variants under one product card', () => {
    const profiles = enabledMetaBootstrapFixture.profiles.map((candidate) => {
      if (candidate.flowVariant !== 'INSTAGRAM') return candidate;
      return {
        ...candidate,
        enabled: true,
        reasonCode: null,
        capabilities: candidate.capabilities.map((capability) => ({ ...capability, enabled: true, reasonCode: null })),
      };
    });
    const catalog = parseMetaFlowCatalog({ ...enabledMetaBootstrapFixture, profiles });

    expect(catalog).not.toBeNull();
    const card = service.cards(catalog!).find((item) => item.id === 'INSTAGRAM');
    expect(card?.profiles).toHaveLength(2);
    expect(card?.enabled).toBe(true);
  });

  it('maps every M4 bootstrap reason code to safe actionable copy', () => {
    const catalog = parseMetaFlowCatalog(enabledMetaBootstrapFixture);
    expect(catalog).not.toBeNull();
    const profile = catalog!.profiles[0];
    const reasons = [
      'CONFIGURATION_MISSING', 'CONFIGURATION_DISABLED', 'VERSION_EVIDENCE_REQUIRED',
      'PERMISSION_MAPPING_NOT_CONFIRMED', 'CAPABILITY_EVIDENCE_MISSING', 'ACCESS_LEVEL_NOT_CONFIRMED',
      'APP_REVIEW_NOT_CONFIRMED', 'SANDBOX_NOT_CONFIRMED',
    ];
    const copy = reasons.map((reasonCode) => service.reasonFor({ ...profile, reasonCode }));

    expect(copy).toHaveLength(reasons.length);
    expect(copy.every((message) => message.length > 20 && message !== 'Indisponível neste ambiente.')).toBe(true);
  });

  it('validates optional public fields and rejects unknown authority-shaped fields', () => {
    const withEnabledProfile = (changes: Record<string, unknown>) => ({
      ...enabledMetaBootstrapFixture,
      profiles: enabledMetaBootstrapFixture.profiles.map((candidate, index) => index === 3
        ? { ...candidate, ...changes }
        : candidate),
    });

    expect(parseMetaFlowCatalog(withEnabledProfile({ providerAppId: 'not-numeric' }))).toBeNull();
    expect(parseMetaFlowCatalog(withEnabledProfile({ publicConfigId: 'x'.repeat(97) }))).toBeNull();
    expect(parseMetaFlowCatalog(withEnabledProfile({ appDomain: 'x'.repeat(254) }))).toBeNull();
    expect(parseMetaFlowCatalog(withEnabledProfile({ javascriptSdkVersion: '27.0' }))).toBeNull();
    expect(parseMetaFlowCatalog(withEnabledProfile({ embeddedSignupVersion: 'v123.0' }))).toBeNull();
    expect(parseMetaFlowCatalog(withEnabledProfile({ tenantRef: 'synthetic-tenant-ref-01' }))).toBeNull();

    const disabledWithPublicId = {
      ...enabledMetaBootstrapFixture,
      profiles: enabledMetaBootstrapFixture.profiles.map((candidate, index) => index === 0
        ? { ...candidate, providerAppId: '123456789' }
        : candidate),
    };
    expect(parseMetaFlowCatalog(disabledWithPublicId)).toBeNull();
  });

  it('rejects malformed catalog variants, reason codes, capabilities and unknown fields', () => {
    const profiles = enabledMetaBootstrapFixture.profiles.map((candidate, index) => index === 0
      ? { ...candidate, enabled: 'true' }
      : candidate);
    expect(parseMetaFlowCatalog({ ...enabledMetaBootstrapFixture, profiles })).toBeNull();

    const withUnknownCapability = {
      ...enabledMetaBootstrapFixture,
      profiles: enabledMetaBootstrapFixture.profiles.map((candidate, index) => index === 0
        ? { ...candidate, capabilities: [{ operation: 'ASSET_DISCOVERY', enabled: false, reasonCode: 'UNKNOWN_REASON' }] }
        : candidate),
    };
    expect(parseMetaFlowCatalog(withUnknownCapability)).toBeNull();
    expect(parseMetaFlowCatalog({ ...enabledMetaBootstrapFixture, tenantRef: 'synthetic-tenant-ref-01' })).toBeNull();
  });
});
