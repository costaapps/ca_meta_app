import { DynamicModule, Module } from '@nestjs/common';
import type { ApiEnvironment } from '../config/environment.js';
import { CLOCK, SystemMonotonicClock } from '../common/time/clock.port.js';
import { DATABASE_READINESS_PORT } from '../database/database-readiness.port.js';
import { MysqlReadinessAdapter } from '../database/mysql-readiness.adapter.js';
import { HealthController } from './health.controller.js';
import { ReadinessService } from './readiness.service.js';

@Module({})
export class HealthModule {
  static register(environment: ApiEnvironment): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [
        { provide: CLOCK, useClass: SystemMonotonicClock },
        ReadinessService,
        {
          provide: DATABASE_READINESS_PORT,
          useFactory: () => new MysqlReadinessAdapter(environment.database),
        },
      ],
    };
  }
}