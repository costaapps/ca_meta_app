import { MetaFlowCatalogService, parseMetaFlowCatalog } from './meta-flow-catalog.service';

function bootstrap(profiles: readonly Record<string, unknown>[]) {
  return {
    requestId: 'req-synthetic-01',
    manifestVersion: 'synthetic-v1',
    profiles,
  };
}

function profile(flowVariant: string, authVariant: string, enabled = false) {
  return {
    flowVariant,
    authVariant,
    enabled,
    reasonCode: enabled ? null : 'CONFIGURATION_MISSING',
    capabilities: [{ operation: 'ASSET_DISCOVERY', enabled, reasonCode: enabled ? null : 'CONFIGURATION_MISSING' }],
  };
}

describe('MetaFlowCatalogService', () => {
  const service = new MetaFlowCatalogService({} as never, '/api');

  it('renders four distinct product journeys from server profiles', () => {
    const catalog = parseMetaFlowCatalog(bootstrap([
      profile('WHATSAPP_EXCLUSIVE', 'WHATSAPP_EMBEDDED_SIGNUP', true),
      profile('WHATSAPP_COEXISTENCE', 'WHATSAPP_BUSINESS_APP_ONBOARDING'),
      profile('INSTAGRAM', 'INSTAGRAM_VIA_FACEBOOK_LOGIN'),
      profile('FACEBOOK', 'FACEBOOK_LOGIN_FOR_BUSINESS'),
    ]));

    expect(catalog).not.toBeNull();
    const cards = service.cards(catalog!);
    expect(cards.map((card) => card.id)).toEqual([
      'WHATSAPP_EXCLUSIVE', 'WHATSAPP_COEXISTENCE', 'INSTAGRAM', 'FACEBOOK',
    ]);
    expect(cards[0].enabled).toBe(true);
    expect(cards.slice(1).every((card) => !card.enabled)).toBe(true);
  });

  it('keeps Instagram auth variants under one product card and requires explicit choice when both are enabled', () => {
    const catalog = parseMetaFlowCatalog(bootstrap([
      profile('INSTAGRAM', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', true),
      profile('INSTAGRAM', 'INSTAGRAM_LOGIN', true),
    ]));

    expect(catalog).not.toBeNull();
    const card = service.cards(catalog!).find((item) => item.id === 'INSTAGRAM');
    expect(card?.profiles).toHaveLength(2);
    expect(card?.enabled).toBe(true);
  });

  it('rejects malformed or non-server catalog data', () => {
    expect(parseMetaFlowCatalog({
      requestId: 'req-synthetic-02',
      manifestVersion: 'synthetic-v1',
      profiles: [{ ...profile('FACEBOOK', 'FACEBOOK_LOGIN_FOR_BUSINESS'), enabled: 'true' }],
    })).toBeNull();
    expect(parseMetaFlowCatalog({
      requestId: 'req-synthetic-03',
      manifestVersion: 'synthetic-v1',
      profiles: [{ ...profile('WHATSAPP_EXCLUSIVE', 'WHATSAPP_EMBEDDED_SIGNUP'), access_token: 'never-accepted' }],
    })).toBeNull();
  });
});
