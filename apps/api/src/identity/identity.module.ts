import { DynamicModule, Module } from '@nestjs/common';
import type { ApiEnvironment } from '../config/environment.js';
import { IDENTITY_REPOSITORY } from './identity.repository.js';
import { ServiceTenantAuthorizationService, TenantAuthorizationService, TenantContextService } from './identity.service.js';
import { MysqlIdentityRepository } from './mysql-identity.repository.js';

@Module({})
export class IdentityModule {
  static register(environment: ApiEnvironment): DynamicModule {
    return {
      module: IdentityModule,
      providers: [
        {
          provide: IDENTITY_REPOSITORY,
          useFactory: () => new MysqlIdentityRepository(environment.database),
        },
        {
          provide: TenantContextService,
          useFactory: (repository: MysqlIdentityRepository) => new TenantContextService(repository),
          inject: [IDENTITY_REPOSITORY],
        },
        {
          provide: TenantAuthorizationService,
          useFactory: (repository: MysqlIdentityRepository) => new TenantAuthorizationService(repository),
          inject: [IDENTITY_REPOSITORY],
        },
        {
          provide: ServiceTenantAuthorizationService,
          useFactory: (repository: MysqlIdentityRepository) => new ServiceTenantAuthorizationService(repository),
          inject: [IDENTITY_REPOSITORY],
        },
      ],
      exports: [IDENTITY_REPOSITORY, TenantContextService, TenantAuthorizationService, ServiceTenantAuthorizationService],
    };
  }
}
