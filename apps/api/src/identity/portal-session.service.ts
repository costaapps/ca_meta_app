import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { IdentityDeniedError } from './identity.errors.js';
import { isVerifiedIdentityAssertion, isVerifiedPortalSession } from './identity.trust.js';
import type { VerifiedIdentityAssertion, VerifiedPortalSession } from './identity.trust.js';
import type { MembershipRole } from './identity.types.js';
import { TenantContextService } from './identity.service.js';

export const PORTAL_SESSION_STORE = Symbol('PORTAL_SESSION_STORE');

export interface VerifiedPortalPreAuth {
  readonly id: string;
  readonly challengeHash: string;
  readonly browserBindingHash: string;
  readonly entryMode: 'PORTAL_TOP_LEVEL' | 'SUITE4_EMBED';
  readonly [verifiedPortalPreAuthBrand]: true;
}
const verifiedPortalPreAuthBrand: unique symbol = Symbol('verifiedPortalPreAuth');
const verifiedPreAuthValues = new WeakSet<object>();

export interface StartedPortalPreAuth {
  readonly challengeRef: string;
  readonly cookieValue: string;
  readonly expiresAt: string;
  readonly entryMode: 'PORTAL_TOP_LEVEL';
}

export interface PortalSessionIssueOptions {
  /** Lowercase SHA-256 hex digest. Raw JTI and ticket are deliberately excluded. */
  readonly ticketJtiSha256: string;
  readonly ticketExpiresAt: Date;
  /** Lowercase SHA-256 hex digest of the validated ticket's preauth_challenge claim. */
  readonly ticketChallengeSha256: string;
  readonly preAuth: VerifiedPortalPreAuth;
  readonly priorSession?: VerifiedPortalSession;
}

export interface PortalSessionPublicContext {
  readonly principalRef: string;
  readonly roles: readonly MembershipRole[];
  readonly tenantRef: string;
  readonly tenantContextRef: string;
  readonly contextVersion: number;
}

export interface IssuedPortalSession {
  readonly sessionId: string;
  readonly sessionCookie: string;
  readonly csrfToken: string;
  readonly contextRef: string;
  readonly tenantId: string;
  readonly expiresAt: string;
  readonly publicContext: PortalSessionPublicContext;
}

export interface PortalSessionRecord {
  readonly sessionId: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly contextVersion: number;
  readonly contextRefHash: string;
  readonly csrfTokenHash: string;
  readonly roles: readonly MembershipRole[];
  readonly sessionCookie: string;
  readonly csrfToken: string;
  readonly contextRef: string;
  readonly expiresAt: string;
}

export interface PortalPreAuthRecord {
  readonly id: string;
  readonly challengeHash: string;
  readonly browserCookieHash: string;
  readonly entryMode: 'PORTAL_TOP_LEVEL' | 'SUITE4_EMBED';
  readonly expiresAt: Date;
  readonly consumedAt?: Date;
}

export interface PortalSessionIssueRecord {
  readonly assertion: VerifiedIdentityAssertion;
  readonly requestedTenantId: string;
  readonly ticketJtiSha256: string;
  readonly ticketChallengeSha256: string;
  readonly ticketExpiresAt: Date;
  readonly preAuth: VerifiedPortalPreAuth;
  readonly priorSession?: VerifiedPortalSession;
  readonly sessionId: string;
  readonly sessionCookie: string;
  readonly sessionCookieHash: string;
  readonly csrfToken: string;
  readonly csrfTokenHash: string;
  readonly contextRef: string;
  readonly contextRefHash: string;
}

