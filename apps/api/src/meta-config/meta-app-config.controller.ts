import { BadRequestException, Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import { PortalSessionGuard, type PortalRequest } from '../identity/portal-session.guard.js';
import { META_APP_CONFIG_REGISTRY, MetaAppConfigRegistry } from './meta-app-config.registry.js';

@Controller('meta')
export class MetaAppConfigController {
  constructor(@Inject(META_APP_CONFIG_REGISTRY) private readonly registry: MetaAppConfigRegistry) {}

  @Get('bootstrap')
  @PublicRoute()
  @UseGuards(PortalSessionGuard)
  readBootstrap(@Req() request: PortalRequest) {
    if (request.originalUrl.includes('?')) throw new BadRequestException();
    return Object.freeze({ requestId: request.requestId ?? 'unknown', ...this.registry.bootstrap() });
  }
}
