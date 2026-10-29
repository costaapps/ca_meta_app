import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { json, urlencoded } from 'express';
import type { ApiEnvironment } from './config/environment.js';
import { bodyParserErrorMiddleware } from './common/http/body-parser-error.middleware.js';
import { SafeExceptionFilter } from './common/http/safe-exception.filter.js';
import { requestContextMiddleware, STRUCTURED_LOGGER, type StructuredLogger } from './common/http/request-context.js';
import { CLOCK, type MonotonicClock } from './common/time/clock.port.js';

export const API_BODY_LIMIT_BYTES = 65_536;

export function configureHttpBoundaries(app: INestApplication, environment: ApiEnvironment): void {
  const logger = app.get<StructuredLogger>(STRUCTURED_LOGGER);
  const clock = app.get<MonotonicClock>(CLOCK);
  const expressApp = app.getHttpAdapter().getInstance() as import('express').Express;
  expressApp.disable('x-powered-by');
  expressApp.set('trust proxy', environment.trustedProxyCidrs === false ? false : [...environment.trustedProxyCidrs]);

  app.use(requestContextMiddleware(logger, clock));
  app.use((request: import('express').Request, response: import('express').Response, next: import('express').NextFunction) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
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
