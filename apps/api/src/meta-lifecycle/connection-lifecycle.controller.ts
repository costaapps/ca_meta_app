import {
  BadRequestException,
  ConflictException,
  Controller,
  Delete,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { components } from '@ca-meta/contracts';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import { AbuseLimitService } from '../common/security/abuse-limits.js';
import { PortalSessionGuard, type PortalRequest } from '../identity/portal-session.guard.js';
import { PORTAL_CONTEXT_COOKIE, readPortalCookie } from '../identity/portal-session.service.js';
import {
  ConnectionLifecycleConfigurationUnavailableError,
  ConnectionLifecycleConflictError,
  ConnectionLifecycleInputError,
  ConnectionLifecycleNotFoundError,
  ConnectionLifecycleScopeRequiredError,
  ConnectionLifecycleService,
} from './connection-lifecycle.service.js';
import type { ConnectionLifecycleDisconnectResult } from './connection-lifecycle.types.js';

function tenantContext(request: PortalRequest, headerContext?: string): string {
  const context = headerContext ?? readPortalCookie(request.headers.cookie, PORTAL_CONTEXT_COOKIE);
  if (!context || !/^[A-Za-z0-9._~-]{16,512}$/.test(context)) throw new BadRequestException();
  return context;
}

function idempotency(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9._~-]{16,128}$/.test(value)) throw new BadRequestException();
  return value;
}

function lifecycleResponse(result: ConnectionLifecycleDisconnectResult, requestId: string): components['schemas']['ConnectionLifecycleResult'] {
  return Object.freeze({
    commandId: result.commandRef,
    localState: result.localState,
    cleanupState: result.cleanupState,
    reasonCode: result.safeReasonCode,
    requestId,
  });
}

function acceptedDisconnect(result: ConnectionLifecycleDisconnectResult, requestId: string): components['schemas']['JobAccepted'] {
  return Object.freeze({
    jobId: result.commandRef,
    status: 'PENDING',
    location: `/api/v1/jobs/${result.commandRef}`,
    requestId,
    connectionLifecycle: lifecycleResponse(result, requestId),
  });
}

@Controller()
export class ConnectionLifecycleController {
  constructor(private readonly lifecycle: ConnectionLifecycleService, private readonly abuseLimits: AbuseLimitService) {}

  @Delete('connections/:connectionId')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  async disconnectAuthorization(
    @Param('connectionId') connectionId: string,
    @Req() request: PortalRequest,
    @Res({ passthrough: true }) response: Response,
    @Headers('x-tenant-context') headerContext?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    await this.abuseLimits.consume('ADMIN_ACTION', {
      ip: request.ip, actor: request.portalSession.principalId, tenant: request.portalSession.tenantId,
    });
    const result = await this.runDisconnect({
      session: request.portalSession,
      tenantContextRef: tenantContext(request, headerContext),
      authorizationRef: connectionId,
      idempotencyKey: idempotency(idempotencyKey),
      correlationId: request.requestId ?? '',
    });
    const accepted = acceptedDisconnect(result, request.requestId ?? 'unknown');
    response.setHeader('Location', accepted.location);
    response.setHeader('Cache-Control', 'no-store');
    return accepted;
  }

  @Delete('connections/:connectionId/assets/:assetId')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  async disconnectAsset(
    @Param('connectionId') connectionId: string,
    @Param('assetId') assetId: string,
    @Req() request: PortalRequest,
    @Res({ passthrough: true }) response: Response,
    @Headers('x-tenant-context') headerContext?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    await this.abuseLimits.consume('ADMIN_ACTION', {
      ip: request.ip, actor: request.portalSession.principalId, tenant: request.portalSession.tenantId,
    });
    const result = await this.runDisconnect({
      session: request.portalSession,
      tenantContextRef: tenantContext(request, headerContext),
      authorizationRef: connectionId,
      assetRef: assetId,
      idempotencyKey: idempotency(idempotencyKey),
      correlationId: request.requestId ?? '',
    });
    const location = `/api/v1/jobs/${result.commandRef}`;
    response.setHeader('Location', location);
    response.setHeader('Cache-Control', 'no-store');
    return lifecycleResponse(result, request.requestId ?? 'unknown');
  }

  @Post('connections/:connectionId/reauthorizations')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  async reauthorize(
    @Param('connectionId') connectionId: string,
    @Req() request: PortalRequest,
    @Res({ passthrough: true }) response: Response,
    @Headers('x-tenant-context') headerContext?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    try {
      await this.abuseLimits.consume('ONBOARDING_START', {
        ip: request.ip, actor: request.portalSession.principalId, tenant: request.portalSession.tenantId,
      });
      const onboarding = await this.lifecycle.reauthorize({
        session: request.portalSession,
        tenantContextRef: tenantContext(request, headerContext),
        authorizationRef: connectionId,
        idempotencyKey: idempotency(idempotencyKey),
        requestId: request.requestId ?? 'unknown',
      });
      const accepted = Object.freeze({
        jobId: onboarding.id,
        status: 'PENDING' as const,
        location: `/api/v1/onboarding-sessions/${onboarding.id}`,
        requestId: request.requestId ?? 'unknown',
        reauthorization: onboarding,
      }) satisfies components['schemas']['JobAccepted'];
      response.setHeader('Location', accepted.location);
      response.setHeader('Cache-Control', 'no-store');
      return accepted;
    } catch (error) {
      if (error instanceof ConnectionLifecycleInputError) throw new BadRequestException();
      if (error instanceof ConnectionLifecycleNotFoundError) throw new NotFoundException();
      if (error instanceof ConnectionLifecycleConflictError) throw new ConflictException();
      if (error instanceof ConnectionLifecycleConfigurationUnavailableError) throw new ServiceUnavailableException();
      throw error;
    }
  }

  private async runDisconnect(input: Parameters<ConnectionLifecycleService['disconnect']>[0]): Promise<ConnectionLifecycleDisconnectResult> {
    try {
      return await this.lifecycle.disconnect(input);
    } catch (error) {
      if (error instanceof ConnectionLifecycleInputError) throw new BadRequestException();
      if (error instanceof ConnectionLifecycleNotFoundError) throw new NotFoundException();
      if (error instanceof ConnectionLifecycleScopeRequiredError || error instanceof ConnectionLifecycleConflictError) {
        throw new ConflictException();
      }
      throw error;
    }
  }
}
