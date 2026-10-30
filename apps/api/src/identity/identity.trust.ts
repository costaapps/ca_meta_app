import { createHash } from 'node:crypto';

declare const verifiedPortalSessionBrand: unique symbol;
declare const verifiedIdentityAssertionBrand: unique symbol;
declare const platformIdentityAdminBrand: unique symbol;

const verifiedPortalSessions = new WeakSet<object>();
const verifiedAssertions = new WeakSet<object>();
const platformAdministrators = new WeakSet<object>();

export interface VerifiedPortalSession {
  readonly [verifiedPortalSessionBrand]: true;
  readonly sessionId: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly contextVersion: number;
  readonly contextRefHash: string;
}

export interface VerifiedIdentityAssertion {
  readonly [verifiedIdentityAssertionBrand]: true;
  readonly issuer: string;
  readonly subject: string;
}

export interface VerifiedPlatformIdentityAdmin {
  readonly [platformIdentityAdminBrand]: true;
  readonly actorRef: string;
}

export interface StoredPortalSession {
  readonly sessionId: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly contextVersion: number;
  readonly contextRefHash: string;
}

export interface PortalSessionStore {
  /** The adapter must return only a live server-side session for this digest. */
  findActiveBySecretHash(secretHash: Uint8Array): Promise<StoredPortalSession | undefined>;
}

export function isVerifiedPortalSession(value: unknown): value is VerifiedPortalSession {
  return typeof value === 'object' && value !== null && verifiedPortalSessions.has(value);
}

export function isVerifiedIdentityAssertion(value: unknown): value is VerifiedIdentityAssertion {
  return typeof value === 'object' && value !== null && verifiedAssertions.has(value);
}

export function isVerifiedPlatformIdentityAdmin(value: unknown): value is VerifiedPlatformIdentityAdmin {
  return typeof value === 'object' && value !== null && platformAdministrators.has(value);
}

/** M3.04 supplies the persistent store. Raw cookie material is reduced before the adapter sees it. */
export class PortalSessionVerifier {
  constructor(private readonly store: PortalSessionStore) {}

  async verify(cookieValue: string | undefined): Promise<VerifiedPortalSession | undefined> {
    if (!cookieValue || cookieValue.length < 32 || cookieValue.length > 512) return undefined;
    const secretHash = createHash('sha256').update(cookieValue, 'utf8').digest();
    const row = await this.store.findActiveBySecretHash(secretHash);
    if (!row || !row.sessionId || !row.principalId || !row.tenantId ||
      !Number.isSafeInteger(row.contextVersion) || row.contextVersion < 1 || !/^[a-f0-9]{64}$/.test(row.contextRefHash)) {
      return undefined;
    }
    const result = Object.freeze({ ...row }) as VerifiedPortalSession;
    verifiedPortalSessions.add(result);
    return result;
  }
}

/** Trusted issuer adapters subclass this server-side verifier; request DTOs cannot mint the capability. */
export abstract class IdentityAssertionVerifier {
  protected issueVerifiedAssertion(issuer: string, subject: string): VerifiedIdentityAssertion {
    if (!issuer || issuer.length > 255 || !subject || subject.length > 255) {
      throw new Error('The verified identity assertion is malformed.');
    }
    const result = Object.freeze({ issuer, subject }) as VerifiedIdentityAssertion;
    verifiedAssertions.add(result);
    return result;
  }
}

/** Explicit operator configuration grants platform authority; an empty allowlist always denies. */
export class PlatformIdentityAdminAuthority {
  private readonly allowed = new Set<string>();

  constructor(identities: readonly { readonly issuer: string; readonly subject: string }[]) {
    for (const identity of identities) {
      if (identity.issuer && identity.subject) this.allowed.add(identityKey(identity.issuer, identity.subject));
    }
  }

  verify(assertion: VerifiedIdentityAssertion): VerifiedPlatformIdentityAdmin {
    if (!isVerifiedIdentityAssertion(assertion) || !this.allowed.has(identityKey(assertion.issuer, assertion.subject))) {
      throw new Error('Platform identity administration is not configured for this identity.');
    }
    const actorRef = createHash('sha256').update(assertion.issuer).update('\0').update(assertion.subject).digest('hex');
    const result = Object.freeze({ actorRef }) as VerifiedPlatformIdentityAdmin;
    platformAdministrators.add(result);
    return result;
  }
}

function identityKey(issuer: string, subject: string): string {
  return `${issuer}\0${subject}`;
}
