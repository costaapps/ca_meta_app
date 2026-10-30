import { BadRequestException, Controller, Get, Headers, Inject, Param, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import type { components } from '@ca-meta/contracts';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import { PortalSessionGuard, type PortalRequest } from '../identity/portal-session.guard.js';
import { PORTAL_CONTEXT_COOKIE, readPortalCookie } from '../identity/portal-session.service.js';
import type { VerifiedPortalSession } from '../identity/identity.trust.js';

export type OnboardingStatusSnapshot = Omit<components['schemas']['OnboardingStatus'], 'requestId'>;

export const ONBOARDING_STATUS_READER = Symbol('ONBOARDING_STATUS_READER');

/** Read-only boundary; implementations must resolve the onboarding under the verified server session. */
export interface OnboardingStatusReader {
  read(
    session: VerifiedPortalSession,
    onboardingId: string,
    tenantContextRef: string,
  ): Promise<OnboardingStatusSnapshot | undefined>;
}

@Controller('onboarding-sessions')
export class OnboardingStatusController {
  constructor(@Inject(ONBOARDING_STATUS_READER) private readonly statusReader: OnboardingStatusReader) {}

  @Get(':onboardingSessionId')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async read(
    @Param('onboardingSessionId') onboardingId: string,
    @Req() request: PortalRequest,
    @Headers('x-tenant-context') headerContext?: string,
  ): Promise<components['schemas']['OnboardingStatus']> {
    if (request.originalUrl.includes('?') || !/^[A-Za-z0-9_-]{1,128}$/.test(onboardingId)) {
      throw new BadRequestException();
    }
    const tenantContextRef = headerContext ?? readPortalCookie(request.headers.cookie, PORTAL_CONTEXT_COOKIE);
    if (!tenantContextRef || !/^[A-Za-z0-9_-]{16,512}$/.test(tenantContextRef)) throw new BadRequestException();

    let status: OnboardingStatusSnapshot | undefined;
    try {
      status = await this.statusReader.read(request.portalSession, onboardingId, tenantContextRef);
    } catch {
      // The state store is not part of M3.05 yet. Never treat callback/redirect data as success.
      throw new ServiceUnavailableException();
    }
    if (!status) throw new ServiceUnavailableException();
    if (status.id !== onboardingId) throw new ServiceUnavailableException();
    return Object.freeze({ ...status, requestId: request.requestId ?? 'unknown' });
  }
}
