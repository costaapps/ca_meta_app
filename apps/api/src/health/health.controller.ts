import { Controller, Get, HttpStatus, Req, Res } from '@nestjs/common';
import type { HealthStatus } from '@ca-meta/contracts';
import { validateHealthStatus } from '@ca-meta/contracts/runtime';
import type { Request, Response } from 'express';
import { errorEnvelope } from '../common/http/error-envelope.js';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import { ReadinessService } from './readiness.service.js';

function healthStatus(): HealthStatus {
  const status: HealthStatus = { status: 'ok' };
  if (!validateHealthStatus(status)) {
    throw new Error('Server generated a HealthStatus that does not match the public contract.');
  }
  return status;
}

@Controller()
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get('/health')
  @PublicRoute()
  liveness(): HealthStatus {
    return healthStatus();
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
      return healthStatus();
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
