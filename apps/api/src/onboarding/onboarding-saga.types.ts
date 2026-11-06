import type { OnboardingCodeContext } from './onboarding-code-crypto.js';
import type { OnboardingStep } from './onboarding-session.types.js';

export const META_ONBOARDING_SAGA_ADAPTER = Symbol('META_ONBOARDING_SAGA_ADAPTER');

export interface OnboardingSagaContext extends OnboardingCodeContext {
  readonly principalId: string;
  readonly portalSessionId: string;
  readonly correlationId: string;
  readonly graphApiVersion: string;
  readonly capabilityManifestVersion: string;
}

export interface OnboardingSagaEvidence {
  readonly authorizationRef?: string;
  readonly verifiedAssetRefs?: readonly string[];
  readonly subscriptionRef?: string;
  readonly projectionRef?: string;
}

export interface OnboardingSagaAdapter {
  /** Exchanges this one-use code for the exact flow/config; persist returned credentials through the encrypted vault. */
  exchangeAuthorizationCode(input: OnboardingSagaContext & { readonly code: string; readonly idempotencyKey: string; readonly signal: AbortSignal }): Promise<{ readonly authorizationRef: string }>;
  /** Resolves provider IDs from a server-side catalog and persists verified assets and grants. */
  discoverAndPersistAssets(input: OnboardingSagaContext & { readonly authorizationRef: string; readonly idempotencyKey: string; readonly signal: AbortSignal }): Promise<{ readonly assetRefs: readonly string[] }>;
  /** Applies the exact app/asset subscriptions for this flow; shared targets are coordinated by the subscription adapter. */
  ensureSubscriptions(input: OnboardingSagaContext & { readonly authorizationRef: string; readonly assetRefs: readonly string[]; readonly idempotencyKey: string; readonly signal: AbortSignal }): Promise<{ readonly subscriptionRef: string }>;
  /** Emits the bounded connection projection only after its local source records commit. */
  publishProjection(input: OnboardingSagaContext & { readonly authorizationRef: string; readonly assetRefs: readonly string[]; readonly subscriptionRef: string; readonly idempotencyKey: string; readonly signal: AbortSignal }): Promise<{ readonly projectionRef: string }>;
  /** Reads provider state only; it must never repeat the uncertain mutation or submit an authorization code. */
  reconcileStage?(input: OnboardingSagaContext & {
    readonly stage: 'authorization' | 'asset-verification' | 'subscription' | 'projection';
    readonly evidence: OnboardingSagaEvidence;
    readonly idempotencyKey: string;
    readonly signal: AbortSignal;
  }): Promise<OnboardingSagaReconciliation>;
}

export type OnboardingSagaReconciliation =
  | { readonly disposition: 'APPLIED'; readonly evidence: OnboardingSagaEvidence }
  | { readonly disposition: 'NO_EFFECT' }
  | { readonly disposition: 'UNKNOWN' };

/** Only explicit adapter evidence may authorize another attempt for this stage. */
export class OnboardingSagaEffectError extends Error {
  constructor(readonly disposition: 'NO_EFFECT' | 'UNKNOWN') {
    super('The onboarding provider effect did not complete safely.');
    this.name = 'OnboardingSagaEffectError';
  }
}

export interface OnboardingSagaCheckpoint {
  readonly status: 'PARTIAL' | 'UNKNOWN' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
  readonly readiness: 'PARTIAL' | 'UNKNOWN';
  readonly steps: readonly OnboardingStep[];
  readonly nextAction: 'CHECK_STATUS' | 'REAUTHORIZE' | 'RECONCILE' | 'RESUME' | 'RESOLVE_CONFLICT' | 'NONE';
}
