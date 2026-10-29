import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import { ReadinessService } from './readiness.service.js';

interface HealthStatus {
  readonly status: 'ok' | 'unavailable';
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
  async readinessStatus(@Res({ passthrough: true }) response: Response): Promise<HealthStatus> {
    const ready = await this.readiness.isReady();
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? 'ok' : 'unavailable' };
  }
}
