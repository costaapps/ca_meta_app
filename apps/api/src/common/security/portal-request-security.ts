import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import type { ApiEnvironment } from '../../config/environment.js';
import { errorEnvelope } from '../http/error-envelope.js';
import type { PortalSessionVerifier } from '../../identity/identity.trust.js';
import { META_LIFECYCLE_RAW_POST_PATH, META_WEBHOOK_RAW_POST_PATH } from '../../meta-webhooks/meta-webhook-validation.js';
import {
  PORTAL_CSRF_COOKIE,
  PORTAL_SESSION_COOKIE,
  readPortalCookie,
} from '../../identity/portal-session.service.js';

type ContextRequest = Request & { requestId?: string };

function oneHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isExactOrigin(value: string, allowedOrigins: readonly string[]): boolean {
  try {
    const parsed = new URL(value);
    return parsed.origin === value && allowedOrigins.includes(value) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function fail(response: Response, request: ContextRequest, code: 'ORIGIN_NOT_ALLOWED' | 'CSRF_INVALID' | 'AUTH_REQUIRED', status: number): void {
  const details = code === 'AUTH_REQUIRED'
    ? ['Authentication is required.', false, 'SIGN_IN'] as const
    : code === 'CSRF_INVALID'
      ? ['The request security check failed.', false, 'REFRESH'] as const
      : ['This request origin is not allowed.', false, 'CONTACT_ADMIN'] as const;
  response.status(status).json(errorEnvelope(code, details[0], request.requestId ?? 'unknown', details[1], details[2]));
}

function matchesHash(value: string, digest: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(digest)) return false;
  const actual = createHash('sha256').update(value, 'utf8').digest();
  const expected = Buffer.from(digest, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PORTAL_ENTRY_EXCHANGE_PATH = '/api/v1/auth/exchanges';
const PORTAL_PREAUTH_PATH = '/api/v1/auth/preauth';
const MAGIC_LINK_REQUEST_PATH = '/api/v1/auth/magic-links';
const MAGIC_LINK_CONSUME_PATH = '/api/v1/auth/magic-links/consume';
const INTERNAL_SERVICE_OPERATION_POST_PATH =
  /^\/internal\/v2\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/operations$/i;

function isInternalServiceOperationPost(method: string, path: string): boolean {
  return method === 'POST' && INTERNAL_SERVICE_OPERATION_POST_PATH.test(path);
}

/** Exact-origin CORS plus same-origin Fetch Metadata and synchronizer-token checks on authenticated writes. */
export function portalRequestSecurityMiddleware(
  environment: ApiEnvironment,
  verifier: PortalSessionVerifier | undefined,
): RequestHandler {
  const allowedOrigins = new Set(environment.allowedOrigins);
  return async (request: ContextRequest, response: Response, next: NextFunction): Promise<void> => {
    const origin = oneHeader(request.headers.origin);
    if (origin !== undefined) {
      if (!isExactOrigin(origin, [...allowedOrigins])) {
        fail(response, request, 'ORIGIN_NOT_ALLOWED', HttpStatus.FORBIDDEN);
        return;
      }
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader('Access-Control-Expose-Headers', 'ETag');
      response.vary('Origin');
    }

    // Provider callbacks do not use browser Origin/CSRF. This exact contracted
    // ingress path must still be protected by its route's raw-body signature validator.
    if (request.method === 'POST' && origin === undefined &&
      (META_WEBHOOK_RAW_POST_PATH.test(request.path) || META_LIFECYCLE_RAW_POST_PATH.test(request.path))) {
      next();
      return;
    }

    if (request.method === 'OPTIONS') {
      const requestedMethod = oneHeader(request.headers['access-control-request-method']);
      const requestedHeaders = oneHeader(request.headers['access-control-request-headers']);
      const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
      const allowedHeaders = new Set(['content-type', 'x-csrf-token', 'x-tenant-context', 'idempotency-key', 'if-match']);
      const normalizedHeaders = requestedHeaders?.split(',').map((header) => header.trim().toLowerCase()).filter(Boolean) ?? [];
      if (origin === undefined || !requestedMethod || !allowedMethods.has(requestedMethod.toUpperCase()) ||
        normalizedHeaders.some((header) => !allowedHeaders.has(header))) {
        fail(response, request, 'ORIGIN_NOT_ALLOWED', HttpStatus.FORBIDDEN);
        return;
      }
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, X-Tenant-Context, Idempotency-Key, If-Match');
      response.setHeader('Access-Control-Max-Age', '600');
      response.status(HttpStatus.NO_CONTENT).end();
      return;
    }

    if (MUTATING_METHODS.has(request.method)) {
      // Only the service operation POST bypasses browser Origin/CSRF checks; its controller
      // requires a tenant-bound proof before resolving an asset or operation. Status is GET
      // and follows normal safe-method handling; no other mutating method is exempt.
      if (origin === undefined && isInternalServiceOperationPost(request.method, request.path)) {
        next();
        return;
      }
      const requestHostOrigin = `${request.protocol}://${request.get('host') ?? ''}`;
      const fetchSite = oneHeader(request.headers['sec-fetch-site']);
      if (!origin || !isExactOrigin(origin, environment.allowedOrigins) || origin !== requestHostOrigin || fetchSite !== 'same-origin') {
        fail(response, request, 'ORIGIN_NOT_ALLOWED', HttpStatus.FORBIDDEN);
        return;
      }

      // A deliberate one-use link POST is pre-authenticated by its token and exact Origin.
      // An existing portal cookie must not make a native HTML confirmation form require a CSRF header.
      if (request.method === 'POST' && request.path === MAGIC_LINK_CONSUME_PATH) {
        next();
        return;
      }

      // Magic-link initiation is a public, rate-limited entry point. Keep the
      // Origin/Fetch Metadata checks above, but do not let a stale portal
      // session cookie prevent a user from requesting a fresh link. Its route
      // handler continues to enforce identity and delivery quotas.
      if (request.method === 'POST' && request.path === MAGIC_LINK_REQUEST_PATH) {
        next();
        return;
      }

      // Pre-auth creates a browser-bound challenge, not a portal session. Its
      // controller retains the challenge cookie binding and abuse limits; a
      // stale or active prior portal cookie must not require prior-session CSRF.
      if (request.method === 'POST' && request.path === PORTAL_PREAUTH_PATH) {
        next();
        return;
      }

      const sessionCookie = readPortalCookie(oneHeader(request.headers.cookie), PORTAL_SESSION_COOKIE);
      if (sessionCookie) {
        if (!verifier) {
          fail(response, request, 'AUTH_REQUIRED', HttpStatus.UNAUTHORIZED);
          return;
        }
        try {
          const normalizedPath = request.path.toLowerCase().replace(/\/$/, '');
          const ticketExchangeRequest = request.method === 'POST' && normalizedPath === PORTAL_ENTRY_EXCHANGE_PATH;
          const session = ticketExchangeRequest
            ? await verifier.verify(sessionCookie, { touchLastSeen: false })
            : await verifier.verify(sessionCookie);
          const csrfCookie = readPortalCookie(oneHeader(request.headers.cookie), PORTAL_CSRF_COOKIE);
          const csrfHeader = oneHeader(request.headers['x-csrf-token']);
          if (!session) {
            fail(response, request, 'AUTH_REQUIRED', HttpStatus.UNAUTHORIZED);
            return;
          }
          if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader || !matchesHash(csrfHeader, session.csrfTokenHash)) {
            fail(response, request, 'CSRF_INVALID', HttpStatus.FORBIDDEN);
            return;
          }
        } catch (error) {
          next(error);
          return;
        }
      }
    }
    next();
  };
}
