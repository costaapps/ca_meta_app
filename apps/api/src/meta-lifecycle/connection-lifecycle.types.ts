import type { components } from '@ca-meta/contracts';
import type { MetaAuthVariant, MetaFlowVariant } from '../credentials/credential-resolver.types.js';

export type ReauthorizationFlow = components['schemas']['FlowVariant'];
export type LifecycleCleanupState = 'BLOCKED' | 'PENDING' | 'FAILED' | 'UNKNOWN' | 'CONFIRMED';

export interface ConnectionLifecycleBinding {
  readonly tenantId: string;
  readonly authorizationId: string;
  readonly appConfigurationId: string;
  readonly environment: string;
  readonly providerAuthorizationId: string | null;
  readonly flowVariant: MetaFlowVariant | null;
  readonly authVariant: MetaAuthVariant | null;
  readonly authorizationState: 'ACTIVE' | 'PARTIAL' | 'REAUTH_REQUIRED' | 'UNKNOWN' | 'REVOKED' | 'DISCONNECTED';
  readonly authorizationVersion: number;
  readonly assetBindings: number;
}

export interface ConnectionLifecycleDisconnectResult {
  readonly commandRef: string;
  readonly localState: 'DISCONNECTED';
  /** No provider action is claimed. A future authorized adapter must reconcile this state. */
  readonly cleanupState: LifecycleCleanupState;
  readonly safeReasonCode: 'PROVIDER_OFFBOARDING_NOT_CONFIRMED' | 'EXTERNAL_CLEANUP_PENDING' | 'EXTERNAL_CLEANUP_FAILED';
}

export interface ConnectionLifecycleCommandRepository {
  findBinding(input: { readonly tenantId: string; readonly authorizationId: string }): Promise<ConnectionLifecycleBinding | undefined>;
  disconnect(input: {
    readonly tenantId: string;
    readonly actorRef: string;
    readonly authorizationId: string;
    readonly assetId: string | null;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<ConnectionLifecycleDisconnectResult>;
  associateReauthorization(input: {
    readonly tenantId: string;
    readonly actorRef: string;
    readonly authorizationId: string;
    readonly onboardingSessionId: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<void>;
}

export interface VerifiedMetaLifecycleCallback {
  /** SHA-256 of the provider's stable event identity, or of the exact raw body if no identity exists. */
  readonly eventRefHash: string;
  /** One-way digest of a provider subject; raw provider identifiers never leave the verifier. */
  readonly subjectRefHash: string;
  readonly appConfigurationRef: string;
  readonly kind: 'DEAUTHORIZATION' | 'DATA_DELETION';
  readonly verifiedAt: string;
}

declare const verifiedCallbackBrand: unique symbol;
const verifiedCallbacks = new WeakSet<object>();

export type TrustedMetaLifecycleCallback = VerifiedMetaLifecycleCallback & { readonly [verifiedCallbackBrand]: true };

/** Only an app-configuration-specific verifier may mint a callback accepted by the processor. */
export function issueTrustedMetaLifecycleCallback(input: VerifiedMetaLifecycleCallback): TrustedMetaLifecycleCallback {
  if (!/^[a-f0-9]{64}$/.test(input.eventRefHash) || !/^[a-f0-9]{64}$/.test(input.subjectRefHash) ||
      !/^[A-Za-z0-9._-]{1,96}$/.test(input.appConfigurationRef) ||
      !['DEAUTHORIZATION', 'DATA_DELETION'].includes(input.kind) || !validUtc(input.verifiedAt)) {
    throw new Error('Lifecycle callback evidence is invalid.');
  }
  const callback = Object.freeze({ ...input }) as TrustedMetaLifecycleCallback;
  verifiedCallbacks.add(callback);
  return callback;
}

export function isTrustedMetaLifecycleCallback(value: unknown): value is TrustedMetaLifecycleCallback {
  return typeof value === 'object' && value !== null && verifiedCallbacks.has(value);
}

export interface MetaLifecycleCallbackVerifier {
  /** Return undefined for invalid/unverifiable input; throw only when verification infrastructure is unavailable. */
  verify(input: { readonly appConfigurationRef: string; readonly rawBody: Buffer }): Promise<TrustedMetaLifecycleCallback | undefined>;
}

export interface MetaLifecycleCallbackProcessor {
  process(callback: TrustedMetaLifecycleCallback): Promise<'APPLIED' | 'DUPLICATE' | 'UNMAPPED'>;
}

/** Stable provider event identities cannot be reused for a different callback payload. */
export class MetaLifecycleCallbackReplayConflictError extends Error {
  constructor() {
    super('Lifecycle callback event identity was reused with a different payload.');
    this.name = 'MetaLifecycleCallbackReplayConflictError';
  }
}

export interface MetaLifecycleCallbackTarget {
  readonly appConfigurationRef: string;
  readonly tenantId: string;
  readonly authorizationId: string;
  readonly appConfigurationId: string;
  readonly environment: string;
}

/** Maps a verified provider subject through server-owned records; browser/body tenant IDs are never used. */
export interface MetaLifecycleCallbackTargetResolver {
  resolve(callback: TrustedMetaLifecycleCallback): Promise<MetaLifecycleCallbackTarget | undefined>;
}

export const CONNECTION_LIFECYCLE_REPOSITORY = Symbol('CONNECTION_LIFECYCLE_REPOSITORY');
export const META_LIFECYCLE_CALLBACK_VERIFIER = Symbol('META_LIFECYCLE_CALLBACK_VERIFIER');
export const META_LIFECYCLE_CALLBACK_PROCESSOR = Symbol('META_LIFECYCLE_CALLBACK_PROCESSOR');
export const META_LIFECYCLE_CALLBACK_TARGET_RESOLVER = Symbol('META_LIFECYCLE_CALLBACK_TARGET_RESOLVER');

export function reauthorizationFlow(
  flow: MetaFlowVariant | null,
  auth: MetaAuthVariant | null,
): ReauthorizationFlow | undefined {
  if (flow === 'FACEBOOK' && auth === 'FACEBOOK_LOGIN_FOR_BUSINESS') return 'FACEBOOK_LOGIN';
  if (flow === 'INSTAGRAM' && auth === 'INSTAGRAM_VIA_FACEBOOK_LOGIN') return 'INSTAGRAM_VIA_FACEBOOK_LOGIN';
  if (flow === 'INSTAGRAM' && auth === 'INSTAGRAM_LOGIN') return 'INSTAGRAM_LOGIN';
  if (flow === 'WHATSAPP_EXCLUSIVE' && auth === 'WHATSAPP_EMBEDDED_SIGNUP') return 'WHATSAPP_CLOUD_API';
  if (flow === 'WHATSAPP_COEXISTENCE' && auth === 'WHATSAPP_BUSINESS_APP_ONBOARDING') return 'WHATSAPP_COEXISTENCE';
  return undefined;
}

function validUtc(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}
