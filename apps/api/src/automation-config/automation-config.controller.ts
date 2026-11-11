import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Response } from 'express';
import type { components } from '@ca-meta/contracts';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import { PortalSessionGuard, type PortalRequest } from '../identity/portal-session.guard.js';
import { PORTAL_CONTEXT_COOKIE, readPortalCookie } from '../identity/portal-session.service.js';
import { AutomationConfigService, automationConfigEtag } from './automation-config.service.js';
import {
  AutomationConfigNotFoundError,
  AutomationConfigValidationError,
  AutomationConfigVersionConflictError,
  UnsupportedAutomationConfigFieldError,
} from './automation-config.types.js';

const CONTROL_SAFE_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;

class AutomationConfigPatchDto {
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  version!: number;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  @Matches(CONTROL_SAFE_TEXT)
  privateWelcomeMessage?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  @Matches(CONTROL_SAFE_TEXT)
  commentPublicReply?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  @Matches(CONTROL_SAFE_TEXT)
  commentPrivateReply?: string;
}

function contextRef(request: PortalRequest, headerContext?: string): string {
  const ref = headerContext ?? readPortalCookie(request.headers.cookie, PORTAL_CONTEXT_COOKIE);
  if (!ref || !/^[A-Za-z0-9._~-]{16,512}$/.test(ref)) throw new BadRequestException();
  return ref;
}

function requestId(request: PortalRequest): string { return request.requestId ?? 'unknown'; }

function parseIfMatch(value: string | undefined): number {
  const match = value ? /^"automation-v(0|[1-9]\d*)"$/.exec(value) : null;
  const version = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(version) || version < 0) throw new BadRequestException();
  return version;
}

function mapAutomationError(error: unknown): never {
  if (error instanceof AutomationConfigNotFoundError) throw new HttpException('Resource not available.', HttpStatus.NOT_FOUND);
  if (error instanceof AutomationConfigVersionConflictError) throw new HttpException('Configuration changed. Reload before saving.', HttpStatus.PRECONDITION_FAILED);
  if (error instanceof AutomationConfigValidationError || error instanceof UnsupportedAutomationConfigFieldError) {
    throw new HttpException('Check the supported fields and message text.', HttpStatus.UNPROCESSABLE_ENTITY);
  }
  throw error;
}

@Controller()
export class AutomationConfigController {
  constructor(private readonly config: AutomationConfigService) {}

  @Get('assets/:assetId/automation-config')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async read(
    @Param('assetId') assetId: string,
    @Req() request: PortalRequest,
    @Headers('x-tenant-context') headerContext?: string,
    @Res({ passthrough: true }) response?: Response,
  ): Promise<components['schemas']['AutomationConfig']> {
    try {
      const result = await this.config.read(request.portalSession, contextRef(request, headerContext), assetId, requestId(request));
      response?.setHeader('ETag', automationConfigEtag(result.version));
      return result;
    } catch (error) { return mapAutomationError(error); }
  }

  @Patch('assets/:assetId/automation-config')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  async update(
    @Param('assetId') assetId: string,
    @Body() body: AutomationConfigPatchDto,
    @Req() request: PortalRequest,
    @Headers('x-tenant-context') headerContext?: string,
    @Headers('if-match') ifMatch?: string,
    @Res({ passthrough: true }) response?: Response,
  ): Promise<components['schemas']['AutomationConfig']> {
    try {
      const result = await this.config.update(request.portalSession, contextRef(request, headerContext), assetId,
        requestId(request), parseIfMatch(ifMatch), body);
      response?.setHeader('ETag', automationConfigEtag(result.version));
      return result;
    } catch (error) { return mapAutomationError(error); }
  }
}
