import { errorEnvelope } from './error-envelope.js';
import type { StructuredLogger } from './request-context.js';
import type { ErrorRequestHandler } from 'express';

interface BodyParserError extends Error {
  readonly status?: number;
  readonly type?: string;
}

export function bodyParserErrorMiddleware(logger: StructuredLogger): ErrorRequestHandler {
  return (error: BodyParserError, request, response, next): void => {
    if (response.headersSent) {
      next(error);
      return;
    }

    const requestId = (request as typeof request & { requestId?: string }).requestId ?? 'unknown';
    const tooLarge = error.type === 'entity.too.large' || error.status === 413;
    const status = tooLarge ? 413 : 400;
    const code = tooLarge ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_FAILED';
    logger.write({ level: 'warn', event: 'http.body_rejected', requestId, statusCode: status, code });
    response.status(status).json(
      tooLarge
        ? errorEnvelope(code, 'The submitted content is too large.', requestId, false, 'REDUCE_REQUEST')
        : errorEnvelope(code, 'Check the submitted fields.', requestId, false, 'FIX_REQUEST'),
    );
  };
}
