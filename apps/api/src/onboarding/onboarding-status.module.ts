import { DynamicModule, Module, ServiceUnavailableException } from '@nestjs/common';
import { PortalSessionVerifier } from '../identity/identity.trust.js';
import { PortalSessionGuard } from '../identity/portal-session.guard.js';
import type { VerifiedPortalSession } from '../identity/identity.trust.js';
import { ONBOARDING_STATUS_READER, OnboardingStatusController, type OnboardingStatusReader } from './onboarding-status.controller.js';

export class UnavailableOnboardingStatusReader implements OnboardingStatusReader {
  async read(_session: VerifiedPortalSession, _onboardingId: string, _tenantContextRef: string): Promise<undefined> {
    throw new ServiceUnavailableException();
  }
}

@Module({})
export class OnboardingStatusModule {
  static register(identityModule: DynamicModule): DynamicModule {
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
        { provide: ONBOARDING_STATUS_READER, useClass: UnavailableOnboardingStatusReader },
      ],
    };
  }
}
