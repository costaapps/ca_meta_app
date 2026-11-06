import { DynamicModule, Module } from '@nestjs/common';
import type { ApiEnvironment } from '../config/environment.js';
import { JobsModule, DURABLE_JOB_STORE, DURABLE_WORK_DATABASE } from '../jobs/jobs.module.js';
import { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import { DurableJobStore } from '../jobs/job-store.js';
import { OutboxService } from '../outbox/outbox-service.js';
import { META_ASSETS_REPOSITORY, MysqlMetaAssetsRepository } from './mysql-meta-assets.repository.js';
import { ConfiguredCredentialKeyProvider } from '../credentials/credential-key-provider.js';
import { CREDENTIAL_KEY_PROVIDER, CREDENTIAL_VAULT_AUTHORIZATION, CREDENTIAL_VAULT_REPOSITORY } from '../credentials/credential-vault.types.js';
import { CredentialVaultService, FailClosedCredentialVaultAuthorization } from '../credentials/credential-vault.service.js';
import { MysqlCredentialVaultRepository } from '../credentials/mysql-credential-vault.repository.js';
import { PrivacyModule, PRIVACY_AUDIT_WRITER } from '../privacy/privacy.module.js';
import type { AuditEventWriter } from '../privacy/audit.service.js';
import {
  CREDENTIAL_OPERATION_POLICY,
  CREDENTIAL_RESOLUTION_AUDIT,
  CREDENTIAL_RESOLUTION_AUTHORIZATION,
  CREDENTIAL_RESOLUTION_REPOSITORY,
} from '../credentials/credential-resolver.types.js';
import {
  CredentialResolverService,
  FailClosedCredentialOperationPolicy,
  FailClosedCredentialResolutionAudit,
  IdentityCredentialResolutionAuthorization,
} from '../credentials/credential-resolver.service.js';
import { MysqlCredentialResolutionRepository } from '../credentials/mysql-credential-resolver.repository.js';
import { ServiceTenantAuthorizationService } from '../identity/identity.service.js';
import { MysqlIdentityRepository } from '../identity/mysql-identity.repository.js';
import { PortalSessionVerifier } from '../identity/identity.trust.js';
import { TenantAuthorizationService, TenantContextService } from '../identity/identity.service.js';
import { PortalSessionGuard } from '../identity/portal-session.guard.js';
import { AssetCatalogController } from './asset-catalog.controller.js';
import { AssetCatalogService, META_FLOW_ADAPTER_VARIANTS } from './asset-catalog.service.js';
import { AssetRefreshCoordinator, META_ASSET_REFRESH_ADAPTER, type MetaAssetRefreshAdapter } from './asset-refresh.service.js';
import type { FlowCatalogVariant } from './meta-assets.types.js';

@Module({})
export class MetaAssetsModule {
  static register(identityModule: DynamicModule, environment: ApiEnvironment): DynamicModule {
    return {
      module: MetaAssetsModule,
      imports: [identityModule, JobsModule.register(environment), PrivacyModule.register(environment)],
      controllers: [AssetCatalogController],
      providers: [
        {
          provide: PortalSessionGuard,
          useFactory: (sessions: PortalSessionVerifier) => new PortalSessionGuard(sessions),
          inject: [PortalSessionVerifier],
        },
        {
          provide: AssetCatalogService,
          useFactory: (repository: MysqlMetaAssetsRepository, contexts: TenantContextService,
            authorization: TenantAuthorizationService, refresh: AssetRefreshCoordinator,
            flowVariants: ReadonlySet<FlowCatalogVariant>) =>
            new AssetCatalogService(repository, contexts, authorization, environment.nodeEnv, refresh, flowVariants),
          inject: [META_ASSETS_REPOSITORY, TenantContextService, TenantAuthorizationService,
            AssetRefreshCoordinator, META_FLOW_ADAPTER_VARIANTS],
        },
        // No real flow adapter is installed in this runtime.
        { provide: META_FLOW_ADAPTER_VARIANTS, useFactory: (): ReadonlySet<FlowCatalogVariant> => new Set() },
        // No real Meta adapter ships with this runtime; tests may inject an isolated fake.
        { provide: META_ASSET_REFRESH_ADAPTER, useFactory: (): MetaAssetRefreshAdapter | null => null },
        {
          provide: AssetRefreshCoordinator,
          useFactory: (database: DurableWorkDatabase, jobs: DurableJobStore, adapter: MetaAssetRefreshAdapter | null) =>
            new AssetRefreshCoordinator(database, jobs, adapter),
          inject: [DURABLE_WORK_DATABASE, DURABLE_JOB_STORE, META_ASSET_REFRESH_ADAPTER],
        },
        {
          provide: META_ASSETS_REPOSITORY,
          useFactory: (database: DurableWorkDatabase, outbox: OutboxService, audit: AuditEventWriter) =>
            new MysqlMetaAssetsRepository(database, outbox, audit),
          inject: [DURABLE_WORK_DATABASE, OutboxService, PRIVACY_AUDIT_WRITER],
        },
        { provide: CREDENTIAL_KEY_PROVIDER, useFactory: () => new ConfiguredCredentialKeyProvider(environment.credentialKeyRing) },
        { provide: CREDENTIAL_VAULT_AUTHORIZATION, useClass: FailClosedCredentialVaultAuthorization },
        {
          provide: CREDENTIAL_VAULT_REPOSITORY,
          useFactory: (database: DurableWorkDatabase, audit: AuditEventWriter) => new MysqlCredentialVaultRepository(database, audit),
          inject: [DURABLE_WORK_DATABASE, PRIVACY_AUDIT_WRITER],
        },
        {
          provide: CredentialVaultService,
          useFactory: (repository: MysqlCredentialVaultRepository, keys: ConfiguredCredentialKeyProvider, authorization: FailClosedCredentialVaultAuthorization) =>
            new CredentialVaultService(repository, keys, authorization),
          inject: [CREDENTIAL_VAULT_REPOSITORY, CREDENTIAL_KEY_PROVIDER, CREDENTIAL_VAULT_AUTHORIZATION],
        },
        {
          provide: CREDENTIAL_RESOLUTION_REPOSITORY,
          useFactory: (database: DurableWorkDatabase) => new MysqlCredentialResolutionRepository(database),
          inject: [DURABLE_WORK_DATABASE],
        },
        { provide: CREDENTIAL_OPERATION_POLICY, useClass: FailClosedCredentialOperationPolicy },
        { provide: CREDENTIAL_RESOLUTION_AUDIT, useClass: FailClosedCredentialResolutionAudit },
        {
          provide: MysqlIdentityRepository,
          useFactory: () => new MysqlIdentityRepository(environment.database),
        },
        {
          provide: ServiceTenantAuthorizationService,
          useFactory: (repository: MysqlIdentityRepository) => new ServiceTenantAuthorizationService(repository),
          inject: [MysqlIdentityRepository],
        },
        {
          provide: CREDENTIAL_RESOLUTION_AUTHORIZATION,
          useFactory: (identity: ServiceTenantAuthorizationService) => new IdentityCredentialResolutionAuthorization(identity),
          inject: [ServiceTenantAuthorizationService],
        },
        {
          provide: CredentialResolverService,
          useFactory: (repository: MysqlCredentialResolutionRepository,
            policies: FailClosedCredentialOperationPolicy,
            authorization: IdentityCredentialResolutionAuthorization,
            audit: FailClosedCredentialResolutionAudit,
            vault: CredentialVaultService) => new CredentialResolverService(repository, policies, authorization, audit, vault),
          inject: [CREDENTIAL_RESOLUTION_REPOSITORY, CREDENTIAL_OPERATION_POLICY, CREDENTIAL_RESOLUTION_AUTHORIZATION,
            CREDENTIAL_RESOLUTION_AUDIT, CredentialVaultService],
        },
      ],
      exports: [META_ASSETS_REPOSITORY, CredentialVaultService, CredentialResolverService, JobsModule],
    };
  }
}
