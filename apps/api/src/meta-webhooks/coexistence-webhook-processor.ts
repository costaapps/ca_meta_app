import type {
  MetaWebhookItemProcessor,
  MetaWebhookItemProcessorInput,
  MetaWebhookProcessResult,
  MetaWebhookStatusFence,
} from './meta-webhook.types.js';

const COEXISTENCE_EVENT_PREFIX = 'meta.webhook.whatsapp_business_account.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_REF = /^[0-9a-f]{64}$/;
const PROVIDER_REF = /^[A-Za-z0-9._:-]{1,512}$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,47}$/;

export type CoexistenceConsentState = 'GRANTED' | 'DECLINED' | 'UNKNOWN';

/** Scope comes from the trusted local asset/authorization catalog, never from webhook fields. */
export interface CoexistenceWebhookScope {
  readonly tenantId: string;
  readonly appConfigurationId: string;
  readonly assetId: string;
  /** The resolver must return only an M4.10-routed WhatsApp phone asset owned by this scope. */
  readonly assetKind: 'WHATSAPP_PHONE_NUMBER';
  readonly phoneOwnershipVerified: boolean;
  readonly authorizationRef: string;
  readonly flowVariant: 'WHATSAPP_COEXISTENCE';
  readonly authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING';
  readonly authorizationActive: boolean;
  readonly historyConsent: CoexistenceConsentState;
  readonly echoConsent: CoexistenceConsentState;
  /** Server-owned expiry supplied by the approved retention policy. No implicit default exists. */
  readonly historyExpiresAt: string | null;
  /** Server-owned expiry for app-originated message content. No implicit default exists. */
  readonly echoExpiresAt: string | null;
}

export interface CoexistenceWebhookScopeResolver {
  resolve(input: {
    readonly tenantId: string;
    readonly appConfigurationId: string;
    readonly assetId: string;
  }): Promise<CoexistenceWebhookScope | undefined>;
}

export type CoexistenceWebhookEvent =
  | {
    readonly kind: 'HISTORY_MESSAGE';
    readonly tenantId: string;
    readonly appConfigurationId: string;
    readonly assetId: string;
    readonly authorizationRef: string;
    readonly eventRef: string;
    readonly providerMessageId: string;
    readonly providerTimestamp: string | null;
    readonly retentionExpiresAt: string;
    readonly suppressAutomation: true;
    readonly item: Readonly<Record<string, unknown>>;
  }
  | {
    readonly kind: 'HISTORY_STATUS';
    readonly tenantId: string;
    readonly appConfigurationId: string;
    readonly assetId: string;
    readonly authorizationRef: string;
    readonly eventRef: string;
    readonly providerMessageId: string;
    readonly providerTimestamp: string;
    readonly providerStatus: string;
    readonly retentionExpiresAt: string;
    readonly statusFence: MetaWebhookStatusFence;
    readonly suppressAutomation: true;
  }
  | {
    readonly kind: 'BUSINESS_APP_ECHO';
    readonly tenantId: string;
    readonly appConfigurationId: string;
    readonly assetId: string;
    readonly authorizationRef: string;
    readonly eventRef: string;
    readonly providerMessageId: string;
    readonly providerTimestamp: string | null;
    readonly retentionExpiresAt: string;
    readonly source: 'BUSINESS_APP';
    readonly suppressAutomation: true;
    readonly item: Readonly<Record<string, unknown>>;
  };

/**
 * The sink must atomically deduplicate content by tenant/app/asset/providerMessageId and eventRef;
 * status transitions use eventRef plus the status fence. It applies expiry and never enqueues an
 * automated reply for history or app echoes. It is not configured here.
 */
export interface CoexistenceWebhookEventSink {
  accept(event: CoexistenceWebhookEvent, signal?: AbortSignal): Promise<MetaWebhookProcessResult>;
}

/**
 * Handles only Coexistence history and app-echo leaves from the signed M4.10 inbox. Other Meta
 * events are delegated unchanged. No provider request or automated message operation is exposed.
 */
export class CoexistenceWebhookItemProcessor implements MetaWebhookItemProcessor {
  constructor(
    private readonly scopes: CoexistenceWebhookScopeResolver,
    private readonly sink: CoexistenceWebhookEventSink,
    private readonly fallback: MetaWebhookItemProcessor,
    private readonly enabled = false,
    private readonly now: () => number = Date.now,
  ) {}

