import { createHash, timingSafeEqual } from 'node:crypto';
import { Controller, Get, Headers, HttpException, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import { OBSERVABILITY_METRICS_TOKEN, OBSERVABILITY_REGISTRY, type ObservabilityRegistry } from './observability.registry.js';

export function isMetricsAuthorizationValid(header: string | undefined, configuredToken: string | undefined): boolean {
  if (!configuredToken || configuredToken.length < 32 || configuredToken.length > 512 ||
      /[\u0000-\u0020\u007f]/.test(configuredToken)) return false;
  if (typeof header !== 'string' || header.length > 2_048) return false;
  const match = /^Bearer ([^\s,]+)$/.exec(header);
  if (!match?.[1] || match[1].length > 512) return false;
  const suppliedDigest = createHash('sha256').update(match[1], 'utf8').digest();
  const configuredDigest = createHash('sha256').update(configuredToken, 'utf8').digest();
  return timingSafeEqual(suppliedDigest, configuredDigest);
}

@Controller()
export class MetricsController {
  constructor(
    @Inject(OBSERVABILITY_REGISTRY) private readonly registry: ObservabilityRegistry,
    @Inject(OBSERVABILITY_METRICS_TOKEN) private readonly token: string | undefined,
  ) {}

  @Get('/internal/metrics')
  @PublicRoute()
  scrape(@Headers('authorization') authorization: string | undefined, @Res() response: Response): void {
    if (!this.token) throw new HttpException('Not found.', HttpStatus.NOT_FOUND);
    if (!isMetricsAuthorizationValid(authorization, this.token)) {
      throw new HttpException('Unauthorized.', HttpStatus.UNAUTHORIZED);
    }
    response.status(HttpStatus.OK);
    response.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    response.send(this.registry.renderPrometheus());
  }
}
