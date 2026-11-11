import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
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
import type { components } from '@ca-meta/contracts';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import { PortalSessionGuard, type PortalRequest } from '../identity/portal-session.guard.js';
import { PORTAL_CONTEXT_COOKIE, readPortalCookie } from '../identity/portal-session.service.js';
import {
  NotificationExternalActionUnavailableError,
  NotificationActionUnresolvedError,
  NotificationIdempotencyConflictError,
  NotificationInputError,
  NotificationNotFoundError,
  NotificationsService,
} from './notifications.service.js';

function tenantContextRef(request: PortalRequest, headerContext?: string): string {
  const ref = headerContext ?? readPortalCookie(request.headers.cookie, PORTAL_CONTEXT_COOKIE);
  if (!ref || !/^[A-Za-z0-9._~-]{16,512}$/.test(ref)) throw new BadRequestException();
  return ref;
}

function requestId(request: PortalRequest): string { return request.requestId ?? 'unknown'; }

function parseLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (typeof value !== 'string' || !/^\d{1,3}$/.test(value)) throw new BadRequestException();
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException();
  return limit;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BadRequestException();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
}

function safeText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function parseAction(value: unknown): components['schemas']['NotificationActionRequest'] {
  const body = object(value);
  if (body['action'] === 'MARK_READ' || body['action'] === 'DISMISS') {
    if (!exactKeys(body, ['action'])) throw new BadRequestException();
    return { action: body['action'] };
  }
  if (body['action'] === 'SEND_TEMPLATE') {
    if (!exactKeys(body, ['action', 'templateName', 'language', 'parameters']) ||
        !safeText(body['templateName'], 128) || !safeText(body['language'], 16) || !Array.isArray(body['parameters']) ||
        body['parameters'].length > 100 || !body['parameters'].every((item) => safeText(item, 1024))) throw new BadRequestException();
    return { action: 'SEND_TEMPLATE', templateName: body['templateName'], language: body['language'], parameters: body['parameters'] };
  }
  if (body['action'] === 'REPLY_COMMENT') {
    if (!exactKeys(body, ['action', 'replyText']) || !safeText(body['replyText'], 4096)) throw new BadRequestException();
    return { action: 'REPLY_COMMENT', replyText: body['replyText'] };
  }
  if (body['action'] === 'SEND_MESSAGE') {
    if (!exactKeys(body, ['action', 'messageText']) || !safeText(body['messageText'], 4096)) throw new BadRequestException();
    return { action: 'SEND_MESSAGE', messageText: body['messageText'] };
  }
  throw new BadRequestException();
}

@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('notifications')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: PortalRequest,
    @Headers('x-tenant-context') headerContext?: string,
  ): Promise<components['schemas']['NotificationListPage']> {
    try {
      if (query['cursor'] !== undefined && typeof query['cursor'] !== 'string') throw new BadRequestException();
      return await this.notifications.list(request.portalSession, tenantContextRef(request, headerContext), parseLimit(query['limit']),
        query['cursor'] as string | undefined, requestId(request));
    } catch (error) {
      if (error instanceof NotificationInputError) throw new BadRequestException();
      throw error;
    }
  }

  @Post('notifications/:notificationId/actions')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  @HttpCode(HttpStatus.OK)
  async act(
    @Param('notificationId') notificationId: string,
    @Headers('x-tenant-context') headerContext: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: PortalRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<components['schemas']['NotificationActionResult'] | components['schemas']['NotificationActionAccepted']> {
    try {
      const result = await this.notifications.act(request.portalSession, tenantContextRef(request, headerContext), notificationId,
        idempotencyKey ?? '', parseAction(request.body), requestId(request));
      if ('operationId' in result) {
        response.status(HttpStatus.ACCEPTED);
        response.setHeader('Location', result.location);
      }
      return result;
    } catch (error) {
      if (error instanceof NotificationInputError) throw new BadRequestException();
      if (error instanceof NotificationNotFoundError) throw new NotFoundException();
      if (error instanceof NotificationIdempotencyConflictError) throw new ConflictException();
      if (error instanceof NotificationActionUnresolvedError) throw new ConflictException();
      if (error instanceof NotificationExternalActionUnavailableError) throw new ServiceUnavailableException();
      throw error;
    }
  }

  @Get('operations/:operationId')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async operation(
    @Param('operationId') operationId: string,
    @Req() request: PortalRequest,
    @Headers('x-tenant-context') headerContext?: string,
  ): Promise<components['schemas']['OperationStatus']> {
    const result = await this.notifications.operation(request.portalSession,
      tenantContextRef(request, headerContext), operationId, requestId(request));
    if (!result) throw new NotFoundException();
    return result;
  }
}
