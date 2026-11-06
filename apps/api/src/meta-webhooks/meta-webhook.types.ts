import type { RuntimeEnvironment } from '../config/environment.js';

export interface MetaWebhookApplication {
  readonly providerAppId: string;
  readonly environment: RuntimeEnvironment;
  readonly appSecretRef: string;
  readonly providerAppIdRef: string;
}

export interface MetaWebhookSecretProvider {
  /** Returns the independent GET challenge token; it must never be derived from the App Secret. */
  verificationToken(input: {
    readonly providerAppId: string;
    readonly providerAppIdRef: string;
    readonly environment: RuntimeEnvironment;
  }): Promise<string | undefined>;
  /** Current and still-valid previous App Secret versions, in bounded rotation order. */
  appSecretVersions(reference: string): Promise<readonly Buffer[]>;
}

export interface ProtectedMetaWebhookPayload {
  readonly reference: string;
  /** Opaque, non-secret key version/reference used by the protected store. */
  readonly keyReference: string;
  readonly nonce: Buffer;
  readonly authenticationTag: Buffer;
  readonly ciphertext: Buffer;
  readonly expiresAt: string;
}

export interface MetaWebhookPayloadProtector {
  /** Must provide authenticated encryption and a retention-policy expiry; unprotect must enforce that expiry. */
  protect(input: {
    readonly reference: string;
    readonly providerAppId: string;
    readonly environment: RuntimeEnvironment;
    readonly rawBody: Buffer;
  }): Promise<ProtectedMetaWebhookPayload>;
  unprotect(payload: ProtectedMetaWebhookPayload): Promise<Buffer>;
}

export interface MetaWebhookResourceRoute {
  readonly tenantId: string;
  readonly appConfigurationId: string;
  readonly assetId: string;
}

export type MetaWebhookProcessResult =
  | { readonly kind: 'SUCCEEDED' }
  | { readonly kind: 'RETRYABLE_FAILURE'; readonly safeErrorCode: string }
  | { readonly kind: 'PERMANENT_FAILURE'; readonly safeErrorCode: string };

export interface MetaWebhookStatusFence {
  readonly leaseVersion: number;
  readonly eventKey: string;
  readonly providerTimestamp: string;
}

/** Must treat eventRef as an idempotency key. This port is local-only; no Meta API calls belong here. */
/** For `statuses`, require statusFence and atomically reject a stale lease or provider timestamp before changing delivery state. */
export interface MetaWebhookItemProcessor {
  process(input: {
    readonly eventRef: string;
    readonly eventKey: string;
    readonly schemaVersion: number;
    readonly tenantId: string;
    readonly appConfigurationId: string;
    readonly assetId: string;
    readonly eventType: string;
    readonly providerTimestamp: string | null;
    readonly providerMessageId: string | null;
    readonly providerStatus: string | null;
    readonly providerStatusRank: number | null;
    readonly statusFence?: MetaWebhookStatusFence;
    readonly item: Readonly<Record<string, unknown>>;
  }, signal?: AbortSignal): Promise<MetaWebhookProcessResult>;
}

export interface MetaWebhookReplayAuthorization {
  assertAuthorized(input: { readonly actorRef: string; readonly caseRef: string }): Promise<void>;
}

export const META_WEBHOOK_SECRET_PROVIDER = Symbol('META_WEBHOOK_SECRET_PROVIDER');
export const META_WEBHOOK_PAYLOAD_PROTECTOR = Symbol('META_WEBHOOK_PAYLOAD_PROTECTOR');
export const META_WEBHOOK_ITEM_PROCESSOR = Symbol('META_WEBHOOK_ITEM_PROCESSOR');
export const META_WEBHOOK_REPLAY_AUTHORIZATION = Symbol('META_WEBHOOK_REPLAY_AUTHORIZATION');
