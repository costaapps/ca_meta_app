import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AbuseLimitService } from '../common/security/abuse-limits.js';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import { PortalSessionGuard, type PortalRequest } from '../identity/portal-session.guard.js';
import { PORTAL_CONTEXT_COOKIE, readPortalCookie } from '../identity/portal-session.service.js';
import { TenantContextService } from '../identity/identity.service.js';
import { SupportDiagnosticService } from '../privacy/audit.service.js';
import { OperationsActionInputError, OperationsActionService, OperationsActionUnavailableError,
  type OperationsActionRequest, type OperationsReasonCode, type OperationsRecoveryStage } from './operations-actions.service.js';
import {
  type OperationsDiagnostics,
  OperationsDiagnosticsService,
} from './operations-diagnostics.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY = /^[A-Za-z0-9._~-]{16,128}$/;
const REASONS = new Set<OperationsReasonCode>(['INCIDENT', 'CUSTOMER_REQUEST', 'SECURITY_REVIEW']);
const STAGES = new Set(['authorization', 'asset-verification', 'subscription', 'projection']);

function tenantContext(request: PortalRequest, header?: string): string {
  const context = header ?? readPortalCookie(request.headers.cookie, PORTAL_CONTEXT_COOKIE);
  if (!context || !/^[A-Za-z0-9._~-]{16,512}$/.test(context)) throw new BadRequestException();
  return context;
}

function requestId(request: PortalRequest): string {
  const id = request.requestId;
  if (!id || !UUID.test(id)) throw new ServiceUnavailableException();
  return id;
}

function actionRequest(body: unknown): OperationsActionRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new BadRequestException();
  const value = body as Record<string, unknown>;
  const allowed = value.action === 'RESUME_STAGE'
    ? ['action', 'resourceRef', 'stage', 'reasonCode']
    : ['action', 'resourceRef', 'reasonCode'];
  if (Object.keys(value).some((key) => !allowed.includes(key)) ||
      typeof value.action !== 'string' || typeof value.resourceRef !== 'string' || !UUID.test(value.resourceRef) ||
      typeof value.reasonCode !== 'string' || !REASONS.has(value.reasonCode as OperationsReasonCode)) throw new BadRequestException();
  switch (value.action) {
    case 'REVALIDATE': return Object.freeze({ action: value.action, resourceRef: value.resourceRef, reasonCode: value.reasonCode as OperationsReasonCode });
    case 'RESUME_STAGE':
      if (typeof value.stage !== 'string' || !STAGES.has(value.stage)) throw new BadRequestException();
      return Object.freeze({ action: value.action, resourceRef: value.resourceRef, stage: value.stage as OperationsRecoveryStage, reasonCode: value.reasonCode as OperationsReasonCode });
    case 'RECONCILE_SUBSCRIPTION': return Object.freeze({ action: value.action, resourceRef: value.resourceRef, reasonCode: value.reasonCode as OperationsReasonCode });
    case 'REQUEST_REAUTH': return Object.freeze({ action: value.action, resourceRef: value.resourceRef, reasonCode: value.reasonCode as OperationsReasonCode });
    case 'REPLAY_JOB': return Object.freeze({ action: value.action, resourceRef: value.resourceRef, reasonCode: value.reasonCode as OperationsReasonCode });
    default: throw new BadRequestException();
  }
}

@Controller()
export class OperationsDiagnosticsController {
  constructor(
    private readonly diagnostics: OperationsDiagnosticsService,
    private readonly actions: OperationsActionService,
    private readonly contexts: TenantContextService,
    private readonly supportDiagnostics: SupportDiagnosticService,
    private readonly abuseLimits: AbuseLimitService,
  ) {}

  @Get('operations/diagnostics')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async read(
    @Req() request: PortalRequest,
    @Headers('x-tenant-context') headerContext?: string,
    @Res({ passthrough: true }) response?: Response,
  ): Promise<OperationsDiagnostics> {
    if (request.originalUrl.includes('?')) throw new BadRequestException();
    const id = requestId(request);
    await this.abuseLimits.consume('SESSION_STATUS', { ip: request.ip, actor: request.portalSession.principalId, tenant: request.portalSession.tenantId });
    const scope = await this.contexts.resolveCurrent(request.portalSession, tenantContext(request, headerContext));
    const result = await this.diagnostics.read(scope, id);
    response?.setHeader('Cache-Control', 'no-store');
    return result;
  }

  @Get('support/diagnostics/export')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async export(
    @Query() query: Record<string, unknown>,
    @Req() request: PortalRequest,
    @Headers('x-tenant-context') headerContext?: string,
    @Res({ passthrough: true }) response?: Response,
  ): Promise<unknown> {
    if (Object.keys(query).length !== 1 || typeof query.reasonCode !== 'string' || !REASONS.has(query.reasonCode as OperationsReasonCode)) {
      throw new BadRequestException();
    }
    const id = requestId(request);
    await this.abuseLimits.consume('ADMIN_ACTION', { ip: request.ip, actor: request.portalSession.principalId, tenant: request.portalSession.tenantId });
    const scope = await this.contexts.resolveCurrent(request.portalSession, tenantContext(request, headerContext));
    try {
      const output = await this.supportDiagnostics.read({ tenantId: scope.tenantId, actorRef: request.portalSession.principalId,
        targetRef: scope.tenantId, reasonCode: query.reasonCode as OperationsReasonCode }, id,
      () => this.diagnostics.read(scope, id));
      response?.setHeader('Cache-Control', 'no-store');
      response?.setHeader('Content-Disposition', 'attachment; filename="meta-diagnostic.json"');
      return output;
    } catch (error) {
      if (error instanceof Error && error.message === 'Support diagnostic access denied.') throw new ForbiddenException();
      throw new ServiceUnavailableException();
    }
  }

  @Post('operations/actions')
  @HttpCode(HttpStatus.OK)
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async act(
    @Body() body: unknown,
    @Req() request: PortalRequest,
    @Headers('x-tenant-context') headerContext?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Res({ passthrough: true }) response?: Response,
  ) {
    const id = requestId(request);
    if (!idempotencyKey || !IDEMPOTENCY.test(idempotencyKey)) throw new BadRequestException();
    const action = actionRequest(body);
    await this.abuseLimits.consume('ADMIN_ACTION', { ip: request.ip, actor: request.portalSession.principalId, tenant: request.portalSession.tenantId });
    try {
      const result = await this.actions.execute({ session: request.portalSession,
        tenantContextRef: tenantContext(request, headerContext), idempotencyKey, requestId: id, action });
      response?.setHeader('Cache-Control', 'no-store');
      return result;
    } catch (error) {
      if (error instanceof OperationsActionInputError) throw new BadRequestException();
      if (error instanceof OperationsActionUnavailableError) return Object.freeze({
        action: action.action, outcome: 'UNAVAILABLE' as const, reasonCode: error.reasonCode, requestId: id, operationRef: null,
      });
      throw error;
    }
  }
}
