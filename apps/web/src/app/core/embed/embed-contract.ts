export const EMBED_PROTOCOL_VERSION = 1 as const;
export const EMBED_HANDSHAKE_TTL_MS = 60_000;

export type EmbedRoute = 'setup' | 'channels' | 'templates' | 'top-level';
export type EmbedTheme = 'light' | 'dark' | 'system';

export interface EmbedCorrelation {
  readonly version: typeof EMBED_PROTOCOL_VERSION;
  readonly nonce: string;
  readonly correlationId: string;
  readonly requestId: string;
}

export interface EmbedReadyMessage extends EmbedCorrelation {
  readonly type: 'EMBED_READY';
}

export interface EmbedBootstrapMessage extends EmbedCorrelation {
  readonly type: 'EMBED_BOOTSTRAP';
  /** Short server-signed portal-entry ticket; never a provider credential. */
  readonly ticket: string;
}

export interface EmbedAckMessage extends EmbedCorrelation {
  readonly type: 'EMBED_ACK';
  readonly status: 'ready' | 'top_level_required' | 'rejected';
}

export interface EmbedNavigationRequest extends EmbedCorrelation {
  readonly type: 'NAVIGATION_REQUEST';
  readonly route: EmbedRoute;
}

export interface EmbedResizeMessage extends EmbedCorrelation {
  readonly type: 'RESIZE';
  readonly height: number;
}

export interface EmbedThemeMessage extends EmbedCorrelation {
  readonly type: 'THEME_UPDATE';
  readonly theme: EmbedTheme;
}

export interface OAuthReturnSignal {
  readonly type: 'OAUTH_RETURN_SIGNAL';
  /** Opaque onboarding reference only. Provider code/state and success claims are forbidden. */
  readonly onboardingRef: string;
}

export type ParentEmbedMessage = EmbedBootstrapMessage | EmbedNavigationRequest | EmbedThemeMessage;

export interface MessageEventEnvelope {
  readonly origin: string;
  readonly source: unknown;
  readonly data: unknown;
}

export interface ParentMessageExpectation {
  readonly parentWindow: unknown;
  readonly allowedOrigins: readonly string[];
  readonly correlation: EmbedCorrelation;
}

