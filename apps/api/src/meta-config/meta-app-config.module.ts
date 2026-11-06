import { DynamicModule, Module } from '@nestjs/common';
import type { ApiEnvironment } from '../config/environment.js';
import { PortalSessionGuard } from '../identity/portal-session.guard.js';
import { PortalSessionVerifier } from '../identity/identity.trust.js';
import { MetaAppConfigController } from './meta-app-config.controller.js';
import { META_APP_CONFIG_REGISTRY, MetaAppConfigRegistry } from './meta-app-config.registry.js';

@Module({})
export class MetaAppConfigModule {
  static register(identityModule: DynamicModule, environment: ApiEnvironment): DynamicModule {
    return {
      module: MetaAppConfigModule,
      imports: [identityModule],
      controllers: [MetaAppConfigController],
      providers: [
        {
          provide: META_APP_CONFIG_REGISTRY,
          useValue: new MetaAppConfigRegistry(environment.metaAppConfigurations ?? []),
        },
        {
          provide: PortalSessionGuard,
          useFactory: (sessions: PortalSessionVerifier) => new PortalSessionGuard(sessions),
          inject: [PortalSessionVerifier],
        },
      ],
      exports: [META_APP_CONFIG_REGISTRY],
    };
  }
}
