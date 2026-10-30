import { BadRequestException, HttpException, HttpStatus, UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { IdentityDeniedError } from '../identity/identity.errors.js';
import type { VerifiedPortalSession } from '../identity/identity.trust.js';
import type { MembershipRole } from '../identity/identity.types.js';
import {
  type AuthExchangeCookieWriter,
  type IssuedPortalSession,
  type PortalPreAuthServicePort,
  type PortalExchangeAbuseLimitPort,
  PortalExchangeRateLimitedError,
  type PortalSessionIssueOptions,
  type PortalSessionIssuerPort,
  type PortalSessionVerifierPort,
  type TicketExchangeConfiguration,
  type TrustedTicketKeySet,
  TrustedTicketKeySetUnavailableError,
  PRE_AUTH_COOKIE_NAME,
  PORTAL_SESSION_COOKIE_NAME,
} from './ticket-contract.js';
import { RejectedTicketError, SignedEntryTicketVerifier } from './signed-ticket.verifier.js';

export interface ExchangeRequest {
  readonly ticket: string;
  readonly challengeRef: string;
}

export interface SessionContextResponse {
  readonly principalRef: string;
  readonly tenantRef: string;
  readonly roles: readonly MembershipRole[];
  readonly tenantContextRef: string;
  readonly contextVersion: number;
  readonly requestId: string;
}

export interface ExchangeRequestContext {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly requestId?: string;
  readonly clientIp?: string;
}

const SAFE_ROLES = new Set<MembershipRole>(['owner', 'admin', 'operator', 'viewer']);

function unauthorized(): never {
  throw new UnauthorizedException();
}

function unavailable(): never {
  throw new ServiceUnavailableException();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequest(): never {
  throw new BadRequestException();
}

function parseExchangeRequest(value: unknown): ExchangeRequest {
  if (!isRecord(value)) invalidRequest();
  if (Object.keys(value).length !== 2 || !Object.prototype.hasOwnProperty.call(value, 'ticket') ||
      !Object.prototype.hasOwnProperty.call(value, 'challengeRef')) invalidRequest();
  if (typeof value.ticket !== 'string' || value.ticket.length < 16 || value.ticket.length > 8192 ||
      typeof value.challengeRef !== 'string' || value.challengeRef.length < 16 || value.challengeRef.length > 128) invalidRequest();
  return { ticket: value.ticket, challengeRef: value.challengeRef };
}

function header(context: ExchangeRequestContext, name: string): string | undefined {
  const value = context.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function readCookie(context: ExchangeRequestContext, name: string): string | undefined {
  const raw = header(context, 'cookie');
  if (!raw || raw.length > 8192) return undefined;
  let found: string | undefined;
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    if (trimmed.slice(0, separator) !== name) continue;
    if (found !== undefined) return undefined;
    const value = trimmed.slice(separator + 1);
    if (!/^[A-Za-z0-9_-]{32,512}$/.test(value)) return undefined;
    found = value;
  }
  return found;
}

function normalizedOrigins(origins: readonly string[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const value of origins) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error('Auth exchange origin configuration is invalid.');
    }
    if (parsed.protocol !== 'https:' || parsed.origin !== value || parsed.username || parsed.password || parsed.hash) {
      throw new Error('Auth exchange origin configuration is invalid.');
    }
    result.add(value);
  }
  if (result.size === 0) throw new Error('Auth exchange requires at least one configured HTTPS origin.');
  return result;
}

function assertRequestOrigin(context: ExchangeRequestContext, allowedOrigins: ReadonlySet<string>): void {
  const origin = header(context, 'origin');
  const fetchSite = header(context, 'sec-fetch-site');
  if (!origin || !allowedOrigins.has(origin) || (fetchSite !== 'same-origin' && fetchSite !== 'same-site')) unauthorized();
}

