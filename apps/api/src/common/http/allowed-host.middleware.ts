import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isIP } from 'node:net';
import { errorEnvelope } from './error-envelope.js';

function normalizeHostname(value: string): string | undefined {
  if (isIP(value) !== 0) return value.toLowerCase();
  const hostname = value.endsWith('.') ? value.slice(0, -1) : value;
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    !hostname.split('.').every((label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    )
  ) {
    return undefined;
  }
  return hostname.toLowerCase();
}

export function parseRequestHost(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value !== value.trim()) return undefined;

  let hostname: string;
  let port: string | undefined;
  if (value.startsWith('[')) {
    const match = /^\[([0-9a-f:.]+)\](?::([0-9]{1,5}))?$/i.exec(value);
    if (!match || isIP(match[1]) !== 6) return undefined;
    hostname = match[1];
    port = match[2];
  } else {
    const match = /^([^:[\]]+)(?::([0-9]{1,5}))?$/.exec(value);
    if (!match) return undefined;
    hostname = match[1];
    port = match[2];
  }

  if (port !== undefined) {
    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) return undefined;
  }
  return normalizeHostname(hostname);
}

export function allowedHostMiddleware(allowedHosts: readonly string[]): RequestHandler {
  const allowlist = new Set(allowedHosts);
  return (
    request: Request & { requestId?: string },
    response: Response,
    next: NextFunction,
  ): void => {
    const host = parseRequestHost(request.headers.host);
    if (host !== undefined && allowlist.has(host)) {
      next();
      return;
    }
    response.status(403).json(
      errorEnvelope(
        'HOST_NOT_ALLOWED',
        'This request host is not allowed.',
        request.requestId ?? 'unknown',
        false,
        'CONTACT_ADMIN',
      ),
    );
  };
}
