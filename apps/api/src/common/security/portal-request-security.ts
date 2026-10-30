import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import type { ApiEnvironment } from '../../config/environment.js';
import { errorEnvelope } from '../http/error-envelope.js';
import type { PortalSessionVerifier } from '../../identity/identity.trust.js';
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
const META_WEBHOOK_INGRESS_PATH = /^\/api\/v1\/webhooks\/meta\/[A-Za-z0-9_-]{1,128}$/;
const PORTAL_ENTRY_EXCHANGE_PATH = '/api/v1/auth/exchanges';

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
      response.vary('Origin');
    }

    // Provider callbacks do not use browser Origin/CSRF. This exact contracted
    // ingress path must still be protected by its route's raw-body signature validator.
    if (request.method === 'POST' && origin === undefined && META_WEBHOOK_INGRESS_PATH.test(request.path)) {
      next();
      return;
    }

    if (request.method === 'OPTIONS') {
      const requestedMethod = oneHeader(request.headers['access-control-request-method']);
      const requestedHeaders = oneHeader(request.headers['access-control-request-headers']);
      const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
      const allowedHeaders = new Set(['content-type', 'x-csrf-token', 'x-tenant-context', 'idempotency-key']);
      const normalizedHeaders = requestedHeaders?.split(',').map((header) => header.trim().toLowerCase()).filter(Boolean) ?? [];
      if (origin === undefined || !requestedMethod || !allowedMethods.has(requestedMethod.toUpperCase()) ||
        normalizedHeaders.some((header) => !allowedHeaders.has(header))) {
        fail(response, request, 'ORIGIN_NOT_ALLOWED', HttpStatus.FORBIDDEN);
        return;
      }
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, X-Tenant-Context, Idempotency-Key');
      response.setHeader('Access-Control-Max-Age', '600');
      response.status(HttpStatus.NO_CONTENT).end();
      return;
    }

    if (MUTATING_METHODS.has(request.method)) {
      const requestHostOrigin = `${request.protocol}://${request.get('host') ?? ''}`;
      const fetchSite = oneHeader(request.headers['sec-fetch-site']);
      if (!origin || !isExactOrigin(origin, environment.allowedOrigins) || origin !== requestHostOrigin || fetchSite !== 'same-origin') {
        fail(response, request, 'ORIGIN_NOT_ALLOWED', HttpStatus.FORBIDDEN);
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
