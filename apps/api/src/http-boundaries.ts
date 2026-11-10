import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { json, raw, urlencoded } from 'express';
import type { ApiEnvironment } from './config/environment.js';
import { allowedHostMiddleware } from './common/http/allowed-host.middleware.js';
import { bodyParserErrorMiddleware } from './common/http/body-parser-error.middleware.js';
import { SafeExceptionFilter } from './common/http/safe-exception.filter.js';
import { requestContextMiddleware, STRUCTURED_LOGGER, type StructuredLogger } from './common/http/request-context.js';
import { REQUEST_DRAIN, type RequestDrain } from './common/http/request-drain.js';
import { CLOCK, type MonotonicClock } from './common/time/clock.port.js';
import { portalRequestSecurityMiddleware } from './common/security/portal-request-security.js';
import { PortalSessionVerifier } from './identity/identity.trust.js';
import { META_WEBHOOK_MAX_BODY_BYTES, META_WEBHOOK_RAW_POST_PATH } from './meta-webhooks/meta-webhook-validation.js';

export const API_BODY_LIMIT_BYTES = 65_536;

export function configureHttpBoundaries(app: INestApplication, environment: ApiEnvironment): void {
  const logger = app.get<StructuredLogger>(STRUCTURED_LOGGER);
  const clock = app.get<MonotonicClock>(CLOCK);
  const requestDrain = app.get<RequestDrain>(REQUEST_DRAIN);
  const expressApp = app.getHttpAdapter().getInstance() as import('express').Express;
  expressApp.disable('x-powered-by');
  expressApp.set('trust proxy', environment.trustedProxyCidrs === false ? false : [...environment.trustedProxyCidrs]);

  app.use(requestContextMiddleware(logger, clock));
  app.use((request: import('express').Request, response: import('express').Response, next: import('express').NextFunction) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(allowedHostMiddleware(environment.allowedHosts));
  let sessionVerifier: PortalSessionVerifier | undefined;
  try {
    sessionVerifier = app.get(PortalSessionVerifier, { strict: false });
  } catch {
    sessionVerifier = undefined;
  }
  app.use(portalRequestSecurityMiddleware(environment, sessionVerifier));
  app.use(requestDrain.middleware());
  const metaWebhookRawParser = raw({ type: 'application/json', limit: META_WEBHOOK_MAX_BODY_BYTES, inflate: false });
  app.use((request: import('express').Request, response: import('express').Response, next: import('express').NextFunction) => {
    if (request.method === 'POST' && META_WEBHOOK_RAW_POST_PATH.test(request.path)) {
      metaWebhookRawParser(request, response, next);
      return;
    }
    next();
  });
  app.use(json({ limit: API_BODY_LIMIT_BYTES, strict: true }));
  app.use(urlencoded({ limit: API_BODY_LIMIT_BYTES, extended: false, parameterLimit: 100 }));
  app.use(bodyParserErrorMiddleware(logger));

  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'ready', method: RequestMethod.GET },
    ],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      disableErrorMessages: true,
    }),
  );
  app.useGlobalFilters(app.get(SafeExceptionFilter));
}
