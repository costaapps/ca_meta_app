import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { ApiEnvironment } from './config/environment.js';
import { SafeExceptionFilter } from './common/http/safe-exception.filter.js';
import { ConsoleStructuredLogger, STRUCTURED_LOGGER } from './common/http/request-context.js';
import { REQUEST_DRAIN, RequestDrain } from './common/http/request-drain.js';
import { RequestDrainInterceptor } from './common/http/request-drain.interceptor.js';
import { DenyByDefaultGuard } from './common/security/deny-by-default.guard.js';
import { CLOCK, SystemMonotonicClock } from './common/time/clock.port.js';
import { HealthModule } from './health/health.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { AuthExchangeModule } from './auth-exchange/auth-exchange.module.js';
import { ConfiguredTicketKeySet } from './auth-exchange/configured-ticket-key-set.js';
import type { AuthExchangeCookieWriter } from './auth-exchange/ticket-contract.js';
import { PortalSessionIssuer, setPortalSessionCookies } from './identity/portal-session.service.js';
import { PortalPreAuthService } from './identity/portal-session.service.js';
import { PortalSessionVerifier } from './identity/identity.trust.js';
import { AbuseLimitService } from './common/security/abuse-limits.js';
import { MetaAssetsModule } from './meta-assets/meta-assets.module.js';
import { MagicLinkModule } from './auth/magic-link.module.js';
import { OnboardingStatusModule } from './onboarding/onboarding-status.module.js';

@Module({})
export class ApiModule {
  static register(environment: ApiEnvironment): DynamicModule {
    const identityModule = IdentityModule.register(environment);
    const ticket = environment.portalEntryTicket;
    const authExchangeModule = ticket
      ? AuthExchangeModule.register({
        imports: [identityModule],
        configuration: ticket.configuration,
        trustedKeySet: new ConfiguredTicketKeySet(ticket.publicKeys),
        allowedOrigins: environment.allowedOrigins,
        allowInsecureLoopbackOrigins: ticket.allowInsecureLoopbackOrigins,
        preAuthServiceToken: PortalPreAuthService,
        sessionIssuerToken: PortalSessionIssuer,
        sessionVerifierToken: PortalSessionVerifier,
        abuseLimitServiceToken: AbuseLimitService,
        cookieWriter: { set: setPortalSessionCookies } satisfies AuthExchangeCookieWriter,
      })
      : AuthExchangeModule.register();
    return {
      module: ApiModule,
      imports: [
        HealthModule.register(environment),
        MetaAssetsModule.register(environment),
        identityModule,
        authExchangeModule,
        MagicLinkModule.register(environment),
        OnboardingStatusModule.register(identityModule),
      ],
      providers: [
        { provide: STRUCTURED_LOGGER, useClass: ConsoleStructuredLogger },
        { provide: CLOCK, useClass: SystemMonotonicClock },
        { provide: REQUEST_DRAIN, useClass: RequestDrain },
        { provide: APP_GUARD, useClass: DenyByDefaultGuard },
        { provide: APP_INTERCEPTOR, useClass: RequestDrainInterceptor },
        SafeExceptionFilter,
      ],
      exports: [REQUEST_DRAIN],
    };
  }
}
