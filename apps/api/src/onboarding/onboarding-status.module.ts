import { DynamicModule, Module } from '@nestjs/common';
import type { ApiEnvironment } from '../config/environment.js';
import { PortalSessionVerifier } from '../identity/identity.trust.js';
import { TenantAuthorizationService, TenantContextService } from '../identity/identity.service.js';
import { PortalSessionGuard } from '../identity/portal-session.guard.js';
import {
  ONBOARDING_COMPLETION_PORT,
  ONBOARDING_PROVIDER_LAUNCH,
  ONBOARDING_SESSION_STORE,
} from './onboarding-session.types.js';
import { OnboardingCompletionService, OnboardingSessionService, OnboardingStateSigner, UnavailableOnboardingProviderLaunch } from './onboarding-session.service.js';
import { MysqlOnboardingSessionStore } from './mysql-onboarding-session.store.js';
import { ONBOARDING_STATUS_READER, OnboardingStatusController } from './onboarding-status.controller.js';

@Module({})
export class OnboardingStatusModule {
  static register(identityModule: DynamicModule, environment: ApiEnvironment): DynamicModule {
    return {
      module: OnboardingStatusModule,
      imports: [identityModule],
      controllers: [OnboardingStatusController],
      providers: [
        {
          provide: PortalSessionGuard,
          useFactory: (sessions: PortalSessionVerifier) => new PortalSessionGuard(sessions),
          inject: [PortalSessionVerifier],
        },
        { provide: ONBOARDING_SESSION_STORE, useFactory: () => new MysqlOnboardingSessionStore(environment.database) },
        { provide: OnboardingStateSigner, useValue: new OnboardingStateSigner(environment.onboardingStateSigningKey) },
        { provide: ONBOARDING_PROVIDER_LAUNCH, useClass: UnavailableOnboardingProviderLaunch },
        {
          provide: OnboardingSessionService,
          useFactory: (
            store: MysqlOnboardingSessionStore,
            contexts: TenantContextService,
            authorization: TenantAuthorizationService,
            signer: OnboardingStateSigner,
            launch: UnavailableOnboardingProviderLaunch,
          ) => new OnboardingSessionService(store, contexts, authorization, signer, launch),
          inject: [ONBOARDING_SESSION_STORE, TenantContextService, TenantAuthorizationService,
            OnboardingStateSigner, ONBOARDING_PROVIDER_LAUNCH],
        },
        { provide: ONBOARDING_STATUS_READER, useExisting: OnboardingSessionService },
        {
          provide: OnboardingCompletionService,
          useFactory: (store: MysqlOnboardingSessionStore) => new OnboardingCompletionService(store),
          inject: [ONBOARDING_SESSION_STORE],
        },
        { provide: ONBOARDING_COMPLETION_PORT, useExisting: OnboardingCompletionService },
      ],
      exports: [ONBOARDING_COMPLETION_PORT, OnboardingCompletionService],
    };
  }
}
