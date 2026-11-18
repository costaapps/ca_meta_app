import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { errorEnvelope } from './error-envelope.js';
import type { ErrorAction, ErrorCode } from './error-envelope.js';
import { STRUCTURED_LOGGER, type StructuredLogger } from './request-context.js';
import { IdentityDeniedError } from '../../identity/identity.errors.js';
import { SafeBoundaryError } from '../security/security.errors.js';
import { OnboardingCoexistenceActiveSessionConflictError } from '../../onboarding/onboarding-session.types.js';

@Catch()
@Injectable()
export class SafeExceptionFilter implements ExceptionFilter {
  constructor(@Inject(STRUCTURED_LOGGER) private readonly logger: StructuredLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request & { requestId?: string }>();
    const response = context.getResponse<Response>();
    const requestId = request.requestId ?? 'unknown';
    const status = exception instanceof OnboardingCoexistenceActiveSessionConflictError
      ? HttpStatus.CONFLICT
      : exception instanceof IdentityDeniedError
      ? exception.code === 'CONTEXT_CHANGED' ? HttpStatus.CONFLICT : HttpStatus.FORBIDDEN
      : exception instanceof SafeBoundaryError
        ? exception.code === 'RATE_LIMITED' ? HttpStatus.TOO_MANY_REQUESTS : HttpStatus.FORBIDDEN
        : exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const details = this.safeDetails(status, exception);
    if (status === HttpStatus.TOO_MANY_REQUESTS) response.setHeader('Retry-After', '60');
    this.logger.write({
      level: status >= 500 ? 'error' : 'warn',
      event: 'http.exception',
      requestId,
      statusCode: status,
      code: details.code,
      errorType: exception instanceof OnboardingCoexistenceActiveSessionConflictError ? 'OnboardingCoexistenceActiveSessionConflictError' :
        exception instanceof IdentityDeniedError ? 'IdentityDeniedError' :
        exception instanceof SafeBoundaryError ? 'SafeBoundaryError' :
          exception instanceof HttpException ? 'HttpException' : 'UnhandledException',
    });

    response.status(status).json(
      errorEnvelope(details.code, details.safeMessage, requestId, details.retryable, details.action),
    );
  }

  private safeDetails(status: number, exception: unknown): {
    code: ErrorCode;
    safeMessage: string;
    retryable: boolean;
    action: ErrorAction;
  } {
    if (exception instanceof OnboardingCoexistenceActiveSessionConflictError) {
      return { code: 'COEXISTENCE_SESSION_ACTIVE', safeMessage: 'A WhatsApp Coexistence onboarding session is already active for this company.', retryable: false, action: 'CHECK_STATUS' };
    }
    if (exception instanceof IdentityDeniedError && exception.code === 'CONTEXT_CHANGED') {
      return { code: 'CONTEXT_CHANGED', safeMessage: 'The tenant context has changed. Reload the current session context.', retryable: false, action: 'REFRESH' };
    }
    if (exception instanceof SafeBoundaryError) {
      if (exception.code === 'RATE_LIMITED') {
        return { code: 'RATE_LIMITED', safeMessage: 'Too many requests. Try again later.', retryable: true, action: 'WAIT' };
      }
      if (exception.code === 'CSRF_INVALID') {
        return { code: 'CSRF_INVALID', safeMessage: 'The request security check failed.', retryable: false, action: 'RELOAD_PORTAL' };
      }
      return { code: 'ORIGIN_NOT_ALLOWED', safeMessage: 'This request origin is not allowed.', retryable: false, action: 'RELOAD_PORTAL' };
    }
    if (exception instanceof IdentityDeniedError) {
      return { code: 'ACCESS_DENIED', safeMessage: 'This action is not available for the current account.', retryable: false, action: 'CONTACT_ADMIN' };
    }
    if (status === HttpStatus.UNAUTHORIZED) {
      return { code: 'AUTH_REQUIRED', safeMessage: 'Authentication is required.', retryable: false, action: 'SIGN_IN' };
    }
    if (status === HttpStatus.FORBIDDEN) {
      return { code: 'ACCESS_DENIED', safeMessage: 'This action is not available for the current account.', retryable: false, action: 'CONTACT_ADMIN' };
    }
    if (status === HttpStatus.NOT_FOUND) {
      return { code: 'RESOURCE_NOT_AVAILABLE', safeMessage: 'The requested resource is not available.', retryable: false, action: 'REFRESH' };
    }
    if (status === HttpStatus.BAD_REQUEST || status === HttpStatus.UNPROCESSABLE_ENTITY) {
      return { code: 'VALIDATION_FAILED', safeMessage: 'Check the submitted fields.', retryable: false, action: 'FIX_REQUEST' };
    }
    if (status === HttpStatus.PAYLOAD_TOO_LARGE) {
      return { code: 'PAYLOAD_TOO_LARGE', safeMessage: 'The submitted content is too large.', retryable: false, action: 'REDUCE_REQUEST' };
    }
    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
      return { code: 'DEPENDENCY_UNAVAILABLE', safeMessage: 'The operation could not be confirmed yet.', retryable: true, action: 'CHECK_STATUS' };
    }
    if (status === HttpStatus.TOO_MANY_REQUESTS) {
      return { code: 'RATE_LIMITED', safeMessage: 'Too many requests. Try again later.', retryable: true, action: 'WAIT' };
    }
    return { code: 'INTERNAL_ERROR', safeMessage: 'The service could not complete this request.', retryable: false, action: 'CONTACT_ADMIN' };
  }
}
