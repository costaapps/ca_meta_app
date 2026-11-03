import { DynamicModule, Module } from '@nestjs/common';
import type { ApiEnvironment } from '../config/environment.js';
import { JobsModule, DURABLE_WORK_DATABASE } from '../jobs/jobs.module.js';
import { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import { OutboxService } from '../outbox/outbox-service.js';
import { META_ASSETS_REPOSITORY, MysqlMetaAssetsRepository } from './mysql-meta-assets.repository.js';
import { ConfiguredCredentialKeyProvider } from '../credentials/credential-key-provider.js';
import { CREDENTIAL_KEY_PROVIDER, CREDENTIAL_VAULT_AUTHORIZATION, CREDENTIAL_VAULT_REPOSITORY } from '../credentials/credential-vault.types.js';
import { CredentialVaultService, FailClosedCredentialVaultAuthorization } from '../credentials/credential-vault.service.js';
import { MysqlCredentialVaultRepository } from '../credentials/mysql-credential-vault.repository.js';
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

@Module({})
export class MetaAssetsModule {
  static register(environment: ApiEnvironment): DynamicModule {
    return {
      module: MetaAssetsModule,
      imports: [JobsModule.register(environment)],
      providers: [
        {
          provide: META_ASSETS_REPOSITORY,
          useFactory: (database: DurableWorkDatabase, outbox: OutboxService) =>
            new MysqlMetaAssetsRepository(database, outbox),
          inject: [DURABLE_WORK_DATABASE, OutboxService],
        },
        { provide: CREDENTIAL_KEY_PROVIDER, useFactory: () => new ConfiguredCredentialKeyProvider(environment.credentialKeyRing) },
        { provide: CREDENTIAL_VAULT_AUTHORIZATION, useClass: FailClosedCredentialVaultAuthorization },
        {
          provide: CREDENTIAL_VAULT_REPOSITORY,
          useFactory: (database: DurableWorkDatabase) => new MysqlCredentialVaultRepository(database),
          inject: [DURABLE_WORK_DATABASE],
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
