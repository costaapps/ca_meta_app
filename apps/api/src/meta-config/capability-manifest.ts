export type MetaProductFlow = 'FACEBOOK' | 'INSTAGRAM' | 'WHATSAPP_EXCLUSIVE' | 'WHATSAPP_COEXISTENCE';
export type MetaAuthenticationVariant =
  | 'FACEBOOK_LOGIN_FOR_BUSINESS'
  | 'INSTAGRAM_VIA_FACEBOOK_LOGIN'
  | 'INSTAGRAM_LOGIN'
  | 'WHATSAPP_EMBEDDED_SIGNUP'
  | 'WHATSAPP_BUSINESS_APP_ONBOARDING';
export type MetaOperation =
  | 'ASSET_DISCOVERY'
  | 'SEND_MESSAGE'
  | 'MANAGE_COMMENTS'
  | 'MANAGE_TEMPLATES'
  | 'READ_STATUS'
  | 'SUBSCRIBE_WEBHOOKS'
  | 'SYNC_HISTORY'
  | 'PHONE_REGISTRATION_CONVENTIONAL';

export interface MetaCapabilityManifestEntry {
  readonly flowVariant: MetaProductFlow;
  readonly authVariant: MetaAuthenticationVariant;
  readonly operation: MetaOperation;
  /** Candidate permission names from M1.03; they are not proof of a grant. */
  readonly candidatePermissions: readonly string[];
  readonly permissionMapping: 'EXAMPLE_ONLY' | 'NOT_CONFIRMED';
  readonly requiredAccessLevel: 'STANDARD' | 'ADVANCED' | 'NOT_CONFIRMED';
  readonly appReviewRequirement: 'REQUIRED' | 'NOT_CONFIRMED';
  readonly sandboxStatus: 'NOT_TESTED';
  readonly approvalOwner: 'UNASSIGNED';
  readonly evidenceSources: readonly string[];
}

/** Increment this value whenever the versioned operation/permission evidence changes. */
export const META_CAPABILITY_MANIFEST_VERSION = 'm4.04-2026-11-10.1';

const WHATSAPP_CLOUD_DOC = 'https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api';
const WHATSAPP_SIGNUP_DOC = 'https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup';
const INSTAGRAM_DOC = 'https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api';
const MESSENGER_DOC = 'https://www.postman.com/meta/messenger-platform-api/folder/22794852-255f-4f4d-b3fa-71aec360be9a';
const M1_03_MATRIX = 'docs/meta-v2/meta-capability-matrix.md';

function entry(
  flowVariant: MetaProductFlow,
  authVariant: MetaAuthenticationVariant,
  operation: MetaOperation,
  candidatePermissions: readonly string[],
  permissionMapping: MetaCapabilityManifestEntry['permissionMapping'],
  source: string,
  requiredAccessLevel: MetaCapabilityManifestEntry['requiredAccessLevel'] = 'NOT_CONFIRMED',
): MetaCapabilityManifestEntry {
  return Object.freeze({
    flowVariant,
    authVariant,
    operation,
    candidatePermissions: Object.freeze([...candidatePermissions]),
    permissionMapping,
    requiredAccessLevel,
    appReviewRequirement: requiredAccessLevel === 'ADVANCED' ? 'REQUIRED' : 'NOT_CONFIRMED',
    sandboxStatus: 'NOT_TESTED',
    approvalOwner: 'UNASSIGNED',
    evidenceSources: Object.freeze([source, M1_03_MATRIX]),
  });
}

/**
 * Reviewed candidate matrix. Unknown mappings stay empty and every operation remains blocked
 * until current app-specific access, App Review and Sandbox evidence is recorded.
 */
