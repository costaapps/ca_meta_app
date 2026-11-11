import { InjectionToken } from '@angular/core';

export const ONBOARDING_TENANT_IDENTITY_WARNING = 'Identidade da empresa não confirmada' as const;

/** Structural seam for M5.01's PortalTenantIdentityService without trusting tenantRef as a label. */
export type OnboardingTenantMutationCapability =
  | {
    readonly confirmed: true;
    readonly tenantDisplayName: string;
    readonly source: 'server-session' | 'confirmed-host-context';
  }
  | {
    readonly confirmed: false;
    readonly reason: 'TENANT_IDENTITY_UNCONFIRMED';
    readonly message: typeof ONBOARDING_TENANT_IDENTITY_WARNING;
  };

export interface OnboardingTenantIdentityReader {
  current(): OnboardingTenantMutationCapability;
}

const UNCONFIRMED: OnboardingTenantMutationCapability = Object.freeze({
  confirmed: false,
  reason: 'TENANT_IDENTITY_UNCONFIRMED',
  message: ONBOARDING_TENANT_IDENTITY_WARNING,
});

/**
 * One-file M5.01 binding point. The production factory stays fail-closed until the portal identity
 * service is present; tests may provide a synthetic confirmed capability.
 */
export const ONBOARDING_TENANT_IDENTITY = new InjectionToken<OnboardingTenantIdentityReader>(
  'ONBOARDING_TENANT_IDENTITY',
  { providedIn: 'root', factory: () => ({ current: () => UNCONFIRMED }) },
);
