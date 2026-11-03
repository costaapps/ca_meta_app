import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsString,
  Matches,
} from 'class-validator';
import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { components } from '@ca-meta/contracts';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import { AbuseLimitService } from '../common/security/abuse-limits.js';
import { PortalSessionGuard, type PortalRequest } from '../identity/portal-session.guard.js';
import { PORTAL_CONTEXT_COOKIE, readPortalCookie } from '../identity/portal-session.service.js';
import type { VerifiedPortalSession } from '../identity/identity.trust.js';
import { OnboardingConfigurationUnavailableError, OnboardingConflictError } from './onboarding-session.types.js';
import type { OnboardingCreateInput } from './onboarding-session.types.js';
import { OnboardingSessionService } from './onboarding-session.service.js';

export type OnboardingStatusSnapshot = Omit<components['schemas']['OnboardingStatus'], 'requestId'>;
export const ONBOARDING_STATUS_READER = Symbol('ONBOARDING_STATUS_READER');

export interface OnboardingStatusReader {
  read(session: VerifiedPortalSession, onboardingId: string, currentTenantContextRef: string): Promise<OnboardingStatusSnapshot | undefined>;
}

const FLOW_VARIANTS: readonly components['schemas']['FlowVariant'][] = [
  'FACEBOOK_LOGIN', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN', 'WHATSAPP_CLOUD_API', 'WHATSAPP_COEXISTENCE',
];

export class CreateOnboardingSessionRequest implements OnboardingCreateInput {
  @IsIn(FLOW_VARIANTS)
  flowVariant!: components['schemas']['FlowVariant'];

  @IsArray()
  @ArrayMaxSize(32)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(/^[A-Z][A-Z0-9_]{0,63}$/, { each: true })
  requestedCapabilities!: string[];

  @IsIn(['connections', 'setup'])
  returnRoute!: 'connections' | 'setup';
}

@Controller('onboarding-sessions')
export class OnboardingStatusController {
  constructor(
    @Inject(ONBOARDING_STATUS_READER) private readonly statusReader: OnboardingStatusReader,
    private readonly onboarding: OnboardingSessionService,
    private readonly abuseLimits: AbuseLimitService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async create(
    @Body() body: CreateOnboardingSessionRequest,
    @Req() request: PortalRequest,
    @Headers('x-tenant-context') headerContext?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<components['schemas']['OnboardingCreated']> {
    if (request.originalUrl.includes('?')) throw new BadRequestException();
    const tenantContextRef = headerContext ?? readPortalCookie(request.headers.cookie, PORTAL_CONTEXT_COOKIE);
    if (!tenantContextRef || !/^[A-Za-z0-9._~-]{16,512}$/.test(tenantContextRef) ||
      !idempotencyKey || !/^[A-Za-z0-9._~-]{16,128}$/.test(idempotencyKey)) throw new BadRequestException();
    try {
      await this.abuseLimits.consume('ONBOARDING_START', {
        ip: request.ip,
        actor: request.portalSession.principalId,
        tenant: request.portalSession.tenantId,
      });
      const created = await this.onboarding.create(request.portalSession, tenantContextRef, idempotencyKey, body);
      return Object.freeze({ ...created, requestId: request.requestId ?? 'unknown' });
    } catch (error) {
      if (error instanceof OnboardingConflictError) throw new ConflictException();
      if (error instanceof OnboardingConfigurationUnavailableError) throw new ServiceUnavailableException();
      throw error;
    }
  }

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
    if (!tenantContextRef || !/^[A-Za-z0-9._~-]{16,512}$/.test(tenantContextRef)) throw new BadRequestException();

    await this.abuseLimits.consume('SESSION_STATUS', {
      ip: request.ip,
      actor: request.portalSession.principalId,
      tenant: request.portalSession.tenantId,
    });

    let status: OnboardingStatusSnapshot | undefined;
    try {
      status = await this.statusReader.read(request.portalSession, onboardingId, tenantContextRef);
    } catch {
      // Persistence failure never turns a browser return signal into onboarding success.
      throw new ServiceUnavailableException();
    }
    if (!status) throw new NotFoundException();
    if (status.id !== onboardingId) throw new ServiceUnavailableException();
    return Object.freeze({ ...status, requestId: request.requestId ?? 'unknown' });
  }
}