export interface PortalSessionStore {
  createPreAuth(input: Omit<PortalPreAuthRecord, 'consumedAt' | 'expiresAt'>): Promise<Date>;
  findPreAuth(challengeHash: string, browserCookieHash: string): Promise<PortalPreAuthRecord | undefined>;
  createOrRecoverSession(input: PortalSessionIssueRecord): Promise<PortalSessionRecord>;
  findActiveBySecretHash(secretHash: Uint8Array): Promise<{
    readonly sessionId: string;
    readonly principalId: string;
    readonly tenantId: string;
    readonly contextVersion: number;
    readonly contextRefHash: string;
    readonly csrfTokenHash: string;
  } | undefined>;
  changeContext(input: {
    readonly session: VerifiedPortalSession;
    readonly requestedTenantId: string;
    readonly contextRef: string;
    readonly contextRefHash: string;
    readonly csrfTokenHash: string;
  }): Promise<{ readonly contextVersion: number; readonly roles: readonly MembershipRole[] }>;
  revokeSession(sessionId: string, principalId: string): Promise<boolean>;
}

export abstract class PortalPreAuthService {
  abstract begin(): Promise<StartedPortalPreAuth>;
  abstract verifyBrowserBinding(challengeRef: string | undefined, preAuthCookie: string | undefined): Promise<VerifiedPortalPreAuth | undefined>;
}

export abstract class PortalSessionIssuer {
  abstract issueFromVerifiedAssertion(
    assertion: VerifiedIdentityAssertion,
    requestedTenantId: string,
    options: PortalSessionIssueOptions,
  ): Promise<IssuedPortalSession>;
}

function digestHex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function digestMatches(expectedHex: string, actualHex: string): boolean {
  if (!validDigest(expectedHex) || !validDigest(actualHex)) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  return timingSafeEqual(expected, actual);
}

function makeVerifiedPreAuth(record: PortalPreAuthRecord): VerifiedPortalPreAuth {
  const result = Object.freeze({
    id: record.id,
    challengeHash: record.challengeHash,
    browserBindingHash: record.browserCookieHash,
    entryMode: record.entryMode,
  }) as VerifiedPortalPreAuth;
  verifiedPreAuthValues.add(result);
  return result;
}

function isVerifiedPreAuth(value: unknown): value is VerifiedPortalPreAuth {
  return typeof value === 'object' && value !== null && verifiedPreAuthValues.has(value);
}

function derivedValue(key: string, purpose: 'session' | 'csrf' | 'context', issuer: string, jtiHash: string, bindingHash: string): string {
  return createHmac('sha256', key)
    .update(`ca-meta-portal-${purpose}\0${issuer}\0${jtiHash}\0${bindingHash}`, 'utf8')
    .digest('base64url');
}

export class MysqlPortalSessionService implements PortalPreAuthService, PortalSessionIssuer {
  constructor(
    private readonly store: PortalSessionStore,
    private readonly contexts: TenantContextService,
    private readonly recoveryKey: string,
  ) {
    if (Buffer.byteLength(recoveryKey, 'utf8') < 32) throw new Error('Portal session recovery key must contain at least 32 bytes.');
  }

  async begin(): Promise<StartedPortalPreAuth> {
    const challengeRef = randomBytes(32).toString('base64url');
    const cookieValue = randomBytes(32).toString('base64url');
    const expiresAt = await this.store.createPreAuth({
      id: randomUUID(),
      challengeHash: digestHex(challengeRef),
      browserCookieHash: digestHex(cookieValue),
      entryMode: 'PORTAL_TOP_LEVEL',
    });
    return Object.freeze({ challengeRef, cookieValue, expiresAt: expiresAt.toISOString(), entryMode: 'PORTAL_TOP_LEVEL' });
  }

  async verifyBrowserBinding(challengeRef: string | undefined, preAuthCookie: string | undefined): Promise<VerifiedPortalPreAuth | undefined> {
    if (!challengeRef || challengeRef.length > 512 || !preAuthCookie || preAuthCookie.length > 512) return undefined;
    const record = await this.store.findPreAuth(digestHex(challengeRef), digestHex(preAuthCookie));
    return record ? makeVerifiedPreAuth(record) : undefined;
  }

