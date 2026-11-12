import { DynamicModule, Module } from '@nestjs/common';
import type { ApiEnvironment } from '../config/environment.js';
import { PortalSessionGuard } from '../identity/portal-session.guard.js';
import { PortalSessionVerifier } from '../identity/identity.trust.js';
import { TenantAuthorizationService, TenantContextService } from '../identity/identity.service.js';
import type { AuditEventWriter } from '../privacy/audit.service.js';
import { PRIVACY_AUDIT_WRITER } from '../privacy/privacy.module.js';
import { JobsModule, DURABLE_WORK_DATABASE, DURABLE_JOB_STORE } from '../jobs/jobs.module.js';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { DurableJobStore } from '../jobs/job-store.js';
import { AssetCatalogService } from '../meta-assets/asset-catalog.service.js';
import { ConnectionLifecycleService } from '../meta-lifecycle/connection-lifecycle.service.js';
import { OnboardingSagaRecoveryService } from '../onboarding/onboarding-saga-recovery.js';
import { OperationsActionService, FailClosedSupportOperationsAuthorization, FailClosedOperationsTenantIdentityAuthorization,
  type OperationsTenantIdentityAuthorizationPort, type SupportOperationsAuthorizationPort } from './operations-actions.service.js';
import { OperationsDiagnosticsController } from './operations-diagnostics.controller.js';
import { MysqlOperationsDiagnosticsRepository, OperationsDiagnosticsService, type OperationsDiagnosticsRepository } from './operations-diagnostics.service.js';

export const OPERATIONS_DIAGNOSTICS_REPOSITORY = Symbol('OPERATIONS_DIAGNOSTICS_REPOSITORY');
export const SUPPORT_OPERATIONS_AUTHORIZATION_PORT = Symbol('SUPPORT_OPERATIONS_AUTHORIZATION_PORT');
export const OPERATIONS_TENANT_IDENTITY_AUTHORIZATION_PORT = Symbol('OPERATIONS_TENANT_IDENTITY_AUTHORIZATION_PORT');

@Module({})
export class OperationsModule {
  static register(identityModule: DynamicModule, metaAssetsModule: DynamicModule, onboardingModule: DynamicModule,
    privacyModule: DynamicModule, environment: ApiEnvironment): DynamicModule {
    return {
      module: OperationsModule,
      imports: [identityModule, metaAssetsModule, onboardingModule, privacyModule, JobsModule.register(environment)],
      controllers: [OperationsDiagnosticsController],
      providers: [
        { provide: PortalSessionGuard, useFactory: (sessions: PortalSessionVerifier) => new PortalSessionGuard(sessions), inject: [PortalSessionVerifier] },
        { provide: OPERATIONS_DIAGNOSTICS_REPOSITORY,
          useFactory: (database: DurableWorkDatabase): OperationsDiagnosticsRepository => new MysqlOperationsDiagnosticsRepository(database),
          inject: [DURABLE_WORK_DATABASE] },
        { provide: OperationsDiagnosticsService,
          useFactory: (repository: OperationsDiagnosticsRepository, authorization: TenantAuthorizationService) =>
            new OperationsDiagnosticsService(repository, authorization),
          inject: [OPERATIONS_DIAGNOSTICS_REPOSITORY, TenantAuthorizationService] },
        { provide: SUPPORT_OPERATIONS_AUTHORIZATION_PORT, useClass: FailClosedSupportOperationsAuthorization },
        { provide: OPERATIONS_TENANT_IDENTITY_AUTHORIZATION_PORT, useClass: FailClosedOperationsTenantIdentityAuthorization },
        { provide: OperationsActionService,
          useFactory: (contexts: TenantContextService, authorization: TenantAuthorizationService,
            assets: AssetCatalogService, onboarding: OnboardingSagaRecoveryService, lifecycle: ConnectionLifecycleService,
            database: DurableWorkDatabase, jobs: DurableJobStore, support: SupportOperationsAuthorizationPort,
            audit: AuditEventWriter, tenantIdentity: OperationsTenantIdentityAuthorizationPort) =>
            new OperationsActionService(contexts, authorization, assets, onboarding, lifecycle, database, jobs, support, audit, tenantIdentity),
          inject: [TenantContextService, TenantAuthorizationService, AssetCatalogService, OnboardingSagaRecoveryService,
            ConnectionLifecycleService, DURABLE_WORK_DATABASE, DURABLE_JOB_STORE, SUPPORT_OPERATIONS_AUTHORIZATION_PORT,
            PRIVACY_AUDIT_WRITER, OPERATIONS_TENANT_IDENTITY_AUTHORIZATION_PORT] },
      ],
    };
  }
}
