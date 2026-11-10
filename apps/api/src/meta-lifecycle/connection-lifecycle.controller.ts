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
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
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

function response(result: ConnectionLifecycleDisconnectResult, requestId: string) {
  return Object.freeze({
    commandId: result.commandRef,
    localState: result.localState,
    cleanupState: result.cleanupState,
    reasonCode: result.safeReasonCode,
    requestId,
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
    @Headers('x-tenant-context') headerContext?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    await this.abuseLimits.consume('ADMIN_ACTION', {
      ip: request.ip, actor: request.portalSession.principalId, tenant: request.portalSession.tenantId,
    });
    return response(await this.runDisconnect({
      session: request.portalSession,
      tenantContextRef: tenantContext(request, headerContext),
      authorizationRef: connectionId,
      idempotencyKey: idempotency(idempotencyKey),
      correlationId: request.requestId ?? '',
    }), request.requestId ?? 'unknown');
  }

  @Delete('connections/:connectionId/assets/:assetId')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  async disconnectAsset(
    @Param('connectionId') connectionId: string,
    @Param('assetId') assetId: string,
    @Req() request: PortalRequest,
    @Headers('x-tenant-context') headerContext?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    await this.abuseLimits.consume('ADMIN_ACTION', {
      ip: request.ip, actor: request.portalSession.principalId, tenant: request.portalSession.tenantId,
    });
    return response(await this.runDisconnect({
      session: request.portalSession,
      tenantContextRef: tenantContext(request, headerContext),
      authorizationRef: connectionId,
      assetRef: assetId,
      idempotencyKey: idempotency(idempotencyKey),
      correlationId: request.requestId ?? '',
    }), request.requestId ?? 'unknown');
  }

  @Post('connections/:connectionId/reauthorizations')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  @HttpCode(HttpStatus.CREATED)
  async reauthorize(
    @Param('connectionId') connectionId: string,
    @Req() request: PortalRequest,
    @Headers('x-tenant-context') headerContext?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    try {
      await this.abuseLimits.consume('ONBOARDING_START', {
        ip: request.ip, actor: request.portalSession.principalId, tenant: request.portalSession.tenantId,
      });
      return await this.lifecycle.reauthorize({
        session: request.portalSession,
        tenantContextRef: tenantContext(request, headerContext),
        authorizationRef: connectionId,
        idempotencyKey: idempotency(idempotencyKey),
        requestId: request.requestId ?? 'unknown',
      });
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