  async issueFromVerifiedAssertion(
    assertion: VerifiedIdentityAssertion,
    requestedTenantId: string,
    options: PortalSessionIssueOptions,
  ): Promise<IssuedPortalSession> {
    if (!isVerifiedIdentityAssertion(assertion) || !isVerifiedPreAuth(options.preAuth) || !requestedTenantId ||
      !validDigest(options.ticketJtiSha256) || !validDigest(options.ticketChallengeSha256) ||
      !digestMatches(options.preAuth.challengeHash, options.ticketChallengeSha256) ||
      !(options.ticketExpiresAt instanceof Date) || !Number.isFinite(options.ticketExpiresAt.getTime()) ||
      options.ticketExpiresAt.getTime() <= Date.now() ||
      (options.priorSession !== undefined && !isVerifiedPortalSession(options.priorSession))) {
      throw new IdentityDeniedError();
    }

    // Resolve through the exported identity façade; the SQL adapter rechecks this inside the issue transaction.
    await this.contexts.resolveInitialTenantForIdentity(assertion, requestedTenantId);
    const sessionCookie = derivedValue(this.recoveryKey, 'session', assertion.issuer, options.ticketJtiSha256, options.preAuth.browserBindingHash);
    const csrfToken = derivedValue(this.recoveryKey, 'csrf', assertion.issuer, options.ticketJtiSha256, options.preAuth.browserBindingHash);
    const contextRef = derivedValue(this.recoveryKey, 'context', assertion.issuer, options.ticketJtiSha256, options.preAuth.browserBindingHash);
    const sessionId = randomUUID();
    const record = await this.store.createOrRecoverSession({
      assertion,
      requestedTenantId,
      ticketJtiSha256: options.ticketJtiSha256,
      ticketChallengeSha256: options.ticketChallengeSha256,
      ticketExpiresAt: options.ticketExpiresAt,
      preAuth: options.preAuth,
      ...(options.priorSession ? { priorSession: options.priorSession } : {}),
      sessionId,
      sessionCookie,
      sessionCookieHash: digestHex(sessionCookie),
      csrfToken,
      csrfTokenHash: digestHex(csrfToken),
      contextRef,
      contextRefHash: digestHex(contextRef),
    });
    const principalRef = createHash('sha256').update(`principal-ref\0${record.principalId}`, 'utf8').digest('hex');
    const publicContext: PortalSessionPublicContext = Object.freeze({
      principalRef,
      roles: Object.freeze([...record.roles]),
      tenantRef: record.tenantId,
      tenantContextRef: record.contextRef,
      contextVersion: record.contextVersion,
    });
    return Object.freeze({
      sessionId: record.sessionId,
      sessionCookie: record.sessionCookie,
      csrfToken: record.csrfToken,
      contextRef: record.contextRef,
      tenantId: record.tenantId,
      expiresAt: record.expiresAt,
      publicContext,
    });
  }

  async rotateTenantContext(session: VerifiedPortalSession, tenantContextRef: string | undefined, requestedTenantId: string): Promise<{
    readonly contextRef: string;
    readonly csrfToken: string;
    readonly publicContext: Omit<PortalSessionPublicContext, 'principalRef'>;
  }> {
    const current = await this.contexts.resolveTenantSwitch(session, tenantContextRef, requestedTenantId);
    const contextRef = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const updated = await this.store.changeContext({
      session,
      requestedTenantId: current.tenantId,
      contextRef,
      contextRefHash: digestHex(contextRef),
      csrfTokenHash: digestHex(csrfToken),
    });
    return Object.freeze({
      contextRef,
      csrfToken,
      publicContext: Object.freeze({
        roles: Object.freeze([...updated.roles]),
        tenantRef: current.tenantId,
        tenantContextRef: contextRef,
        contextVersion: updated.contextVersion,
      }),
    });
  }

  async revoke(session: VerifiedPortalSession): Promise<void> {
    if (!isVerifiedPortalSession(session)) throw new IdentityDeniedError();
    await this.store.revokeSession(session.sessionId, session.principalId);
  }
}

export const PORTAL_SESSION_COOKIE = '__Host-ca_meta_portal';
export const PORTAL_CSRF_COOKIE = '__Host-ca_meta_csrf';
export const PORTAL_CONTEXT_COOKIE = '__Host-ca_meta_context';
export const PORTAL_PREAUTH_COOKIE = '__Host-ca_meta_pre_auth';

