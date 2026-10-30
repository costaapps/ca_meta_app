import type { KeyObject } from 'node:crypto';
import type { DynamicModule, InjectionToken, Type } from '@nestjs/common';
import type { Response } from 'express';
import type { MembershipRole } from '../identity/identity.types.js';
import type { VerifiedIdentityAssertion, VerifiedPortalSession } from '../identity/identity.trust.js';

/** The initial local profile is deliberately narrow; Suite4's real profile is Not confirmed. */
export interface TicketExchangeConfiguration {
  readonly issuer: string;
  readonly audience: string;
  readonly clockSkewSeconds: number;
  readonly maximumLifetimeSeconds: number;
}

/** A resolver reads only a server-configured key set. It must never follow a URL from the token. */
export abstract class TrustedTicketKeySet {
  abstract findPublicKey(kid: string): Promise<KeyObject | undefined>;
}

export class TrustedTicketKeySetUnavailableError extends Error {
  constructor() {
    super('The trusted ticket key set is unavailable.');
    this.name = 'TrustedTicketKeySetUnavailableError';
  }
}

export interface VerifiedPortalPreAuth {
  readonly __opaquePreAuthCapability?: never;
}

export interface PortalPreAuthServicePort {
  verifyBrowserBinding(challengeRef: string | undefined, preAuthCookie: string | undefined): Promise<VerifiedPortalPreAuth | undefined>;
}

export interface PortalSessionIssueOptions {
  readonly ticketJtiSha256: string;
  readonly ticketExpiresAt: Date;
  readonly ticketChallengeSha256: string;
  readonly preAuth: VerifiedPortalPreAuth;
  readonly priorSession?: VerifiedPortalSession;
}

export interface PortalSessionPublicContext {
  readonly sessionRef: string;
  readonly principalRef: string;
  readonly tenantRef: string;
  readonly roles: readonly MembershipRole[];
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

/** Must re-read active membership and atomically consume pre-auth/JTI + rotate/create session. */
export abstract class PortalSessionIssuerPort {
  abstract issueFromVerifiedAssertion(
    assertion: VerifiedIdentityAssertion,
    requestedTenantId: string,
    options: PortalSessionIssueOptions,
  ): Promise<IssuedPortalSession>;
}

export interface PortalSessionVerifierPort {
  verify(cookieValue: string | undefined): Promise<VerifiedPortalSession | undefined>;
}

export interface PortalExchangeAbuseLimitPort {
  consume(bucket: 'PORTAL_EXCHANGE', dimensions: { readonly ip: string; readonly actor: string }): Promise<void>;
}

export class PortalExchangeRateLimitedError extends Error {
  readonly retryAfterSeconds = 60;

  constructor() {
    super('The portal exchange limit was reached.');
    this.name = 'PortalExchangeRateLimitedError';
  }
}

export interface AuthExchangeCookieWriter {
  set(response: Response, issued: IssuedPortalSession): void;
}

export const AUTH_EXCHANGE_KEY_SET = Symbol('AUTH_EXCHANGE_KEY_SET');
export const AUTH_EXCHANGE_CONFIGURATION = Symbol('AUTH_EXCHANGE_CONFIGURATION');
export const AUTH_EXCHANGE_PORTAL_PREAUTH = Symbol('AUTH_EXCHANGE_PORTAL_PREAUTH');
export const AUTH_EXCHANGE_SESSION_ISSUER = Symbol('AUTH_EXCHANGE_SESSION_ISSUER');
export const AUTH_EXCHANGE_SESSION_VERIFIER = Symbol('AUTH_EXCHANGE_SESSION_VERIFIER');
export const AUTH_EXCHANGE_COOKIE_WRITER = Symbol('AUTH_EXCHANGE_COOKIE_WRITER');
export const AUTH_EXCHANGE_ALLOWED_ORIGINS = Symbol('AUTH_EXCHANGE_ALLOWED_ORIGINS');
export const AUTH_EXCHANGE_ABUSE_LIMIT = Symbol('AUTH_EXCHANGE_ABUSE_LIMIT');
export const AUTH_EXCHANGE_TEST_LOOPBACK_ORIGINS = Symbol('AUTH_EXCHANGE_TEST_LOOPBACK_ORIGINS');

export const PRE_AUTH_COOKIE_NAME = '__Host-ca_meta_pre_auth';
export const PORTAL_SESSION_COOKIE_NAME = '__Host-ca_meta_portal';

export interface AuthExchangeModuleOptions {
  readonly imports?: readonly (DynamicModule | Type<unknown>)[];
  readonly configuration: TicketExchangeConfiguration;
  readonly trustedKeySet: TrustedTicketKeySet;
  readonly allowedOrigins: readonly string[];
  /** Enabled only for exact loopback origins when NODE_ENV=test. */
  readonly allowInsecureLoopbackOrigins?: boolean;
  readonly preAuthServiceToken: InjectionToken;
  readonly sessionIssuerToken: InjectionToken;
  readonly sessionVerifierToken: InjectionToken;
  readonly abuseLimitServiceToken: InjectionToken;
  readonly cookieWriter: AuthExchangeCookieWriter;
}
