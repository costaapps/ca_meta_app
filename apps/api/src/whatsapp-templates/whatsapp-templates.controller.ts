import {
  BadRequestException, ConflictException, Controller, Get, Headers, HttpCode, HttpException, HttpStatus,
  NotFoundException, Param, Post, Query, Req, Res, ServiceUnavailableException, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { components } from '@ca-meta/contracts';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import { PortalSessionGuard, type PortalRequest } from '../identity/portal-session.guard.js';
import { PORTAL_CONTEXT_COOKIE, readPortalCookie } from '../identity/portal-session.service.js';
import {
  WhatsAppTemplateIdempotencyConflictError, WhatsAppTemplateNotFoundError,
  WhatsAppTemplatesService, WhatsAppTemplatesUnavailableError,
} from './whatsapp-templates.service.js';
import { TemplateInputError } from './template-body.js';

function tenantContextRef(request: PortalRequest, headerContext?: string): string {
  const ref = headerContext ?? readPortalCookie(request.headers.cookie, PORTAL_CONTEXT_COOKIE);
  if (!ref || !/^[A-Za-z0-9._~-]{16,512}$/.test(ref)) throw new BadRequestException();
  return ref;
}

function requestId(request: PortalRequest): string { return request.requestId ?? 'unknown'; }

function query(query: Record<string, unknown>): { readonly cursor?: string; readonly limit: number } {
  const rawLimit = query['limit'];
  const limit = rawLimit === undefined ? 50 : typeof rawLimit === 'string' && /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : NaN;
  const cursor = query['cursor'];
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      (cursor !== undefined && (typeof cursor !== 'string' || !/^[A-Za-z0-9._~+/%=-]{1,512}$/.test(cursor))) ||
      Object.keys(query).some((key) => !['cursor', 'limit'].includes(key))) throw new BadRequestException();
  return { limit, ...(typeof cursor === 'string' ? { cursor } : {}) };
}

@Controller()
export class WhatsAppTemplatesController {
  constructor(private readonly templates: WhatsAppTemplatesService) {}

  @Get('whatsapp/accounts/:assetId/templates')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async list(
    @Param('assetId') assetId: string,
    @Query() rawQuery: Record<string, unknown>,
    @Req() request: PortalRequest,
    @Headers('x-tenant-context') headerContext?: string,
    @Res({ passthrough: true }) response?: Response,
  ): Promise<components['schemas']['TemplateListPage']> {
    try {
      const result = await this.templates.list(request.portalSession, tenantContextRef(request, headerContext),
        assetId, query(rawQuery), requestId(request));
      response?.setHeader('Cache-Control', 'no-store');
      return result;
    } catch (error) {
      this.mapError(error);
    }
  }

  @Post('whatsapp/accounts/:assetId/templates')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  async create(
    @Param('assetId') assetId: string,
    @Req() request: PortalRequest,
    @Headers('x-tenant-context') headerContext?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Res({ passthrough: true }) response?: Response,
  ): Promise<components['schemas']['JobAccepted']> {
    try {
      const result = await this.templates.create(request.portalSession, tenantContextRef(request, headerContext),
        assetId, idempotencyKey ?? '', request.body as unknown, requestId(request));
      response?.setHeader('Location', result.location);
      response?.setHeader('Cache-Control', 'no-store');
      return result;
    } catch (error) {
      this.mapError(error);
    }
  }

  private mapError(error: unknown): never {
    if (error instanceof TemplateInputError) throw new BadRequestException();
    if (error instanceof WhatsAppTemplateNotFoundError) throw new NotFoundException();
    if (error instanceof WhatsAppTemplateIdempotencyConflictError) throw new ConflictException();
    if (error instanceof WhatsAppTemplatesUnavailableError) throw new ServiceUnavailableException();
    throw error;
  }
}
