import { DynamicModule, Global, Module } from '@nestjs/common';
import type { ApiEnvironment } from '../config/environment.js';
import { ConsoleStructuredLogger, STRUCTURED_LOGGER } from '../common/http/request-context.js';
import { MetricsController } from './metrics.controller.js';
import { OBSERVABILITY_METRICS_TOKEN, OBSERVABILITY_REGISTRY, ObservabilityRegistry } from './observability.registry.js';

@Global()
@Module({})
export class ObservabilityModule {
  static register(environment: ApiEnvironment): DynamicModule {
    return {
      module: ObservabilityModule,
      controllers: [MetricsController],
      providers: [
        { provide: STRUCTURED_LOGGER, useClass: ConsoleStructuredLogger },
        { provide: OBSERVABILITY_METRICS_TOKEN, useValue: environment.observabilityMetricsToken },
        {
          provide: OBSERVABILITY_REGISTRY,
          useFactory: (logger: ConsoleStructuredLogger) => new ObservabilityRegistry(
            environment.nodeEnv, environment.expectedWebhookIntervalSeconds ?? 0, logger),
          inject: [STRUCTURED_LOGGER],
        },
      ],
      exports: [STRUCTURED_LOGGER, OBSERVABILITY_REGISTRY],
    };
  }
}