export function readPortalCookie(header: string | undefined, name: string): string | undefined {
  if (!header || header.length > 8192) return undefined;
  const matches: string[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) matches.push(part.slice(separator + 1).trim());
  }
  if (matches.length !== 1 || !/^[A-Za-z0-9._~-]{32,512}$/.test(matches[0] ?? '')) return undefined;
  return matches[0];
}

function cookie(value: string, options: { readonly httpOnly: boolean; readonly maxAgeSeconds: number; readonly sameSite?: 'Lax' | 'Strict' }): string {
  const safe = /^[A-Za-z0-9._~-]*$/.test(value);
  if (!safe || !Number.isSafeInteger(options.maxAgeSeconds) || options.maxAgeSeconds < 0) throw new Error('Invalid portal cookie value.');
  return `${PORTAL_SESSION_COOKIE}=${value}; Path=/; Max-Age=${options.maxAgeSeconds}; Secure; SameSite=${options.sameSite ?? 'Lax'}${options.httpOnly ? '; HttpOnly' : ''}`;
}

function serializeNamedCookie(name: string, value: string, options: { readonly httpOnly: boolean; readonly maxAgeSeconds: number; readonly sameSite?: 'Lax' | 'Strict' }): string {
  const safe = /^[A-Za-z0-9._~-]*$/.test(value);
  if (!safe || !Number.isSafeInteger(options.maxAgeSeconds) || options.maxAgeSeconds < 0) throw new Error('Invalid portal cookie value.');
  return `${name}=${value}; Path=/; Max-Age=${options.maxAgeSeconds}; Secure; SameSite=${options.sameSite ?? 'Lax'}${options.httpOnly ? '; HttpOnly' : ''}`;
}

export function setPortalSessionCookies(response: Response, issued: IssuedPortalSession): void {
  const maxAgeSeconds = Math.max(0, Math.floor((Date.parse(issued.expiresAt) - Date.now()) / 1000));
  response.append('Set-Cookie', cookie(issued.sessionCookie, { httpOnly: true, maxAgeSeconds }));
  response.append('Set-Cookie', serializeNamedCookie(PORTAL_CSRF_COOKIE, issued.csrfToken, { httpOnly: false, maxAgeSeconds, sameSite: 'Strict' }));
  response.append('Set-Cookie', serializeNamedCookie(PORTAL_CONTEXT_COOKIE, issued.contextRef, { httpOnly: false, maxAgeSeconds }));
}

export function setPortalPreAuthCookie(response: Response, started: StartedPortalPreAuth): void {
  const maxAgeSeconds = Math.max(0, Math.floor((Date.parse(started.expiresAt) - Date.now()) / 1000));
  response.append('Set-Cookie', serializeNamedCookie(PORTAL_PREAUTH_COOKIE, started.cookieValue, { httpOnly: true, maxAgeSeconds }));
}

export function setPortalContextCookies(response: Response, contextRef: string, csrfToken: string, expiresAt: string): void {
  const maxAgeSeconds = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  response.append('Set-Cookie', serializeNamedCookie(PORTAL_CONTEXT_COOKIE, contextRef, { httpOnly: false, maxAgeSeconds }));
  response.append('Set-Cookie', serializeNamedCookie(PORTAL_CSRF_COOKIE, csrfToken, { httpOnly: false, maxAgeSeconds, sameSite: 'Strict' }));
}

export function clearPortalSessionCookies(response: Response): void {
  for (const [name, httpOnly, sameSite] of [
    [PORTAL_SESSION_COOKIE, true, 'Lax'],
    [PORTAL_CSRF_COOKIE, false, 'Strict'],
    [PORTAL_CONTEXT_COOKIE, false, 'Lax'],
    [PORTAL_PREAUTH_COOKIE, true, 'Lax'],
  ] as const) {
    response.append('Set-Cookie', `${name}=; Path=/; Max-Age=0; Secure; SameSite=${sameSite}${httpOnly ? '; HttpOnly' : ''}`);
  }
}

export function portalSecretHash(value: string): string {
  return digestHex(value);
}
