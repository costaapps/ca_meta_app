import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { MonotonicClock } from '../time/clock.port.js';

export interface StructuredLogRecord {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly requestId?: string;
  readonly method?: string;
  readonly route?: string;
  readonly statusCode?: number;
  readonly durationMs?: number;
  readonly code?: string;
  readonly errorType?: string;
}

export interface StructuredLogger {
  write(record: StructuredLogRecord): void;
}

export const STRUCTURED_LOGGER = Symbol('STRUCTURED_LOGGER');
export class ConsoleStructuredLogger implements StructuredLogger {
  write(record: StructuredLogRecord): void {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
}

export function newRequestId(): string {
  return randomUUID();
}

export function requestContextMiddleware(logger: StructuredLogger, clock: MonotonicClock): RequestHandler {
  return (request: Request & { requestId?: string }, response: Response, next: NextFunction): void => {
    // This service accepts direct clients. A client-supplied correlation ID is untrusted,
    // so always generate the value used in response envelopes and structured logs.
    const requestId = newRequestId();
    request.requestId = requestId;
    response.setHeader('X-Request-Id', requestId);
    const startedAt = clock.now();

    response.once('finish', () => {
      const route = request.route?.path;
      logger.write({
        level: response.statusCode >= 500 ? 'error' : response.statusCode >= 400 ? 'warn' : 'info',
        event: 'http.request',
        requestId,
        method: request.method,
        route: typeof route === 'string' ? route : 'unmatched',
        statusCode: response.statusCode,
        durationMs: Math.max(0, Math.round(clock.now() - startedAt)),
      });
    });
    next();
  };
}
