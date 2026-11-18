import { inject, InjectionToken } from '@angular/core';
import { PortalTenantIdentityService, type TenantMutationCapability } from '../portal/portal-tenant-identity.service';

export const ONBOARDING_TENANT_IDENTITY_WARNING = 'Identidade da empresa não confirmada' as const;

/** Structural seam for M5.01's PortalTenantIdentityService without trusting tenantRef as a label. */
export type OnboardingTenantMutationCapability = TenantMutationCapability;

export interface OnboardingTenantIdentityReader {
  current(): OnboardingTenantMutationCapability;
}

export const ONBOARDING_TENANT_IDENTITY = new InjectionToken<OnboardingTenantIdentityReader>(
  'ONBOARDING_TENANT_IDENTITY',
  {
    providedIn: 'root',
    factory: () => {
      const identity = inject(PortalTenantIdentityService);
      return Object.freeze({ current: () => identity.current });
    },
  },
);
