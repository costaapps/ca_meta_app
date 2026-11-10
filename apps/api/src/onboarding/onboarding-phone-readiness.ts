import type { OnboardingFlowVariant } from './onboarding-session.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

export type OnboardingPhoneReadinessState = 'READY' | 'ACTION_REQUIRED' | 'UNKNOWN';
export type OnboardingPhoneReadinessReason = 'REGISTERED' | 'ALREADY_REGISTERED' | 'PHONE_REGISTRATION_REQUIRED' |
  'PHONE_STATE_NOT_CONFIRMED' | 'PIN_NOT_AVAILABLE' | 'TOKEN_ELIGIBILITY_NOT_CONFIRMED' |
  'REGISTRATION_REJECTED' | 'REGISTRATION_RESULT_UNKNOWN';

/** Safe per-phone outcome persisted in the existing onboarding saga JSON checkpoint. */
export interface OnboardingPhoneReadiness {
  readonly assetRef: string;
  readonly state: OnboardingPhoneReadinessState;
  readonly reasonCode: OnboardingPhoneReadinessReason;
  readonly observedAt: string;
}

const REASONS: Readonly<Record<OnboardingPhoneReadinessState, readonly OnboardingPhoneReadinessReason[]>> = Object.freeze({
  READY: Object.freeze(['REGISTERED', 'ALREADY_REGISTERED']),
  ACTION_REQUIRED: Object.freeze(['PHONE_REGISTRATION_REQUIRED', 'PIN_NOT_AVAILABLE', 'TOKEN_ELIGIBILITY_NOT_CONFIRMED', 'REGISTRATION_REJECTED']),
  UNKNOWN: Object.freeze(['PHONE_STATE_NOT_CONFIRMED', 'REGISTRATION_RESULT_UNKNOWN']),
});

/** Rejects provider IDs, PINs and arbitrary fields; only tenant-owned internal asset refs can cross this boundary. */
export function isSafePhoneReadiness(value: unknown, flowVariant: OnboardingFlowVariant,
  verifiedAssetRefs?: readonly string[]): value is readonly OnboardingPhoneReadiness[] {
  if (flowVariant !== 'WHATSAPP_CLOUD_API' || !Array.isArray(value) || value.length < 1 || value.length > 100) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const row = item as Record<string, unknown>;
    if (Object.keys(row).length !== 4 || Object.keys(row).some((key) => !['assetRef', 'state', 'reasonCode', 'observedAt'].includes(key)) ||
        typeof row['assetRef'] !== 'string' || !UUID.test(row['assetRef']) || seen.has(row['assetRef']) ||
        (verifiedAssetRefs !== undefined && !verifiedAssetRefs.includes(row['assetRef'])) ||
        (row['state'] !== 'READY' && row['state'] !== 'ACTION_REQUIRED' && row['state'] !== 'UNKNOWN') ||
        typeof row['reasonCode'] !== 'string' || !REASONS[row['state'] as OnboardingPhoneReadinessState].includes(row['reasonCode'] as OnboardingPhoneReadinessReason) ||
        typeof row['observedAt'] !== 'string' || !ISO_UTC.test(row['observedAt']) || !Number.isFinite(Date.parse(row['observedAt']))) return false;
    seen.add(row['assetRef']);
  }
  return true;
}

export function hasReadyPhoneReadiness(value: readonly OnboardingPhoneReadiness[] | undefined): boolean {
  return !!value?.length && value.every((item) => item.state === 'READY');
}
