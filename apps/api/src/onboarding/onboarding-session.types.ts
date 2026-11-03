import { createHash } from 'node:crypto';
import type { components } from '@ca-meta/contracts';

export type OnboardingFlowVariant = components['schemas']['FlowVariant'];
export type OnboardingStatusName = components['schemas']['OnboardingStatus']['status'];
export type OnboardingReadiness = components['schemas']['OnboardingStatus']['readiness'];
export type OnboardingStep = components['schemas']['StepStatus'];
export type OnboardingNextAction = components['schemas']['OnboardingStatus']['nextAction'];
export type OnboardingCreateInput = components['schemas']['OnboardingCreateRequest'];
export type OnboardingCreated = components['schemas']['OnboardingCreated'];
export type OnboardingStatus = Omit<components['schemas']['OnboardingStatus'], 'requestId'>;

export interface OnboardingCreateCommand {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly portalSessionId: string;
  readonly tenantContextHash: string;
  readonly createdAt: Date;
  readonly flowVariant: OnboardingFlowVariant;
  readonly requestedCapabilities: readonly string[];
  readonly returnRoute: 'connections' | 'setup';
  readonly idempotencyHash: string;
  readonly requestHash: string;
  readonly providerStateHash: string;
  readonly expiresAt: Date;
}

export interface OnboardingStoredRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly portalSessionId: string;
  readonly tenantContextHash: string;
  readonly flowVariant: OnboardingFlowVariant;
  readonly requestedCapabilities: readonly string[];
  readonly returnRoute: 'connections' | 'setup';
  readonly idempotencyHash: string;
  readonly requestHash: string;
  readonly providerStateHash: string;
  readonly expiresAt: Date;
  readonly status: OnboardingStatusName;
  readonly readiness: OnboardingReadiness;
  readonly steps: readonly OnboardingStep[];
  readonly nextAction: OnboardingNextAction;
  readonly lastUpdatedAt: Date;
  readonly stateConsumed: boolean;
}

export interface OnboardingSessionStore {
  findByIdempotency(tenantId: string, idempotencyHash: string): Promise<OnboardingStoredRecord | undefined>;
  createOrReplay(command: OnboardingCreateCommand): Promise<OnboardingStoredRecord>;
  findForSession(id: string, sessionId: string, principalId: string): Promise<OnboardingStoredRecord | undefined>;
  completeByProviderState(
    providerStateHash: string,
    outcome: OnboardingProviderOutcome,
  ): Promise<boolean>;
}

export const ONBOARDING_SESSION_STORE = Symbol('ONBOARDING_SESSION_STORE');
export const ONBOARDING_PROVIDER_LAUNCH = Symbol('ONBOARDING_PROVIDER_LAUNCH');
export const ONBOARDING_COMPLETION_PORT = Symbol('ONBOARDING_COMPLETION_PORT');

export interface OnboardingProviderLaunchPort {
  /** Build a URL from server-owned allowlisted configuration. This method must not make a provider call. */
  buildAuthorizationUrl(input: {
    readonly flowVariant: OnboardingFlowVariant;
    readonly stateRef: string;
    readonly returnRoute: 'connections' | 'setup';
    readonly expiresAt: string;
  }): Promise<string>;
}

export class OnboardingConfigurationUnavailableError extends Error {
  constructor() {
    super('The onboarding provider configuration is unavailable.');
    this.name = 'OnboardingConfigurationUnavailableError';
  }
}

export class OnboardingConflictError extends Error {
  constructor() {
    super('The onboarding request conflicts with an existing server record.');
    this.name = 'OnboardingConflictError';
  }
}

/** A completed provider result can only be minted by a trusted server adapter. */
declare const providerOutcomeBrand: unique symbol;
const verifiedProviderOutcomes = new WeakSet<object>();

export interface OnboardingProviderOutcome {
  readonly [providerOutcomeBrand]: true;
  readonly stateRef: string;
  readonly status: OnboardingStatusName;
  readonly readiness: OnboardingReadiness;
  readonly steps: readonly OnboardingStep[];
  readonly nextAction: OnboardingNextAction;
}

export function isTrustedOnboardingProviderOutcome(value: unknown): value is OnboardingProviderOutcome {
  return typeof value === 'object' && value !== null && verifiedProviderOutcomes.has(value);
}

/** Subclassed only by a backend adapter after provider correlation and readiness evidence are verified. */
export abstract class TrustedOnboardingCompletionIssuer {
  protected issueVerifiedOutcome(input: Omit<OnboardingProviderOutcome, typeof providerOutcomeBrand>): OnboardingProviderOutcome {
    const safeSteps = Object.freeze(input.steps.map((step) => Object.freeze({
      name: step.name,
      status: step.status,
    })));
    const outcome = Object.freeze({
      stateRef: input.stateRef,
      status: input.status,
      readiness: input.readiness,
      steps: safeSteps,
      nextAction: input.nextAction,
    }) as OnboardingProviderOutcome;
    verifiedProviderOutcomes.add(outcome);
    return outcome;
  }
}

export interface OnboardingCompletionPort {
  complete(outcome: OnboardingProviderOutcome): Promise<boolean>;
}

export function hashOnboardingValue(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
