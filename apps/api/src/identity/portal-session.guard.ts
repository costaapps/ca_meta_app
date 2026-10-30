import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { PortalSessionVerifier, type VerifiedPortalSession } from './identity.trust.js';
import { PORTAL_SESSION_COOKIE, readPortalCookie } from './portal-session.service.js';

export type PortalRequest = Request & {
  requestId?: string;
  portalSession: VerifiedPortalSession;
};

@Injectable()
export class PortalSessionGuard implements CanActivate {
  constructor(private readonly sessions: PortalSessionVerifier) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PortalRequest>();
    const cookieValue = readPortalCookie(request.headers.cookie, PORTAL_SESSION_COOKIE);
    const sessionStatusRead = request.method === 'GET' && request.path === '/api/v1/session';
    const session = await this.sessions.verify(cookieValue, { touchLastSeen: !sessionStatusRead });
    if (!session) throw new UnauthorizedException();
    request.portalSession = session;
    return true;
  }
}