  async process(input: MetaWebhookItemProcessorInput, signal?: AbortSignal): Promise<MetaWebhookProcessResult> {
    if (!input.eventType.startsWith(COEXISTENCE_EVENT_PREFIX)) return await this.fallback.process(input, signal);
    if (!this.enabled) return failure('PERMANENT_FAILURE', 'COEXISTENCE_PROCESSOR_DISABLED');
    const field = coexistenceField(input.eventType);
    if (field === null) return failure('PERMANENT_FAILURE', 'COEXISTENCE_EVENT_TYPE_NOT_SUPPORTED');
    if (signal?.aborted) return failure('RETRYABLE_FAILURE', 'WORKER_STOPPING');
    if (!validEventIdentity(input)) return failure('PERMANENT_FAILURE', 'COEXISTENCE_EVENT_ID_INVALID');

    if (field === 'smb_app_state_sync') {
      // M4.10 deliberately keeps this family tenantless until a phone ownership reference is confirmed.
      return failure('PERMANENT_FAILURE', 'STATE_SYNC_SCHEMA_NOT_CONFIRMED');
    }

    const eventKind = classifyMessageEvent(field, input);
    if (!eventKind) return failure('PERMANENT_FAILURE', 'COEXISTENCE_EVENT_SHAPE_NOT_CONFIRMED');
    if (!validRoute(input)) return failure('PERMANENT_FAILURE', 'COEXISTENCE_ROUTE_INVALID');

    let scope: CoexistenceWebhookScope | undefined;
    try {
      scope = await this.scopes.resolve({ tenantId: input.tenantId, appConfigurationId: input.appConfigurationId,
        assetId: input.assetId });
    } catch {
      return failure('RETRYABLE_FAILURE', 'COEXISTENCE_SCOPE_UNAVAILABLE');
    }
    if (!scope) return failure('RETRYABLE_FAILURE', 'COEXISTENCE_SCOPE_UNAVAILABLE');
    if (!matchesRoute(scope, input) || scope.assetKind !== 'WHATSAPP_PHONE_NUMBER' || !scope.phoneOwnershipVerified ||
        !UUID.test(scope.authorizationRef) || !scope.authorizationActive ||
        scope.flowVariant !== 'WHATSAPP_COEXISTENCE' || scope.authVariant !== 'WHATSAPP_BUSINESS_APP_ONBOARDING') {
      return failure('PERMANENT_FAILURE', 'COEXISTENCE_SCOPE_MISMATCH');
    }

    const retentionExpiresAt = eventKind === 'HISTORY_MESSAGE' || eventKind === 'HISTORY_STATUS'
      ? scope.historyExpiresAt : scope.echoExpiresAt;
    const consent = eventKind === 'HISTORY_MESSAGE' || eventKind === 'HISTORY_STATUS'
      ? scope.historyConsent : scope.echoConsent;
    if (consent !== 'GRANTED') {
      const isHistory = eventKind === 'HISTORY_MESSAGE' || eventKind === 'HISTORY_STATUS';
      if (consent === 'DECLINED') return failure('PERMANENT_FAILURE', isHistory ? 'HISTORY_CONSENT_DECLINED' : 'ECHO_CONSENT_DECLINED');
      return failure('PERMANENT_FAILURE', isHistory ? 'HISTORY_CONSENT_NOT_CONFIRMED' : 'ECHO_CONSENT_NOT_CONFIRMED');
    }
    if (!validExpiry(retentionExpiresAt, this.now())) {
      return failure('PERMANENT_FAILURE', 'MESSAGE_RETENTION_NOT_CONFIGURED');
    }

    const event = toCoexistenceEvent(input, eventKind, scope, retentionExpiresAt, this.now());
    if (!event) return failure('PERMANENT_FAILURE', 'COEXISTENCE_EVENT_SHAPE_NOT_CONFIRMED');
    try {
      return safeResult(await this.sink.accept(event, signal));
    } catch {
      return failure('RETRYABLE_FAILURE', 'COEXISTENCE_STORE_UNAVAILABLE');
    }
  }
}

type SupportedEventKind = CoexistenceWebhookEvent['kind'];
type CoexistenceField = 'history' | 'smb_app_state_sync' | 'smb_message_echoes';

function coexistenceField(eventType: string): CoexistenceField | null {
  if (!eventType.startsWith(COEXISTENCE_EVENT_PREFIX)) return null;
  const field = eventType.slice(COEXISTENCE_EVENT_PREFIX.length).split('.')[0];
  return field === 'history' || field === 'smb_app_state_sync' || field === 'smb_message_echoes' ? field : null;
}

