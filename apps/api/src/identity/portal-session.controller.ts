import { Body, Controller, Get, Headers, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import { AbuseLimitService } from '../common/security/abuse-limits.js';
import { PortalSessionGuard, type PortalRequest } from './portal-session.guard.js';
import { TenantContextService } from './identity.service.js';
import { MysqlPortalSessionService, PORTAL_CONTEXT_COOKIE, readPortalCookie, setPortalContextCookies, clearPortalSessionCookies } from './portal-session.service.js';

class TenantSwitchRequest {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  tenantRef!: string;
}

@Controller('session')
export class PortalSessionController {
  constructor(
    private readonly contexts: TenantContextService,
    private readonly sessions: MysqlPortalSessionService,
    private readonly abuseLimits: AbuseLimitService,
  ) {}

  @Get()
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async current(@Req() request: PortalRequest, @Headers('x-tenant-context') headerContext?: string): Promise<{
    readonly sessionRef: string;
    readonly principalRef: string;
    readonly tenantRef: string;
    readonly roles: readonly string[];
    readonly tenantContextRef: string;
    readonly contextVersion: number;
    readonly requestId: string;
  }> {
    const session = request.portalSession;
    await this.abuseLimits.consume('SESSION_STATUS', {
      ip: request.ip,
      actor: session.principalId,
      tenant: session.tenantId,
    });
    const contextRef = headerContext ?? readPortalCookie(request.headers.cookie, PORTAL_CONTEXT_COOKIE);
    const scope = await this.contexts.resolveCurrent(session, contextRef);
    await this.sessions.refreshActivity(session);
    return Object.freeze({
      sessionRef: session.sessionId,
      principalRef: createHash('sha256').update(`principal-ref\0${session.principalId}`, 'utf8').digest('hex'),
      tenantRef: scope.tenantId,
      roles: scope.roles,
      tenantContextRef: contextRef as string,
      contextVersion: session.contextVersion,
      requestId: request.requestId ?? 'unknown',
    });
  }

  @Post('tenant-switch')
  @HttpCode(200)
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async switchTenant(
    @Req() request: PortalRequest,
    @Body() body: TenantSwitchRequest,
    @Headers('x-tenant-context') contextRef?: string,
    @Res({ passthrough: true }) response?: Response,
  ): Promise<{
    readonly sessionRef: string;
    readonly principalRef: string;
    readonly tenantRef: string;
    readonly roles: readonly string[];
    readonly tenantContextRef: string;
    readonly contextVersion: number;
    readonly requestId: string;
  }> {
    const rotated = await this.sessions.rotateTenantContext(request.portalSession, contextRef, body.tenantRef);
    if (response) setPortalContextCookies(response, rotated.contextRef, rotated.csrfToken, rotated.expiresAt);
    return Object.freeze({
      sessionRef: request.portalSession.sessionId,
      principalRef: createHash('sha256').update(`principal-ref\0${request.portalSession.principalId}`, 'utf8').digest('hex'),
      tenantRef: rotated.publicContext.tenantRef,
      roles: rotated.publicContext.roles,
      tenantContextRef: rotated.contextRef,
      contextVersion: rotated.publicContext.contextVersion,
      requestId: request.requestId ?? 'unknown',
    });
  }

  @Post('logout')
  @HttpCode(204)
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async logout(
    @Req() request: PortalRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.sessions.revoke(request.portalSession);
    clearPortalSessionCookies(response);
  }
}