const OPAQUE_ID = /^[A-Za-z0-9_-]{16,128}$/;
const TICKET = /^[A-Za-z0-9_.-]{16,8192}$/;
const ROUTES = new Set<EmbedRoute>(['setup', 'channels', 'templates', 'top-level']);
const THEMES = new Set<EmbedTheme>(['light', 'dark', 'system']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function isCorrelation(value: Record<string, unknown>): boolean {
  return value['version'] === EMBED_PROTOCOL_VERSION &&
    typeof value['nonce'] === 'string' && OPAQUE_ID.test(value['nonce']) &&
    typeof value['correlationId'] === 'string' && OPAQUE_ID.test(value['correlationId']) &&
    typeof value['requestId'] === 'string' && OPAQUE_ID.test(value['requestId']);
}

export function isOpaqueOnboardingRef(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

export function parseParentEmbedMessage(
  value: unknown,
  expected: EmbedCorrelation,
): ParentEmbedMessage | undefined {
  if (!isRecord(value) || !isCorrelation(value) || value['nonce'] !== expected.nonce ||
      value['correlationId'] !== expected.correlationId || value['requestId'] !== expected.requestId) return undefined;
  const type = value['type'];
  if (type === 'EMBED_BOOTSTRAP' && exactKeys(value, ['version', 'type', 'nonce', 'correlationId', 'requestId', 'ticket']) &&
      typeof value['ticket'] === 'string' && TICKET.test(value['ticket'])) {
    return value as unknown as EmbedBootstrapMessage;
  }
  if (type === 'NAVIGATION_REQUEST' && exactKeys(value, ['version', 'type', 'nonce', 'correlationId', 'requestId', 'route']) &&
      typeof value['route'] === 'string' && ROUTES.has(value['route'] as EmbedRoute)) {
    return value as unknown as EmbedNavigationRequest;
  }
  if (type === 'THEME_UPDATE' && exactKeys(value, ['version', 'type', 'nonce', 'correlationId', 'requestId', 'theme']) &&
      typeof value['theme'] === 'string' && THEMES.has(value['theme'] as EmbedTheme)) {
    return value as unknown as EmbedThemeMessage;
  }
  return undefined;
}

export function validateParentMessageEvent(
  event: MessageEventEnvelope,
  expected: ParentMessageExpectation,
): ParentEmbedMessage | undefined {
  if (event.source !== expected.parentWindow || !expected.allowedOrigins.includes(event.origin)) return undefined;
  return parseParentEmbedMessage(event.data, expected.correlation);
}

export function parseOAuthReturnSignal(value: unknown): OAuthReturnSignal | undefined {
  if (!isRecord(value) || !exactKeys(value, ['type', 'onboardingRef']) || value['type'] !== 'OAUTH_RETURN_SIGNAL' ||
      !isOpaqueOnboardingRef(value['onboardingRef'])) return undefined;
  return value as unknown as OAuthReturnSignal;
}

export function oauthReturnSignalFromSearch(search: string): OAuthReturnSignal | undefined {
  const params = new URLSearchParams(search);
  const onboardingRef = params.get('onboardingRef');
  if (!isOpaqueOnboardingRef(onboardingRef)) return undefined;
  return Object.freeze({ type: 'OAUTH_RETURN_SIGNAL', onboardingRef });
}

export function validateOAuthReturnEvent(
  event: MessageEventEnvelope,
  expected: { readonly popupWindow: unknown; readonly portalOrigin: string; readonly onboardingRef: string },
): OAuthReturnSignal | undefined {
  if (event.source !== expected.popupWindow || event.origin !== expected.portalOrigin) return undefined;
  const message = parseOAuthReturnSignal(event.data);
  return message?.onboardingRef === expected.onboardingRef ? message : undefined;
}

export function isAuthoritativeReadyStatus(value: unknown, expectedOnboardingRef: string): boolean {
  if (!isRecord(value) || !exactKeys(value, ['id', 'flowVariant', 'status', 'readiness', 'steps', 'nextAction', 'lastUpdatedAt', 'requestId']) ||
      value['id'] !== expectedOnboardingRef || value['status'] !== 'READY' || value['readiness'] !== 'READY' ||
      !['FACEBOOK_LOGIN', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN', 'WHATSAPP_CLOUD_API', 'WHATSAPP_COEXISTENCE'].includes(String(value['flowVariant'])) ||
      !Array.isArray(value['steps']) || value['steps'].length > 32 ||
      !['WAIT', 'CHECK_STATUS', 'REAUTHORIZE', 'RECONCILE', 'RESOLVE_CONFLICT', 'NONE'].includes(String(value['nextAction'])) ||
      typeof value['lastUpdatedAt'] !== 'string' || Number.isNaN(Date.parse(value['lastUpdatedAt'])) ||
      typeof value['requestId'] !== 'string' || value['requestId'].length < 1 || value['requestId'].length > 128) return false;
  return value['steps'].every((step) => isRecord(step) && exactKeys(step, ['name', 'status']) &&
    typeof step['name'] === 'string' && step['name'].length >= 1 && step['name'].length <= 64 &&
    ['PENDING', 'RUNNING', 'SUCCEEDED', 'RETRY_PENDING', 'FAILED', 'UNKNOWN', 'SKIPPED'].includes(String(step['status'])));
}

export function embedRoutePath(route: EmbedRoute): string {
  switch (route) {
    case 'setup': return '/setup';
    case 'channels': return '/channels';
    case 'templates': return '/templates';
    case 'top-level': return '/setup';
  }
}
