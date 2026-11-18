import { Injectable } from '@angular/core';
import { PortalSessionService, type PortalSession } from './portal-session.service';

export const TENANT_IDENTITY_UNCONFIRMED_MESSAGE = 'Identidade da empresa não confirmada' as const;

/** A confirmed company identity must come from a server-owned label or authenticated host context. */
export type TenantMutationCapability =
  | {
    readonly confirmed: true;
    readonly tenantDisplayName: string;
    readonly source: 'server-session' | 'confirmed-host-context';
  }
  | {
    readonly confirmed: false;
    readonly reason: 'TENANT_IDENTITY_UNCONFIRMED';
    readonly message: typeof TENANT_IDENTITY_UNCONFIRMED_MESSAGE;
  };

const UNCONFIRMED_CAPABILITY: TenantMutationCapability = Object.freeze({
  confirmed: false,
  reason: 'TENANT_IDENTITY_UNCONFIRMED',
  message: TENANT_IDENTITY_UNCONFIRMED_MESSAGE,
});

/**
 * Current SessionContext has no tenantDisplayName or confirmed host-context evidence.
 * tenantRef and tenantContextRef are opaque selectors and cannot confirm a company name.
 */
export function tenantMutationCapability(_session: PortalSession | null): TenantMutationCapability {
  return UNCONFIRMED_CAPABILITY;
}

@Injectable({ providedIn: 'root' })
export class PortalTenantIdentityService {
  constructor(private readonly sessions: PortalSessionService) {}

  get current(): TenantMutationCapability {
    return this.forSession(this.sessions.current);
  }

  forSession(session: PortalSession | null): TenantMutationCapability {
    return tenantMutationCapability(session);
  }
}
