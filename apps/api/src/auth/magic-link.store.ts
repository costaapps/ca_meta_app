import type { MembershipRole } from '../identity/identity.types.js';

export const MAGIC_LINK_STORE = Symbol('MAGIC_LINK_STORE');

export interface InvitedIdentityTarget {
  readonly principalId: string;
  readonly tenantId: string;
  readonly membershipVersion: number;
}

export interface MagicLinkDeliveryClaim {
  readonly queueId: string;
  readonly linkId: string;
  readonly recipient: string;
}

export interface MagicLinkSessionMaterial {
  readonly sessionId: string;
  readonly sessionCookie: string;
  readonly sessionCookieHash: string;
  readonly csrfToken: string;
  readonly csrfTokenHash: string;
  readonly contextRef: string;
  readonly contextRefHash: string;
  readonly priorSessionSecretHash?: string;
}

export interface MagicLinkTenantOption {
  readonly tenantRef: string;
  readonly roles: readonly MembershipRole[];
}

export interface MagicLinkIssuedSession extends MagicLinkSessionMaterial {
  readonly principalId: string;
  readonly tenantId: string;
  readonly roles: readonly MembershipRole[];
  readonly expiresAt: string;
  readonly availableTenants: readonly MagicLinkTenantOption[];
}

export interface MagicLinkStore {
  findEligibleTarget(emailHash: string): Promise<InvitedIdentityTarget | undefined>;
  enqueueForInvitedIdentity(input: {
    readonly emailHash: string;
    readonly recipient: string;
    readonly target: InvitedIdentityTarget;
    readonly linkId: string;
    readonly tokenHash: string;
  }): Promise<boolean>;
  claimNextMail(leaseOwner: string): Promise<MagicLinkDeliveryClaim | undefined>;
  markMailDelivered(queueId: string, leaseOwner: string): Promise<void>;
  markMailFailed(queueId: string, leaseOwner: string): Promise<void>;
  consumeAndIssueSession(tokenHash: string, material: MagicLinkSessionMaterial): Promise<MagicLinkIssuedSession>;
}
