const unavailableCapabilities = (operations: readonly string[]) => operations.map((operation) => ({
  operation,
  enabled: false,
  reasonCode: 'CONFIGURATION_MISSING',
}));

const availableCapabilities = (operations: readonly string[]) => operations.map((operation) => ({
  operation,
  enabled: true,
  reasonCode: null,
}));

const facebookOperations = ['ASSET_DISCOVERY', 'SEND_MESSAGE', 'MANAGE_COMMENTS', 'READ_STATUS', 'SUBSCRIBE_WEBHOOKS'];
const whatsappExclusiveOperations = [
  'ASSET_DISCOVERY', 'SEND_MESSAGE', 'MANAGE_TEMPLATES', 'READ_STATUS', 'SUBSCRIBE_WEBHOOKS',
  'PHONE_REGISTRATION_CONVENTIONAL',
];
const whatsappCoexistenceOperations = ['ASSET_DISCOVERY', 'SEND_MESSAGE', 'READ_STATUS', 'SUBSCRIBE_WEBHOOKS', 'SYNC_HISTORY'];

/** Sanitized M4.04 OpenAPI DTO shape; public app identifiers are deliberately synthetic. */
export const enabledMetaBootstrapFixture = {
  requestId: 'req-m4-bootstrap-example-01',
  manifestVersion: 'm4.04-2026-11-10.1',
  profiles: [
    {
      flowVariant: 'FACEBOOK',
      authVariant: 'FACEBOOK_LOGIN_FOR_BUSINESS',
      enabled: false,
      reasonCode: 'CONFIGURATION_MISSING',
      capabilities: unavailableCapabilities(facebookOperations),
    },
    {
      flowVariant: 'INSTAGRAM',
      authVariant: 'INSTAGRAM_VIA_FACEBOOK_LOGIN',
      enabled: false,
      reasonCode: 'CONFIGURATION_MISSING',
      capabilities: unavailableCapabilities(facebookOperations),
    },
    {
      flowVariant: 'INSTAGRAM',
      authVariant: 'INSTAGRAM_LOGIN',
      enabled: false,
      reasonCode: 'CONFIGURATION_MISSING',
      capabilities: unavailableCapabilities(facebookOperations),
    },
    {
      flowVariant: 'WHATSAPP_EXCLUSIVE',
      authVariant: 'WHATSAPP_EMBEDDED_SIGNUP',
      enabled: true,
      reasonCode: null,
      providerAppId: '123456789012345',
      publicConfigId: 'synthetic-public-config-01',
      appDomain: 'meta.example.invalid',
      javascriptSdkVersion: 'v27.0',
      embeddedSignupVersion: 'v27.0',
      capabilities: availableCapabilities(whatsappExclusiveOperations),
    },
    {
      flowVariant: 'WHATSAPP_COEXISTENCE',
      authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING',
      enabled: false,
      reasonCode: 'CONFIGURATION_MISSING',
      capabilities: unavailableCapabilities(whatsappCoexistenceOperations),
    },
  ],
} as const;
