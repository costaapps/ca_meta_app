import { BadRequestException, Controller, DynamicModule, HttpCode, HttpStatus, Module, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import {
  AUTH_EXCHANGE_ALLOWED_ORIGINS,
  AUTH_EXCHANGE_ABUSE_LIMIT,
  AUTH_EXCHANGE_CONFIGURATION,
  AUTH_EXCHANGE_COOKIE_WRITER,
  AUTH_EXCHANGE_KEY_SET,
  AUTH_EXCHANGE_PORTAL_PREAUTH,
  AUTH_EXCHANGE_SESSION_ISSUER,
  AUTH_EXCHANGE_SESSION_VERIFIER,
  AUTH_EXCHANGE_TEST_LOOPBACK_ORIGINS,
  type AuthExchangeCookieWriter,
  type AuthExchangeModuleOptions,
  type PortalPreAuthServicePort,
  type PortalExchangeAbuseLimitPort,
  type PortalSessionIssuerPort,
  type PortalSessionVerifierPort,
} from './ticket-contract.js';
import { TicketExchangeController } from './ticket-exchange.controller.js';
import { TicketExchangeService } from './ticket-exchange.service.js';

@Controller('auth/exchanges')
class TicketExchangeUnavailableController {
  @Post()
  @HttpCode(HttpStatus.SERVICE_UNAVAILABLE)
  @PublicRoute()
  unavailable(@Req() request: Request): never {
    if (request.originalUrl.includes('?')) throw new BadRequestException();
    throw new ServiceUnavailableException();
  }
}

@Module({})
export class AuthExchangeModule {
  static register(options?: AuthExchangeModuleOptions): DynamicModule {
    if (!options) {
      return {
        module: AuthExchangeModule,
        controllers: [TicketExchangeUnavailableController],
      };
    }
    return {
      module: AuthExchangeModule,
      imports: [...(options.imports ?? [])],
      controllers: [TicketExchangeController],
      providers: [
        { provide: AUTH_EXCHANGE_CONFIGURATION, useValue: options.configuration },
        { provide: AUTH_EXCHANGE_KEY_SET, useValue: options.trustedKeySet },
        { provide: AUTH_EXCHANGE_ALLOWED_ORIGINS, useValue: Object.freeze([...options.allowedOrigins]) },
        { provide: AUTH_EXCHANGE_TEST_LOOPBACK_ORIGINS, useValue: options.allowInsecureLoopbackOrigins === true },
        { provide: AUTH_EXCHANGE_PORTAL_PREAUTH, useExisting: options.preAuthServiceToken },
        { provide: AUTH_EXCHANGE_SESSION_ISSUER, useExisting: options.sessionIssuerToken },
        { provide: AUTH_EXCHANGE_SESSION_VERIFIER, useExisting: options.sessionVerifierToken },
        { provide: AUTH_EXCHANGE_ABUSE_LIMIT, useExisting: options.abuseLimitServiceToken },
        { provide: AUTH_EXCHANGE_COOKIE_WRITER, useValue: options.cookieWriter },
        {
          provide: TicketExchangeService,
          useFactory: (
            configuration: AuthExchangeModuleOptions['configuration'],
            keySet: AuthExchangeModuleOptions['trustedKeySet'],
            allowedOrigins: AuthExchangeModuleOptions['allowedOrigins'],
            preAuth: PortalPreAuthServicePort,
            sessions: PortalSessionIssuerPort,
            sessionVerifier: PortalSessionVerifierPort,
            abuseLimit: PortalExchangeAbuseLimitPort,
            cookieWriter: AuthExchangeCookieWriter,
            allowInsecureLoopbackOrigins: boolean,
          ) => new TicketExchangeService(
            configuration,
            keySet,
            allowedOrigins,
            preAuth,
            sessions,
            sessionVerifier,
            abuseLimit,
            cookieWriter,
            Date.now,
            allowInsecureLoopbackOrigins,
          ),
          inject: [
            AUTH_EXCHANGE_CONFIGURATION,
            AUTH_EXCHANGE_KEY_SET,
            AUTH_EXCHANGE_ALLOWED_ORIGINS,
            AUTH_EXCHANGE_PORTAL_PREAUTH,
            AUTH_EXCHANGE_SESSION_ISSUER,
            AUTH_EXCHANGE_SESSION_VERIFIER,
            AUTH_EXCHANGE_ABUSE_LIMIT,
            AUTH_EXCHANGE_COOKIE_WRITER,
            AUTH_EXCHANGE_TEST_LOOPBACK_ORIGINS,
          ],
        },
      ],
      exports: [TicketExchangeService],
    };
  }
}
