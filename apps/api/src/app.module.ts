import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { ApiEnvironment } from './config/environment.js';
import { SafeExceptionFilter } from './common/http/safe-exception.filter.js';
import { ConsoleStructuredLogger, STRUCTURED_LOGGER } from './common/http/request-context.js';
import { REQUEST_DRAIN, RequestDrain } from './common/http/request-drain.js';
import { DenyByDefaultGuard } from './common/security/deny-by-default.guard.js';
import { CLOCK, SystemMonotonicClock } from './common/time/clock.port.js';
import { HealthModule } from './health/health.module.js';

@Module({})
export class ApiModule {
  static register(environment: ApiEnvironment): DynamicModule {
    return {
      module: ApiModule,
      imports: [HealthModule.register(environment)],
      providers: [
        { provide: STRUCTURED_LOGGER, useClass: ConsoleStructuredLogger },
        { provide: CLOCK, useClass: SystemMonotonicClock },
        { provide: REQUEST_DRAIN, useClass: RequestDrain },
        { provide: APP_GUARD, useClass: DenyByDefaultGuard },
        SafeExceptionFilter,
      ],
      exports: [REQUEST_DRAIN],
    };
  }
}