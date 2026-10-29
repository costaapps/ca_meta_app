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
import { STRUCTURED_LOGGER, type StructuredLogger } from './request-context.js';

@Catch()
@Injectable()
export class SafeExceptionFilter implements ExceptionFilter {
  constructor(@Inject(STRUCTURED_LOGGER) private readonly logger: StructuredLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request & { requestId?: string }>();
    const response = context.getResponse<Response>();
    const requestId = request.requestId ?? 'unknown';
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const details = this.safeDetails(status);
    this.logger.write({
      level: status >= 500 ? 'error' : 'warn',
      event: 'http.exception',
      requestId,
      statusCode: status,
      code: details.code,
      errorType: exception instanceof HttpException ? 'HttpException' : 'UnhandledException',
    });

    response.status(status).json(
      errorEnvelope(details.code, details.safeMessage, requestId, details.retryable, details.action),
    );
  }

  private safeDetails(status: number): {
    code: 'AUTH_REQUIRED' | 'ACCESS_DENIED' | 'RESOURCE_NOT_AVAILABLE' | 'VALIDATION_FAILED' | 'PAYLOAD_TOO_LARGE' | 'DEPENDENCY_UNAVAILABLE';
    safeMessage: string;
    retryable: boolean;
    action: 'SIGN_IN' | 'CONTACT_ADMIN' | 'REFRESH' | 'FIX_REQUEST' | 'REDUCE_REQUEST' | 'RELOAD_PORTAL' | 'CHECK_STATUS';
  } {
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
    return { code: 'DEPENDENCY_UNAVAILABLE', safeMessage: 'The service is temporarily unavailable.', retryable: true, action: 'RELOAD_PORTAL' };
  }
}