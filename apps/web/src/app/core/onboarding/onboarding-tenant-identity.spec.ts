import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { PortalTenantIdentityService } from '../portal/portal-tenant-identity.service';
import { ONBOARDING_TENANT_IDENTITY, ONBOARDING_TENANT_IDENTITY_WARNING } from './onboarding-tenant-identity';

describe('ONBOARDING_TENANT_IDENTITY', () => {
  it('delegates to PortalTenantIdentityService without treating an opaque tenant ref as a company name', () => {
    const capability = Object.freeze({
      confirmed: false as const,
      reason: 'TENANT_IDENTITY_UNCONFIRMED' as const,
      message: ONBOARDING_TENANT_IDENTITY_WARNING,
    });
    TestBed.configureTestingModule({
      providers: [{ provide: PortalTenantIdentityService, useValue: { current: capability } }],
    });

    expect(TestBed.inject(ONBOARDING_TENANT_IDENTITY).current()).toBe(capability);
  });
});