function safePublicContext(issued: IssuedPortalSession, requestId: string): SessionContextResponse {
  const context = issued.publicContext;
  const roles = context?.roles;
  if (
    !context ||
    !context.principalRef || context.principalRef.length > 128 ||
    !context.tenantRef || context.tenantRef !== issued.tenantId || context.tenantRef.length > 128 ||
    !context.tenantContextRef || context.tenantContextRef.length < 16 || context.tenantContextRef.length > 512 ||
    context.tenantContextRef !== issued.contextRef ||
    !Number.isSafeInteger(context.contextVersion) || context.contextVersion < 1 ||
    !Array.isArray(roles) || roles.length === 0 || roles.length > 8 ||
    new Set(roles).size !== roles.length || roles.some((role) => !SAFE_ROLES.has(role))
  ) {
    unavailable();
  }
  return Object.freeze({
    principalRef: context.principalRef,
    tenantRef: context.tenantRef,
    roles: Object.freeze([...roles]),
    tenantContextRef: context.tenantContextRef,
    contextVersion: context.contextVersion,
    requestId,
  });
}

export class TicketExchangeService {
  private readonly verifier: SignedEntryTicketVerifier;
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(
    configuration: TicketExchangeConfiguration,
    keySet: TrustedTicketKeySet,
    allowedOrigins: readonly string[],
    private readonly preAuth: PortalPreAuthServicePort,
    private readonly sessions: PortalSessionIssuerPort,
    private readonly sessionVerifier: PortalSessionVerifierPort,
    private readonly abuseLimit: PortalExchangeAbuseLimitPort,
    private readonly cookieWriter: AuthExchangeCookieWriter,
    now: () => number = Date.now,
  ) {
    this.verifier = new SignedEntryTicketVerifier(configuration, keySet, now);
    this.allowedOrigins = normalizedOrigins(allowedOrigins);
  }

  async exchange(value: unknown, context: ExchangeRequestContext, response: Response): Promise<SessionContextResponse> {
    const request = parseExchangeRequest(value);
    assertRequestOrigin(context, this.allowedOrigins);
    if (!context.requestId || context.requestId.length > 128) unauthorized();

    let ticket: Awaited<ReturnType<SignedEntryTicketVerifier['verify']>>;
    try {
      ticket = await this.verifier.verify(request.ticket);
    } catch (error) {
      if (error instanceof RejectedTicketError) unauthorized();
      if (error instanceof TrustedTicketKeySetUnavailableError) unavailable();
      unavailable();
    }

    if (!context.clientIp || context.clientIp.length > 128) unavailable();
    try {
      await this.abuseLimit.consume('PORTAL_EXCHANGE', {
        ip: context.clientIp,
        actor: `${ticket.assertion.issuer}\0${ticket.assertion.subject}`,
      });
    } catch (error) {
      if (error instanceof PortalExchangeRateLimitedError) {
        response.setHeader('Retry-After', String(error.retryAfterSeconds));
        throw new HttpException('Request limit exceeded.', HttpStatus.TOO_MANY_REQUESTS);
      }
      unavailable();
    }

    let preAuth: Awaited<ReturnType<PortalPreAuthServicePort['verifyBrowserBinding']>>;
    try {
      preAuth = await this.preAuth.verifyBrowserBinding(
        request.challengeRef,
        readCookie(context, PRE_AUTH_COOKIE_NAME),
      );
    } catch {
      unavailable();
    }
    if (!preAuth) unauthorized();

    let priorSession: VerifiedPortalSession | undefined;
    const priorCookie = readCookie(context, PORTAL_SESSION_COOKIE_NAME);
    if (priorCookie) {
      try {
        priorSession = await this.sessionVerifier.verify(priorCookie);
      } catch {
        unavailable();
      }
    }

    const options: PortalSessionIssueOptions = Object.freeze({
      ticketJtiSha256: ticket.ticketJtiSha256,
      ticketExpiresAt: ticket.ticketExpiresAt,
      ticketChallengeSha256: ticket.ticketChallengeSha256,
      preAuth,
      ...(priorSession ? { priorSession } : {}),
    });

    let issued: IssuedPortalSession;
    try {
      issued = await this.sessions.issueFromVerifiedAssertion(ticket.assertion, ticket.requestedTenantId, options);
    } catch (error) {
      if (error instanceof IdentityDeniedError) unauthorized();
      unavailable();
    }

    // Session material is only written to Set-Cookie; it never enters this response DTO.
    try {
      this.cookieWriter.set(response, issued);
    } catch {
      unavailable();
    }
    return safePublicContext(issued, context.requestId);
  }
}
