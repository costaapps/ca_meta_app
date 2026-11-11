import { IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import { AbuseLimitService } from '../common/security/abuse-limits.js';
import { PortalSessionGuard, type PortalRequest } from '../identity/portal-session.guard.js';
import { PORTAL_CONTEXT_COOKIE, readPortalCookie } from '../identity/portal-session.service.js';
import { OnboardingConfigurationUnavailableError } from './onboarding-session.types.js';
import {
  OnboardingCodeConflictError,
  OnboardingCodeNotFoundError,
  OnboardingCodeSubmissionService,
  type MetaCallbackVariant,
} from './onboarding-code-submission.service.js';
import { OnboardingRecoveryConflictError, OnboardingRecoveryNotFoundError,
  OnboardingSagaRecoveryService, type OnboardingRecoveryAction, type OnboardingSagaStage } from './onboarding-saga-recovery.js';

export class ProviderAuthorizationCodeRequest {
  @IsString()
  @MinLength(1)
  @MaxLength(16_384)
  authorizationCode!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9_-]{32,128}$/)
  stateRef!: string;
}

const RECOVERY_STAGES: readonly OnboardingSagaStage[] = ['authorization', 'asset-verification', 'subscription', 'projection'];

export class OnboardingRecoveryRequest {
  @IsIn(['RESUME', 'RECONCILE'])
  action!: OnboardingRecoveryAction;

  @IsIn(RECOVERY_STAGES)
  stage!: OnboardingSagaStage;
}

const CALLBACK_VARIANTS: readonly MetaCallbackVariant[] = [
  'facebook-login', 'instagram-via-facebook-login', 'instagram-login', 'whatsapp-cloud-api', 'whatsapp-coexistence',
];

@Controller('onboarding-sessions')
export class OnboardingCodeSubmissionController {
  constructor(
    private readonly service: OnboardingCodeSubmissionService,
    private readonly abuseLimits: AbuseLimitService,
  ) {}

  @Post(':onboardingSessionId/authorization-code')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async submit(
    @Param('onboardingSessionId') onboardingId: string,
    @Body() body: ProviderAuthorizationCodeRequest,
    @Req() request: PortalRequest,
    @Res({ passthrough: true }) response: Response,
    @Headers('x-tenant-context') headerContext?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (request.originalUrl.includes('?') || !/^[A-Za-z0-9_-]{1,128}$/.test(onboardingId) ||
      !idempotencyKey || !/^[A-Za-z0-9._~-]{16,128}$/.test(idempotencyKey) ||
      !body || Object.keys(body).some((key) => key !== 'authorizationCode' && key !== 'stateRef') ||
      typeof body.authorizationCode !== 'string' || body.authorizationCode.length < 1 || body.authorizationCode.length > 16_384 ||
      typeof body.stateRef !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(body.stateRef)) throw new BadRequestException();
    const tenantContextRef = headerContext ?? readPortalCookie(request.headers.cookie, PORTAL_CONTEXT_COOKIE);
    if (!tenantContextRef || !/^[A-Za-z0-9._~-]{16,512}$/.test(tenantContextRef)) throw new BadRequestException();
    try {
      await this.abuseLimits.consume('ONBOARDING_START', {
        ip: request.ip,
        actor: request.portalSession.principalId,
        tenant: request.portalSession.tenantId,
      });
      const accepted = await this.service.submit(request.portalSession, tenantContextRef, onboardingId,
        idempotencyKey, body);
      const location = `/api/v1/jobs/${accepted.jobId}`;
      response.setHeader('Location', location);
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      return Object.freeze({ jobId: accepted.jobId, status: 'PENDING' as const, location,
        requestId: request.requestId ?? 'unknown' });
    } catch (error) {
      if (error instanceof OnboardingCodeNotFoundError) throw new NotFoundException();
      if (error instanceof OnboardingCodeConflictError) throw new ConflictException();
      if (error instanceof OnboardingConfigurationUnavailableError) throw new ServiceUnavailableException();
      throw error;
    }
  }
}