export const META_CAPABILITY_MANIFEST: readonly MetaCapabilityManifestEntry[] = Object.freeze([
  entry('FACEBOOK', 'FACEBOOK_LOGIN_FOR_BUSINESS', 'ASSET_DISCOVERY', [], 'NOT_CONFIRMED', 'https://developers.facebook.com/docs/facebook-login/facebook-login-for-business/'),
  entry('FACEBOOK', 'FACEBOOK_LOGIN_FOR_BUSINESS', 'SEND_MESSAGE', ['pages_messaging'], 'EXAMPLE_ONLY', MESSENGER_DOC, 'NOT_CONFIRMED'),
  entry('FACEBOOK', 'FACEBOOK_LOGIN_FOR_BUSINESS', 'MANAGE_COMMENTS', [], 'NOT_CONFIRMED', 'https://developers.facebook.com/docs/graph-api/webhooks/'),
  entry('FACEBOOK', 'FACEBOOK_LOGIN_FOR_BUSINESS', 'READ_STATUS', [], 'NOT_CONFIRMED', 'https://developers.facebook.com/docs/graph-api/'),
  entry('FACEBOOK', 'FACEBOOK_LOGIN_FOR_BUSINESS', 'SUBSCRIBE_WEBHOOKS', [], 'NOT_CONFIRMED', 'https://developers.facebook.com/docs/graph-api/webhooks/'),

  entry('INSTAGRAM', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', 'ASSET_DISCOVERY', ['pages_show_list', 'instagram_basic', 'pages_read_engagement'], 'EXAMPLE_ONLY', INSTAGRAM_DOC),
  entry('INSTAGRAM', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', 'SEND_MESSAGE', [], 'NOT_CONFIRMED', INSTAGRAM_DOC),
  entry('INSTAGRAM', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', 'MANAGE_COMMENTS', ['instagram_manage_comments'], 'EXAMPLE_ONLY', INSTAGRAM_DOC),
  entry('INSTAGRAM', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', 'READ_STATUS', [], 'NOT_CONFIRMED', INSTAGRAM_DOC),
  entry('INSTAGRAM', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', 'SUBSCRIBE_WEBHOOKS', [], 'NOT_CONFIRMED', 'https://developers.facebook.com/docs/graph-api/webhooks/'),

  entry('INSTAGRAM', 'INSTAGRAM_LOGIN', 'ASSET_DISCOVERY', ['instagram_business_basic'], 'EXAMPLE_ONLY', INSTAGRAM_DOC),
  entry('INSTAGRAM', 'INSTAGRAM_LOGIN', 'SEND_MESSAGE', ['instagram_business_manage_messages'], 'EXAMPLE_ONLY', INSTAGRAM_DOC),
  entry('INSTAGRAM', 'INSTAGRAM_LOGIN', 'MANAGE_COMMENTS', ['instagram_business_manage_comments'], 'EXAMPLE_ONLY', INSTAGRAM_DOC),
  entry('INSTAGRAM', 'INSTAGRAM_LOGIN', 'READ_STATUS', [], 'NOT_CONFIRMED', INSTAGRAM_DOC),
  entry('INSTAGRAM', 'INSTAGRAM_LOGIN', 'SUBSCRIBE_WEBHOOKS', [], 'NOT_CONFIRMED', 'https://developers.facebook.com/docs/graph-api/webhooks/'),

  entry('WHATSAPP_EXCLUSIVE', 'WHATSAPP_EMBEDDED_SIGNUP', 'ASSET_DISCOVERY', ['whatsapp_business_management'], 'EXAMPLE_ONLY', WHATSAPP_CLOUD_DOC),
  entry('WHATSAPP_EXCLUSIVE', 'WHATSAPP_EMBEDDED_SIGNUP', 'SEND_MESSAGE', ['whatsapp_business_messaging'], 'EXAMPLE_ONLY', WHATSAPP_CLOUD_DOC),
  entry('WHATSAPP_EXCLUSIVE', 'WHATSAPP_EMBEDDED_SIGNUP', 'MANAGE_TEMPLATES', ['whatsapp_business_management'], 'EXAMPLE_ONLY', WHATSAPP_CLOUD_DOC),
  entry('WHATSAPP_EXCLUSIVE', 'WHATSAPP_EMBEDDED_SIGNUP', 'READ_STATUS', [], 'NOT_CONFIRMED', WHATSAPP_CLOUD_DOC),
  entry('WHATSAPP_EXCLUSIVE', 'WHATSAPP_EMBEDDED_SIGNUP', 'SUBSCRIBE_WEBHOOKS', ['whatsapp_business_management'], 'EXAMPLE_ONLY', WHATSAPP_CLOUD_DOC),
  entry('WHATSAPP_EXCLUSIVE', 'WHATSAPP_EMBEDDED_SIGNUP', 'PHONE_REGISTRATION_CONVENTIONAL', ['whatsapp_business_messaging'], 'EXAMPLE_ONLY', WHATSAPP_CLOUD_DOC),

  entry('WHATSAPP_COEXISTENCE', 'WHATSAPP_BUSINESS_APP_ONBOARDING', 'ASSET_DISCOVERY', ['business_management', 'whatsapp_business_management'], 'EXAMPLE_ONLY', WHATSAPP_SIGNUP_DOC, 'ADVANCED'),
  entry('WHATSAPP_COEXISTENCE', 'WHATSAPP_BUSINESS_APP_ONBOARDING', 'SEND_MESSAGE', ['whatsapp_business_messaging'], 'EXAMPLE_ONLY', WHATSAPP_CLOUD_DOC, 'ADVANCED'),
  entry('WHATSAPP_COEXISTENCE', 'WHATSAPP_BUSINESS_APP_ONBOARDING', 'READ_STATUS', [], 'NOT_CONFIRMED', 'https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users'),
  entry('WHATSAPP_COEXISTENCE', 'WHATSAPP_BUSINESS_APP_ONBOARDING', 'SUBSCRIBE_WEBHOOKS', ['whatsapp_business_management'], 'EXAMPLE_ONLY', WHATSAPP_SIGNUP_DOC, 'ADVANCED'),
  entry('WHATSAPP_COEXISTENCE', 'WHATSAPP_BUSINESS_APP_ONBOARDING', 'SYNC_HISTORY', [], 'NOT_CONFIRMED', 'https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users'),
]);

export function capabilityManifestFor(
  flowVariant: MetaProductFlow,
  authVariant: MetaAuthenticationVariant,
): readonly MetaCapabilityManifestEntry[] {
  return META_CAPABILITY_MANIFEST.filter((item) => item.flowVariant === flowVariant && item.authVariant === authVariant);
}
