import { Body, Controller, Get, Headers, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { PublicRoute } from '../common/security/public-route.decorator.js';
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
  ) {}

  @Get()
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async current(@Req() request: PortalRequest, @Headers('x-tenant-context') headerContext?: string): Promise<{
    readonly principalRef: string;
    readonly tenantRef: string;
    readonly roles: readonly string[];
    readonly tenantContextRef: string;
    readonly contextVersion: number;
    readonly requestId: string;
  }> {
    const session = request.portalSession;
    const contextRef = headerContext ?? readPortalCookie(request.headers.cookie, PORTAL_CONTEXT_COOKIE);
    const scope = await this.contexts.resolveCurrent(session, contextRef);
    return Object.freeze({
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
    readonly principalRef: string;
    readonly tenantRef: string;
    readonly roles: readonly string[];
    readonly tenantContextRef: string;
    readonly contextVersion: number;
    readonly requestId: string;
  }> {
    const rotated = await this.sessions.rotateTenantContext(request.portalSession, contextRef, body.tenantRef);
    if (response) setPortalContextCookies(response, rotated.contextRef, rotated.csrfToken, new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString());
    return Object.freeze({
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
    @Headers('x-tenant-context') headerContext?: string,
  ): Promise<void> {
    const contextRef = headerContext ?? readPortalCookie(request.headers.cookie, PORTAL_CONTEXT_COOKIE);
    await this.contexts.resolveCurrent(request.portalSession, contextRef);
    await this.sessions.revoke(request.portalSession);
    clearPortalSessionCookies(response);
  }
}