@Controller('meta')
export class MetaProviderCallbackController {
  constructor(
    private readonly service: OnboardingCodeSubmissionService,
    private readonly abuseLimits: AbuseLimitService,
  ) {}

  @Get(':variant/callback')
  @HttpCode(HttpStatus.SEE_OTHER)
  @PublicRoute()
  async callback(
    @Param('variant') variant: string,
    @Query() query: Record<string, unknown>,
    @Req() request: PortalRequest,
    @Res() response: Response,
  ): Promise<void> {
    if (!CALLBACK_VARIANTS.includes(variant as MetaCallbackVariant)) throw new BadRequestException();
    const state = singleQueryValue(query.state);
    const code = singleQueryValue(query.code);
    const error = query.error !== undefined || query.error_reason !== undefined;
    if (!state || state.length < 32 || state.length > 128 || code === null) throw new BadRequestException();
    try {
      await this.abuseLimits.consume('PORTAL_PREAUTH', { ip: request.ip });
      const result = await this.service.callback(variant as MetaCallbackVariant, state,
        code === undefined ? undefined : code, error ? 'provider-error' : undefined);
      response.status(HttpStatus.SEE_OTHER)
        .set({
          Location: `/oauth/return?onboardingRef=${encodeURIComponent(result.onboardingId)}`,
          'Cache-Control': 'no-store',
          Pragma: 'no-cache',
          'Referrer-Policy': 'no-referrer',
        })
        .end();
    } catch (cause) {
      if (cause instanceof OnboardingCodeNotFoundError) throw new NotFoundException();
      if (cause instanceof OnboardingCodeConflictError) throw new ConflictException();
      if (cause instanceof OnboardingConfigurationUnavailableError) throw new ServiceUnavailableException();
      throw cause;
    }
  }
}

@Controller('onboarding-sessions')
export class OnboardingSagaRecoveryController {
  constructor(
    private readonly recovery: OnboardingSagaRecoveryService,
    private readonly abuseLimits: AbuseLimitService,
  ) {}

  @Post(':onboardingSessionId/actions')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async request(
    @Param('onboardingSessionId') onboardingId: string,
    @Body() body: OnboardingRecoveryRequest,
    @Req() request: PortalRequest,
    @Res({ passthrough: true }) response: Response,
    @Headers('x-tenant-context') headerContext?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (request.originalUrl.includes('?') || !/^[A-Za-z0-9_-]{1,128}$/.test(onboardingId) ||
      !idempotencyKey || !/^[A-Za-z0-9._~-]{16,128}$/.test(idempotencyKey) || !body ||
      Object.keys(body).some((key) => key !== 'action' && key !== 'stage') ||
      !['RESUME', 'RECONCILE'].includes(body.action) || !RECOVERY_STAGES.includes(body.stage)) throw new BadRequestException();
    const tenantContextRef = headerContext ?? readPortalCookie(request.headers.cookie, PORTAL_CONTEXT_COOKIE);
    if (!tenantContextRef || !/^[A-Za-z0-9._~-]{16,512}$/.test(tenantContextRef)) throw new BadRequestException();
    try {
      await this.abuseLimits.consume('ONBOARDING_START', { ip: request.ip,
        actor: request.portalSession.principalId, tenant: request.portalSession.tenantId });
      const accepted = await this.recovery.request(request.portalSession, tenantContextRef, onboardingId,
        idempotencyKey, body.action, body.stage);
      const location = `/api/v1/jobs/${accepted.id}`;
      response.setHeader('Location', location);
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      return Object.freeze({ jobId: accepted.id, status: 'PENDING' as const, location,
        requestId: request.requestId ?? 'unknown' });
    } catch (error) {
      if (error instanceof OnboardingRecoveryNotFoundError) throw new NotFoundException();
      if (error instanceof OnboardingRecoveryConflictError) throw new ConflictException();
      if (error instanceof OnboardingConfigurationUnavailableError) throw new ServiceUnavailableException();
      throw error;
    }
  }
}

/** null means a repeated query parameter, which is rejected without echoing the value. */
function singleQueryValue(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}
