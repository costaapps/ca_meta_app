import {
  BadRequestException,
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
  ServiceUnavailableException,
  TooManyRequestsException,
  UseGuards,
} from '@nestjs/common';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import { PortalSessionGuard, type PortalRequest } from '../identity/portal-session.guard.js';
import { PORTAL_CONTEXT_COOKIE, readPortalCookie } from '../identity/portal-session.service.js';
import type { components } from '@ca-meta/contracts';
import {
  type ConnectionCatalogQuery,
  AssetCatalogInputError,
  AssetCatalogService,
  AssetNotFoundError,
} from './asset-catalog.service.js';
import { AssetRefreshRateLimitError, AssetRefreshUnavailableError } from './asset-refresh.service.js';

const CHANNELS = new Set(['FACEBOOK', 'INSTAGRAM', 'WHATSAPP']);
const STATUSES = new Set(['ACTIVE', 'INACTIVE', 'UNKNOWN', 'STALE']);
const CONNECTION_STATUSES = new Set(['ACTIVE', 'PARTIAL', 'REAUTH_REQUIRED', 'UNKNOWN', 'DISCONNECTED']);

function tenantContextRef(request: PortalRequest, headerContext?: string): string {
  const ref = headerContext ?? readPortalCookie(request.headers.cookie, PORTAL_CONTEXT_COOKIE);
  if (!ref || !/^[A-Za-z0-9._~-]{16,512}$/.test(ref)) throw new BadRequestException();
  return ref;
}

function requestId(request: PortalRequest): string { return request.requestId ?? 'unknown'; }

function parseAssetQuery(query: Record<string, unknown>) {
  const rawLimit = query.limit;
  const limit = rawLimit === undefined ? 50 : typeof rawLimit === 'string' && /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : NaN;
  const channel = query.channel;
  const status = query.status;
  const cursor = query.cursor;
  const number = query.number;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      (channel !== undefined && (typeof channel !== 'string' || !CHANNELS.has(channel))) ||
      (status !== undefined && (typeof status !== 'string' || !STATUSES.has(status))) ||
      (cursor !== undefined && typeof cursor !== 'string') ||
      (number !== undefined && (typeof number !== 'string' || !/^\+?[0-9]{1,32}$/.test(number)))) {
    throw new BadRequestException();
  }
  return {
    limit,
    ...(typeof cursor === 'string' ? { cursor } : {}),
    ...(typeof channel === 'string' ? { channel: channel as 'FACEBOOK' | 'INSTAGRAM' | 'WHATSAPP' } : {}),
    ...(typeof number === 'string' ? { number } : {}),
    ...(typeof status === 'string' ? { status: status as components['schemas']['AssetListItem']['status'] } : {}),
  } as const;
}

function parseConnectionQuery(query: Record<string, unknown>): ConnectionCatalogQuery {
  const rawLimit = query.limit;
  const limit = rawLimit === undefined ? 50 : typeof rawLimit === 'string' && /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : NaN;
  const channel = query.channel;
  const status = query.status;
  const cursor = query.cursor;
  const number = query.number;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      (channel !== undefined && (typeof channel !== 'string' || !CHANNELS.has(channel))) ||
      (status !== undefined && (typeof status !== 'string' || !CONNECTION_STATUSES.has(status))) ||
      (cursor !== undefined && typeof cursor !== 'string') ||
      (number !== undefined && (typeof number !== 'string' || !/^\+?[0-9]{1,32}$/.test(number)))) throw new BadRequestException();
  return {
    limit,
    ...(typeof cursor === 'string' ? { cursor } : {}),
    ...(typeof channel === 'string' ? { channel: channel as 'FACEBOOK' | 'INSTAGRAM' | 'WHATSAPP' } : {}),
    ...(typeof number === 'string' ? { number } : {}),
    ...(typeof status === 'string' ? { status: status as ConnectionCatalogQuery['status'] } : {}),
  };
}

@Controller()
export class AssetCatalogController {
  constructor(private readonly catalog: AssetCatalogService) {}

  @Get('connections')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async listConnections(
    @Query() query: Record<string, unknown>,
    @Req() request: PortalRequest,
    @Headers('x-tenant-context') headerContext?: string,
  ): Promise<components['schemas']['ConnectionListPage']> {
    try {
      return await this.catalog.listConnections(request.portalSession, tenantContextRef(request, headerContext),
        parseConnectionQuery(query), requestId(request));
    } catch (error) {
      if (error instanceof AssetCatalogInputError) throw new BadRequestException();
      throw error;
    }
  }

  @Get('connections/:connectionId')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async getConnection(
    @Param('connectionId') connectionId: string,
    @Req() request: PortalRequest,
    @Headers('x-tenant-context') headerContext?: string,
  ): Promise<components['schemas']['ConnectionDetail']> {
    const connection = await this.catalog.getConnection(request.portalSession,
      tenantContextRef(request, headerContext), connectionId, requestId(request));
    if (!connection) throw new NotFoundException();
    return connection;
  }

  @Get('integrations/flows')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  listFlows(
    @Req() request: PortalRequest,
    @Headers('x-tenant-context') headerContext?: string,
  ): Promise<components['schemas']['FlowList']> {
    return this.catalog.listFlows(request.portalSession, tenantContextRef(request, headerContext), requestId(request));
  }

  @Get('assets')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async listAssets(
    @Query() query: Record<string, unknown>,
    @Req() request: PortalRequest,
    @Headers('x-tenant-context') headerContext?: string,
  ): Promise<components['schemas']['AssetListPage']> {
    try {
      return await this.catalog.listAssets(request.portalSession, tenantContextRef(request, headerContext), parseAssetQuery(query), requestId(request));
    } catch (error) {
      if (error instanceof AssetCatalogInputError) throw new BadRequestException();
      throw error;
    }
  }

  @Get('assets/:assetId')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async getAsset(
    @Param('assetId') assetId: string,
    @Req() request: PortalRequest,
    @Headers('x-tenant-context') headerContext?: string,
  ): Promise<components['schemas']['Asset']> {
    const asset = await this.catalog.getAsset(request.portalSession, tenantContextRef(request, headerContext), assetId, requestId(request));
    if (!asset) throw new NotFoundException();
    return asset;
  }

  @Post('assets/:assetId/refresh')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  async refreshAsset(
    @Param('assetId') assetId: string,
    @Req() request: PortalRequest,
    @Headers('x-tenant-context') headerContext?: string,
  ): Promise<components['schemas']['JobAccepted']> {
    try {
      return await this.catalog.refreshAsset(request.portalSession, tenantContextRef(request, headerContext), assetId, requestId(request));
    } catch (error) {
      if (error instanceof AssetCatalogInputError) throw new BadRequestException();
      if (error instanceof AssetRefreshRateLimitError) throw new TooManyRequestsException();
      if (error instanceof AssetRefreshUnavailableError) throw new ServiceUnavailableException();
      if (error instanceof AssetNotFoundError) throw new NotFoundException();
      throw error;
    }
  }
}
