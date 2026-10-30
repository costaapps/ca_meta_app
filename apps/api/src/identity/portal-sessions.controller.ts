import { Controller, Delete, HttpCode, Param, ParseUUIDPipe, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import { PortalSessionGuard, type PortalRequest } from './portal-session.guard.js';
import { clearPortalSessionCookies, MysqlPortalSessionService } from './portal-session.service.js';

@Controller('sessions')
export class PortalSessionsController {
  constructor(private readonly sessions: MysqlPortalSessionService) {}

  @Delete(':id')
  @HttpCode(204)
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async revoke(
    @Req() request: PortalRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) targetSessionId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.sessions.revokeAuthorizedSession(request.portalSession, targetSessionId);
    if (targetSessionId === request.portalSession.sessionId) clearPortalSessionCookies(response);
  }
}
