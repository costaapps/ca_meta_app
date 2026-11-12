import { createHash, timingSafeEqual } from 'node:crypto';

declare const verifiedPortalSessionBrand: unique symbol;
declare const verifiedIdentityAssertionBrand: unique symbol;
declare const platformIdentityAdminBrand: unique symbol;
declare const verifiedServiceCredentialBrand: unique symbol;
declare const verifiedWorkerServiceIdentityBrand: unique symbol;
declare const verifiedPersistedJobContextBrand: unique symbol;

const verifiedPortalSessions = new WeakSet<object>();
const verifiedAssertions = new WeakSet<object>();
const platformAdministrators = new WeakSet<object>();
const verifiedServiceCredentials = new WeakSet<object>();
const verifiedWorkerServiceIdentities = new WeakSet<object>();
const verifiedPersistedJobs = new WeakSet<object>();

export type PortalEntryMode = 'PORTAL_TOP_LEVEL' | 'SUITE4_EMBED';

export function isPortalEntryMode(value: unknown): value is PortalEntryMode {
  return value === 'PORTAL_TOP_LEVEL' || value === 'SUITE4_EMBED';
}

export interface VerifiedPortalSession {
  readonly [verifiedPortalSessionBrand]: true;
  readonly sessionId: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly contextVersion: number;
  readonly contextRefHash: string;
  /** Stored hash for the synchronizer token; the token itself is never persisted. */
  readonly csrfTokenHash: string;
  /** Server-persisted mode from the browser-bound pre-auth record. */
  readonly entryMode: PortalEntryMode;
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

/** A server-side verifier binds a credential to exactly one service principal and tenant. */
export interface VerifiedServiceCredential {
  readonly [verifiedServiceCredentialBrand]: true;
  readonly principalId: string;
  readonly tenantId: string;
}

/** Authenticated worker principal. Tenant authority is resolved separately from the persisted job. */
export interface VerifiedWorkerServiceIdentity {
  readonly [verifiedWorkerServiceIdentityBrand]: true;
  readonly principalId: string;
}

export interface WorkerServiceCredentialHash {
  readonly principalId: string;
  /** Lowercase SHA-256 hex digest of a high-entropy worker proof. The proof itself is never configured here. */
  readonly credentialSha256: string;
}

/** One high-entropy machine credential pinned to one tenant and service principal. */
export interface InternalServiceCredentialHash {
  readonly principalId: string;
  readonly tenantId: string;
  /** Lowercase SHA-256 of the delivered proof; the proof itself is never configured. */
  readonly credentialSha256: string;
}

export interface VerifiedPersistedJobContext {
  readonly [verifiedPersistedJobContextBrand]: true;
  readonly jobId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface StoredPortalSession {
  readonly sessionId: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly contextVersion: number;
  readonly contextRefHash: string;
  readonly csrfTokenHash: string;
  readonly entryMode: PortalEntryMode;
}

export interface PortalSessionStore {
  /** The adapter must return only a live server-side session for this digest. */
  findActiveBySecretHash(secretHash: Uint8Array, options?: { readonly touchLastSeen?: boolean }): Promise<StoredPortalSession | undefined>;
}

export interface PortalSessionVerificationOptions {
  /** Set false for rate-limited status reads; the route refreshes activity only after its quota passes. */
  readonly touchLastSeen?: boolean;
}

export interface PersistedJobContextRecord {
  readonly jobId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface PersistedJobContextStore {
  /** Resolve a queue reference by loading the authoritative persisted job row, never caller-supplied tenant fields. */
  findPersistedJobContext(reference: string): Promise<PersistedJobContextRecord | undefined>;
}

export interface ServiceCredentialProofVerifier {
  /** M3.08 supplies the credential verifier; credential bytes must never be returned or logged. */
  verifyCredential(credential: string | undefined): Promise<VerifiedServiceCredential | undefined>;
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

export function isVerifiedServiceCredential(value: unknown): value is VerifiedServiceCredential {
  return typeof value === 'object' && value !== null && verifiedServiceCredentials.has(value);
}

export function isVerifiedWorkerServiceIdentity(value: unknown): value is VerifiedWorkerServiceIdentity {
  return typeof value === 'object' && value !== null && verifiedWorkerServiceIdentities.has(value);
}

export function isVerifiedPersistedJobContext(value: unknown): value is VerifiedPersistedJobContext {
  return typeof value === 'object' && value !== null && verifiedPersistedJobs.has(value);
}

/** M3.04 supplies the persistent store. Raw cookie material is reduced before the adapter sees it. */
export class PortalSessionVerifier {
  constructor(private readonly store: PortalSessionStore) {}

