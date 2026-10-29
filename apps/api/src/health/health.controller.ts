import { Controller, Get, HttpStatus, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { errorEnvelope } from '../common/http/error-envelope.js';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import { ReadinessService } from './readiness.service.js';

interface HealthStatus {
  readonly status: 'ok';
}

@Controller()
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get('/health')
  @PublicRoute()
  liveness(): HealthStatus {
    return { status: 'ok' };
  }

  @Get('/ready')
  @PublicRoute()
  async readinessStatus(
    @Req() request: Request & { requestId?: string },
    @Res({ passthrough: true }) response: Response,
  ): Promise<HealthStatus | ReturnType<typeof errorEnvelope>> {
    const ready = await this.readiness.isReady();
    if (ready) {
      response.status(HttpStatus.OK);
      return { status: 'ok' };
    }
    response.status(HttpStatus.SERVICE_UNAVAILABLE);
    return errorEnvelope(
      'DEPENDENCY_UNAVAILABLE',
      'The operation could not be confirmed yet.',
      request.requestId ?? 'unknown',
      true,
      'CHECK_STATUS',
    );
  }
}