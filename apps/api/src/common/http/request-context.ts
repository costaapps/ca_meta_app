import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { MonotonicClock } from '../time/clock.port.js';
import { redactStructuredLogRecord } from '../../privacy/redaction.js';
import type { ObservabilityRegistry } from '../../observability/observability.registry.js';

export interface StructuredLogRecord {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly method?: string;
  readonly route?: string;
  readonly statusCode?: number;
  readonly durationMs?: number;
  readonly code?: string;
  readonly errorType?: string;
  readonly operation?: string;
  readonly product?: string;
  readonly environment?: string;
  readonly outcome?: string;
  readonly category?: string;
}

export interface StructuredLogger {
  write(record: StructuredLogRecord): void;
}

type RequestWithObservedDuration = Request & { observabilityRequestDurationMs?: () => number };

/** Returns the monotonic request lifetime captured before body parsing, if the middleware ran. */
export function observedRequestDurationMs(request: Request): number | undefined {
  const readDuration = (request as RequestWithObservedDuration).observabilityRequestDurationMs;
  return typeof readDuration === 'function' ? readDuration() : undefined;
}

export const STRUCTURED_LOGGER = Symbol('STRUCTURED_LOGGER');
export class ConsoleStructuredLogger implements StructuredLogger {
  write(record: StructuredLogRecord): void {
    process.stdout.write(`${JSON.stringify(redactStructuredLogRecord({ ...record }))}\n`);
  }
}

export function newRequestId(): string {
  return randomUUID();
}

export function requestContextMiddleware(
  logger: StructuredLogger,
  clock: MonotonicClock,
  observability: ObservabilityRegistry,
): RequestHandler {
  return (request: Request & { requestId?: string; correlationId?: string }, response: Response, next: NextFunction): void => {
    // This service accepts direct clients. A client-supplied correlation ID is untrusted,
    // so always generate the value used in response envelopes and structured logs.
    const requestId = newRequestId();
    request.requestId = requestId;
    request.correlationId = requestId;
    response.setHeader('X-Request-Id', requestId);
    const startedAt = clock.now();
    (request as RequestWithObservedDuration).observabilityRequestDurationMs = () =>
      Math.max(0, Math.round(clock.now() - startedAt));

    response.once('finish', () => {
      const route = request.route?.path;
      const durationMs = observedRequestDurationMs(request) ?? 0;
      const metrics = observability.recordHttpRequest({ path: request.path, method: request.method,
        statusCode: response.statusCode, durationMs });
      logger.write({
        level: response.statusCode >= 500 ? 'error' : response.statusCode >= 400 ? 'warn' : 'info',
        event: 'http.request',
        requestId,
        correlationId: requestId,
        method: request.method,
        route: typeof route === 'string' ? route : 'unmatched',
        statusCode: response.statusCode,
        durationMs,
        outcome: metrics.outcome,
      });
    });
    next();
  };
}
