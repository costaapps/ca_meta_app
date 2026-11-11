import { DynamicModule, Module } from '@nestjs/common';
import type { ApiEnvironment } from '../config/environment.js';
import { CredentialResolverService } from '../credentials/credential-resolver.service.js';
import { ServiceTenantAuthorizationService } from '../identity/identity.service.js';
import { ConfiguredServiceProofVerifier } from '../identity/service-proof.verifier.js';
import { MetaAppConfigRegistry, META_APP_CONFIG_REGISTRY } from '../meta-config/meta-app-config.registry.js';
import { AuditEventWriter } from '../privacy/audit.service.js';
import { DURABLE_WORK_DATABASE } from '../jobs/jobs.module.js';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import { MysqlInternalAssetOperationStore } from './mysql-internal-asset-operation.store.js';
import { MysqlInternalAssetContextRepository } from './mysql-internal-asset-context.repository.js';
import { InternalAssetOperationsController } from './internal-asset-operations.controller.js';
import { InternalAssetOperationsService } from './internal-asset-operations.service.js';
import {
  INTERNAL_ASSET_OPERATION_ADAPTER,
  INTERNAL_ASSET_OPERATION_ASSET_REPOSITORY,
  INTERNAL_ASSET_OPERATION_STORE,
  INTERNAL_ASSET_OPERATION_TARGET_RESOLVER,
  type InternalAssetOperationAdapter,
} from './internal-operations.types.js';

@Module({})
export class InternalAssetOperationsModule {
  static register(
    identityModule: DynamicModule,
    metaAssetsModule: DynamicModule,
    metaAppConfigModule: DynamicModule,
    environment: ApiEnvironment,
  ): DynamicModule {
    return {
      module: InternalAssetOperationsModule,
      imports: [identityModule, metaAssetsModule, metaAppConfigModule],
      controllers: [InternalAssetOperationsController],
      providers: [
        { provide: ConfiguredServiceProofVerifier, useFactory: () => new ConfiguredServiceProofVerifier(environment.internalServiceCredentials ?? []) },
        { provide: 'INTERNAL_OPERATIONS_ENVIRONMENT', useValue: { nodeEnv: environment.nodeEnv } },
        {
          provide: AuditEventWriter,
          useFactory: (database: DurableWorkDatabase) => new AuditEventWriter(database),
          inject: [DURABLE_WORK_DATABASE],
        },
        {
          provide: INTERNAL_ASSET_OPERATION_STORE,
          useFactory: (database: DurableWorkDatabase, audit: AuditEventWriter) => new MysqlInternalAssetOperationStore(database, audit),
          inject: [DURABLE_WORK_DATABASE, AuditEventWriter],
        },
        {
          provide: INTERNAL_ASSET_OPERATION_ASSET_REPOSITORY,
          useFactory: (database: DurableWorkDatabase) => new MysqlInternalAssetContextRepository(database),
          inject: [DURABLE_WORK_DATABASE],
        },
        // Msg4 recipient/comment mappings are outside this repository; never trust raw provider IDs from callers.
        { provide: INTERNAL_ASSET_OPERATION_TARGET_RESOLVER, useValue: Object.freeze({ async resolveTarget() { return undefined; } }) },
        // The real provider adapter stays absent until the external Meta capability gates pass.
        {
          provide: INTERNAL_ASSET_OPERATION_ADAPTER,
          useFactory: (): InternalAssetOperationAdapter => Object.freeze({
            available: false,
            async execute() { throw new Error('internal-operation-adapter-unavailable'); },
          }),
        },
        {
          provide: InternalAssetOperationsService,
          useFactory: (
            proofVerifier: ConfiguredServiceProofVerifier,
            authorization: ServiceTenantAuthorizationService,
            credentials: CredentialResolverService,
            registry: MetaAppConfigRegistry,
            assets: import('./internal-operations.types.js').InternalAssetOperationAssetRepository,
            store: import('./internal-operations.types.js').InternalAssetOperationStore,
            targets: import('./internal-operations.types.js').InternalAssetOperationTargetResolver,
            adapter: InternalAssetOperationAdapter,
          ) => new InternalAssetOperationsService(proofVerifier, authorization, credentials, registry, assets, store, targets, adapter, environment),
          inject: [ConfiguredServiceProofVerifier, ServiceTenantAuthorizationService, CredentialResolverService,
            META_APP_CONFIG_REGISTRY, INTERNAL_ASSET_OPERATION_ASSET_REPOSITORY, INTERNAL_ASSET_OPERATION_STORE,
            INTERNAL_ASSET_OPERATION_TARGET_RESOLVER, INTERNAL_ASSET_OPERATION_ADAPTER],
        },
      ],
      exports: [InternalAssetOperationsService],
    };
  }
}
