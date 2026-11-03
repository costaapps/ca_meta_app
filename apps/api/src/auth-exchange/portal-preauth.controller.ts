import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { IsIn } from 'class-validator';
import type { Request, Response } from 'express';
import { AbuseLimitService } from '../common/security/abuse-limits.js';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import { PortalPreAuthService, setPortalPreAuthCookie } from '../identity/portal-session.service.js';

interface RequestWithId extends Request {
  requestId?: string;
}

class PortalPreAuthStartRequest {
  @IsIn(['PORTAL_TOP_LEVEL', 'SUITE4_EMBED'])
  entryMode!: 'PORTAL_TOP_LEVEL' | 'SUITE4_EMBED';

  @IsIn(['connections', 'setup'])
  returnRoute!: 'connections' | 'setup';
}

export const SUITE4_EMBED_ALLOWED_ORIGINS = Symbol('SUITE4_EMBED_ALLOWED_ORIGINS');

function isRateLimited(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'RATE_LIMITED';
}

@Controller('auth/preauth')
export class PortalPreAuthController {
  constructor(
    private readonly preAuth: PortalPreAuthService,
    private readonly abuseLimits: AbuseLimitService,
    @Inject(SUITE4_EMBED_ALLOWED_ORIGINS) private readonly suite4EmbedOrigins: readonly string[],
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @PublicRoute()
  async begin(
    @Req() request: RequestWithId,
    @Body() body: PortalPreAuthStartRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly challengeRef: string; readonly expiresAt: string; readonly requestId: string }> {
    if (request.originalUrl.includes('?')) throw new BadRequestException();
    if (body.entryMode === 'SUITE4_EMBED' && this.suite4EmbedOrigins.length === 0) throw new BadRequestException();
    if (!request.requestId || request.requestId.length > 128 || !request.ip || request.ip.length > 128) {
      throw new ServiceUnavailableException();
    }

    try {
      await this.abuseLimits.consume('PORTAL_PREAUTH', { ip: request.ip });
    } catch (error) {
      if (isRateLimited(error)) {
        response.setHeader('Retry-After', '60');
        throw new HttpException('Request limit exceeded.', HttpStatus.TOO_MANY_REQUESTS);
      }
      throw new ServiceUnavailableException();
    }

    try {
      const started = await this.preAuth.begin(body.entryMode);
      if (started.entryMode !== body.entryMode) throw new ServiceUnavailableException();
      setPortalPreAuthCookie(response, started);
      return Object.freeze({
        challengeRef: started.challengeRef,
        expiresAt: started.expiresAt,
        requestId: request.requestId,
      });
    } catch {
      throw new ServiceUnavailableException();
    }
  }
}