function classifyMessageEvent(field: CoexistenceField, input: MetaWebhookItemProcessorInput): SupportedEventKind | null {
  if (field === 'history' && input.itemKind === 'messages' && input.eventType === `${COEXISTENCE_EVENT_PREFIX}history.messages`) {
    return 'HISTORY_MESSAGE';
  }
  if (field === 'history' && input.itemKind === 'statuses' && input.providerStatus !== null &&
      input.eventType === `${COEXISTENCE_EVENT_PREFIX}history.statuses`) return 'HISTORY_STATUS';
  if (field === 'smb_message_echoes' && input.itemKind === 'messages' &&
      input.eventType === `${COEXISTENCE_EVENT_PREFIX}smb_message_echoes.messages`) return 'BUSINESS_APP_ECHO';
  return null;
}

function validEventIdentity(input: MetaWebhookItemProcessorInput): boolean {
  return input.schemaVersion === 1 && EVENT_REF.test(input.eventRef) && input.eventKey === input.eventRef;
}

function validRoute(input: MetaWebhookItemProcessorInput): boolean {
  return UUID.test(input.tenantId) && UUID.test(input.appConfigurationId) && UUID.test(input.assetId);
}

function matchesRoute(scope: CoexistenceWebhookScope, input: MetaWebhookItemProcessorInput): boolean {
  return scope.tenantId === input.tenantId && scope.appConfigurationId === input.appConfigurationId && scope.assetId === input.assetId &&
    UUID.test(scope.tenantId) && UUID.test(scope.appConfigurationId) && UUID.test(scope.assetId);
}

function validExpiry(value: string | null, now: number): value is string {
  if (value === null) return false;
  const expiry = Date.parse(value);
  return Number.isFinite(expiry) && expiry > now;
}

function toCoexistenceEvent(
  input: MetaWebhookItemProcessorInput,
  kind: SupportedEventKind,
  scope: CoexistenceWebhookScope,
  retentionExpiresAt: string | null,
  now: number,
): CoexistenceWebhookEvent | null {
  if (!input.providerMessageId || !PROVIDER_REF.test(input.providerMessageId)) return null;
  if (kind === 'HISTORY_STATUS') {
    if (!validExpiry(retentionExpiresAt, now) || input.providerTimestamp === null || input.providerStatus === null || input.statusFence === null ||
        !validStatusFence(input.statusFence, input.eventKey, input.providerTimestamp)) return null;
    return {
      kind, tenantId: scope.tenantId, appConfigurationId: scope.appConfigurationId, assetId: scope.assetId,
      authorizationRef: scope.authorizationRef, eventRef: input.eventRef, providerMessageId: input.providerMessageId,
      providerTimestamp: input.providerTimestamp, providerStatus: input.providerStatus, retentionExpiresAt,
      statusFence: input.statusFence,
      suppressAutomation: true,
    };
  }
  if (!validExpiry(retentionExpiresAt, now)) return null;
  const common = {
    tenantId: scope.tenantId, appConfigurationId: scope.appConfigurationId, assetId: scope.assetId,
    authorizationRef: scope.authorizationRef, eventRef: input.eventRef, providerMessageId: input.providerMessageId,
    providerTimestamp: input.providerTimestamp, retentionExpiresAt, suppressAutomation: true as const,
    item: input.item,
  };
  if (kind === 'HISTORY_MESSAGE') return { kind, ...common };
  if (kind === 'BUSINESS_APP_ECHO') return { kind, ...common, source: 'BUSINESS_APP' };
  return null;
}

function validStatusFence(fence: MetaWebhookStatusFence, eventKey: string, timestamp: string): boolean {
  return Number.isSafeInteger(fence.leaseVersion) && fence.leaseVersion > 0 && PROVIDER_REF.test(fence.leaseToken) &&
    fence.eventKey === eventKey && fence.providerTimestamp === timestamp && Number.isFinite(Date.parse(timestamp));
}

function safeResult(result: MetaWebhookProcessResult): MetaWebhookProcessResult {
  if ((result.kind === 'RETRYABLE_FAILURE' || result.kind === 'PERMANENT_FAILURE') && !SAFE_ERROR_CODE.test(result.safeErrorCode)) {
    return failure(result.kind, 'COEXISTENCE_STORE_FAILURE');
  }
  return result;
}

function failure(kind: 'RETRYABLE_FAILURE' | 'PERMANENT_FAILURE', safeErrorCode: string): MetaWebhookProcessResult {
  return { kind, safeErrorCode };
}
