import { ArrayMaxSize, ArrayUnique, IsArray, IsString, Matches } from 'class-validator';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Put,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { components } from '@ca-meta/contracts';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import { IdentityDeniedError } from '../identity/identity.errors.js';
import { PortalSessionGuard, type PortalRequest } from '../identity/portal-session.guard.js';
import { PORTAL_CONTEXT_COOKIE, readPortalCookie } from '../identity/portal-session.service.js';
import { MetaFacebookPageSelectionDependencyError, MetaFacebookPageSelectionInvalidError } from '../meta-subscriptions/meta-subscription.service.js';
import { FacebookPageSelectionService } from './facebook-page-selection.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENVIRONMENTS = new Set(['development', 'test', 'staging', 'production']);

export class ReplaceFacebookPageSelectionRequest {
  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(UUID, { each: true })
  selectedAssetRefs!: string[];
}

function tenantContextRef(request: PortalRequest, headerContext?: string): string {
  const ref = headerContext ?? readPortalCookie(request.headers.cookie, PORTAL_CONTEXT_COOKIE);
  if (!ref || !/^[A-Za-z0-9._~-]{16,512}$/.test(ref)) throw new BadRequestException();
  return ref;
}

@Controller('facebook/pages/authorizations/:authorizationId/selection')
export class FacebookPagesController {
  constructor(private readonly selection: FacebookPageSelectionService) {}

  @Get()
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async read(
    @Param('authorizationId') authorizationId: string,
    @Query('appConfigurationId') appConfigurationRef: string | undefined,
    @Query('environment') environment: string | undefined,
    @Headers('x-tenant-context') headerContext: string | undefined,
    @Req() request: PortalRequest,
  ): Promise<components['schemas']['FacebookPageSelectionStatus']> {
    const context = this.context(authorizationId, appConfigurationRef, environment, request, headerContext);
    try {
      const result = await this.selection.readForPortal({ ...context, correlationId: request.requestId ?? 'unknown' }, request.portalSession);
      return Object.freeze({ ...result, requestId: request.requestId ?? 'unknown' });
    } catch (error) { this.mapError(error); }
  }

  @Put()
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async replace(
    @Param('authorizationId') authorizationId: string,
    @Query('appConfigurationId') appConfigurationRef: string | undefined,
    @Query('environment') environment: string | undefined,
    @Headers('x-tenant-context') headerContext: string | undefined,
    @Body() body: ReplaceFacebookPageSelectionRequest,
    @Req() request: PortalRequest,
  ): Promise<components['schemas']['FacebookPageSelectionStatus']> {
    const context = this.context(authorizationId, appConfigurationRef, environment, request, headerContext);
    if (!body || !Array.isArray(body.selectedAssetRefs) || body.selectedAssetRefs.length > 500 ||
        body.selectedAssetRefs.some((ref) => typeof ref !== 'string' || !UUID.test(ref)) ||
        new Set(body.selectedAssetRefs).size !== body.selectedAssetRefs.length) throw new BadRequestException();
    try {
      const result = await this.selection.replaceForPortal({ ...context, selectedAssetRefs: body.selectedAssetRefs,
        correlationId: request.requestId ?? 'unknown' }, request.portalSession);
      return Object.freeze({ ...result, requestId: request.requestId ?? 'unknown' });
    } catch (error) { this.mapError(error); }
  }

  private context(authorizationId: string, appConfigurationRef: string | undefined, environment: string | undefined,
    request: PortalRequest, headerContext?: string) {
    if (!UUID.test(authorizationId) || !appConfigurationRef || !UUID.test(appConfigurationRef) ||
        !environment || !ENVIRONMENTS.has(environment)) throw new BadRequestException();
    return Object.freeze({ authorizationId, appConfigurationRef,
      environment: environment as 'development' | 'test' | 'staging' | 'production',
      tenantContextRef: tenantContextRef(request, headerContext) });
  }

  private mapError(error: unknown): never {
    if (error instanceof IdentityDeniedError) throw error;
    if (error instanceof MetaFacebookPageSelectionInvalidError) throw new NotFoundException();
    if (error instanceof MetaFacebookPageSelectionDependencyError) throw new ServiceUnavailableException();
    if (error instanceof Error && error.message === 'Facebook Page selection is invalid.') throw new BadRequestException();
    throw new ServiceUnavailableException();
  }
}
