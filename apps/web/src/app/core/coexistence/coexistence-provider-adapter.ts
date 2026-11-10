import { InjectionToken } from '@angular/core';

/**
 * Normalized events emitted only after a reviewed provider-specific decoder has
 * validated the real Embedded Signup message schema. These names are internal
 * application events; they do not describe Meta's wire payload.
 */
export type CoexistenceProviderMessage =
  | { readonly type: 'authorization_code'; readonly authorizationCode: string }
  | { readonly type: 'finished' }
  | { readonly type: 'cancelled' };

export interface CoexistenceProviderContractEvidence {
  readonly authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING';
  readonly sdkVersion: string;
  readonly embeddedSignupVersion: string;
  readonly featureType: string;
  readonly messageOrigin: string;
  readonly sourceSemantics: string;
  readonly eventSchemaEvidence: string;
  readonly originAndSourceEvidence: string;
}

export interface PreparedCoexistenceSignup {
  /** Exact browser message origin documented for this contract. */
  readonly messageOrigin: string;
  /** Exact event.source value for this one provider launch. */
  readonly messageSource: MessageEventSource;
  /** Navigate the context prepared synchronously by the user's click. */
  start(input: { readonly launchUrl: string; readonly onboardingRef: string }): void;
  dispose(): void;
}

export interface CoexistenceProviderAdapter {
  /** Missing contract evidence keeps the flow disabled. */
  readonly contract?: CoexistenceProviderContractEvidence;
  /** Must synchronously prepare a temporary browsing context while user activation is still present. */
  prepareForUserGesture(): PreparedCoexistenceSignup | undefined;
  /** Must reject all data that does not match the reviewed, exact wire schema. */
  decodeMessage(data: unknown): CoexistenceProviderMessage | undefined;
}

/** There is deliberately no production Meta adapter until its exact contract is reviewed. */
export const COEXISTENCE_PROVIDER_ADAPTER = new InjectionToken<CoexistenceProviderAdapter>(
  'COEXISTENCE_PROVIDER_ADAPTER',
  {
    providedIn: 'root',
    factory: () => ({
      prepareForUserGesture: () => undefined,
      decodeMessage: () => undefined,
    }),
  },
);

export function hasReviewedCoexistenceContract(
  adapter: CoexistenceProviderAdapter,
  allowedOrigins: readonly string[],
): boolean {
  const contract = adapter.contract;
  if (!contract || contract.authVariant !== 'WHATSAPP_BUSINESS_APP_ONBOARDING' ||
      !nonEmpty(contract.sdkVersion) || !nonEmpty(contract.embeddedSignupVersion) ||
      !nonEmpty(contract.featureType) || !nonEmpty(contract.sourceSemantics)) return false;
  const messageOrigin = exactHttpsOrigin(contract.messageOrigin);
  return messageOrigin !== undefined && allowedOrigins.includes(messageOrigin) &&
    isHttpsEvidenceUrl(contract.eventSchemaEvidence) && isHttpsEvidenceUrl(contract.originAndSourceEvidence);
}

export function decodeCoexistenceMessage(
  adapter: CoexistenceProviderAdapter,
  data: unknown,
): CoexistenceProviderMessage | undefined {
  let value: unknown;
  try {
    value = adapter.decodeMessage(data);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value['type'] === 'authorization_code' && exactKeys(value, ['type', 'authorizationCode']) &&
      typeof value['authorizationCode'] === 'string' && value['authorizationCode'].length >= 1 &&
      value['authorizationCode'].length <= 16_384) {
    return Object.freeze({ type: 'authorization_code', authorizationCode: value['authorizationCode'] });
  }
  if (value['type'] === 'finished' && exactKeys(value, ['type'])) return Object.freeze({ type: 'finished' });
  if (value['type'] === 'cancelled' && exactKeys(value, ['type'])) return Object.freeze({ type: 'cancelled' });
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
}

function exactHttpsOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function isHttpsEvidenceUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}