  async verify(cookieValue: string | undefined, options: PortalSessionVerificationOptions = {}): Promise<VerifiedPortalSession | undefined> {
    if (!cookieValue || cookieValue.length < 32 || cookieValue.length > 512) return undefined;
    const secretHash = createHash('sha256').update(cookieValue, 'utf8').digest();
    const row = await this.store.findActiveBySecretHash(secretHash, options);
    if (!row || !row.sessionId || !row.principalId || !row.tenantId ||
      !Number.isSafeInteger(row.contextVersion) || row.contextVersion < 1 || !/^[a-f0-9]{64}$/.test(row.contextRefHash) ||
      !isPortalEntryMode(row.entryMode)) {
      return undefined;
    }
    if (!/^[a-f0-9]{64}$/.test(row.csrfTokenHash)) return undefined;
    const result = Object.freeze({ ...row }) as VerifiedPortalSession;
    verifiedPortalSessions.add(result);
    return result;
  }
}

/** Trusted M3.08 adapters subclass this boundary after credential authentication and server-side tenant binding. */
export abstract class ServiceCredentialVerifier implements ServiceCredentialProofVerifier {
  abstract verifyCredential(credential: string | undefined): Promise<VerifiedServiceCredential | undefined>;

  protected issueVerifiedServiceCredential(principalId: string, tenantId: string): VerifiedServiceCredential {
    if (!principalId || !tenantId) throw new Error('The verified service credential context is malformed.');
    const result = Object.freeze({ principalId, tenantId }) as VerifiedServiceCredential;
    verifiedServiceCredentials.add(result);
    return result;
  }
}

/** Verifies a worker process proof against a hash-only server configuration. */
export class WorkerServiceIdentityVerifier {
  private readonly credentials: readonly { readonly principalId: string; readonly digest: Buffer }[];

  constructor(credentials: readonly WorkerServiceCredentialHash[]) {
    this.credentials = Object.freeze(credentials.map(({ principalId, credentialSha256 }) => {
      if (!principalId || !/^[a-f0-9]{64}$/.test(credentialSha256)) {
        throw new Error('Worker service credential configuration is malformed.');
      }
      return Object.freeze({ principalId, digest: Buffer.from(credentialSha256, 'hex') });
    }));
  }

  verify(credential: string | undefined): VerifiedWorkerServiceIdentity | undefined {
    if (typeof credential !== 'string' || Buffer.byteLength(credential, 'utf8') < 32 ||
        Buffer.byteLength(credential, 'utf8') > 512) return undefined;
    const candidate = createHash('sha256').update(credential, 'utf8').digest();
    let match: string | undefined;
    for (const configured of this.credentials) {
      if (timingSafeEqual(candidate, configured.digest)) match = configured.principalId;
    }
    candidate.fill(0);
    if (!match) return undefined;
    const result = Object.freeze({ principalId: match }) as VerifiedWorkerServiceIdentity;
    verifiedWorkerServiceIdentities.add(result);
    return result;
  }
}

/** M2 worker adapters call this only after reading the persisted job row for a queue reference. */
export class PersistedJobContextVerifier {
  constructor(private readonly store: PersistedJobContextStore) {}

  async verify(reference: string | undefined): Promise<VerifiedPersistedJobContext | undefined> {
    if (!reference || reference.length > 255) return undefined;
    const row = await this.store.findPersistedJobContext(reference);
    if (!row || !row.jobId || !row.principalId || !row.tenantId) return undefined;
    const result = Object.freeze({ ...row }) as VerifiedPersistedJobContext;
    verifiedPersistedJobs.add(result);
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
