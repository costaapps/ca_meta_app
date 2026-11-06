import { DynamicModule, Module } from '@nestjs/common';
import type { ApiEnvironment } from '../config/environment.js';
import { PortalSessionVerifier } from '../identity/identity.trust.js';
import { TenantAuthorizationService, TenantContextService } from '../identity/identity.service.js';
import { PortalSessionGuard } from '../identity/portal-session.guard.js';
import {
  ONBOARDING_COMPLETION_PORT,
  ONBOARDING_PROVIDER_LAUNCH,
  ONBOARDING_SESSION_STORE,
} from './onboarding-session.types.js';
import { OnboardingCompletionService, OnboardingSessionService, OnboardingStateSigner, UnavailableOnboardingProviderLaunch } from './onboarding-session.service.js';
import { MysqlOnboardingSessionStore } from './mysql-onboarding-session.store.js';
import { ONBOARDING_STATUS_READER, OnboardingStatusController } from './onboarding-status.controller.js';
import { OnboardingCodeSubmissionController, MetaProviderCallbackController, OnboardingSagaRecoveryController } from './onboarding-code.controller.js';
import { OnboardingCodeSubmissionService, ONBOARDING_CODE_PROTECTOR, ONBOARDING_CODE_STORE,
  ONBOARDING_CONFIGURATION_RESOLVER } from './onboarding-code-submission.service.js';
import { OnboardingCodeProtector } from './onboarding-code-crypto.js';
import { MysqlOnboardingCodeSubmissionStore } from './onboarding-code-submission.store.js';
import { META_ONBOARDING_SAGA_ADAPTER } from './onboarding-saga.types.js';
import { MetaOnboardingConfigurationResolver } from './meta-onboarding-configuration.resolver.js';
import { MetaAppConfigRegistry, META_APP_CONFIG_REGISTRY } from '../meta-config/meta-app-config.registry.js';
import { JobsModule, DURABLE_WORK_DATABASE, DURABLE_JOB_STORE } from '../jobs/jobs.module.js';
import type { DynamicModule as NestDynamicModule } from '@nestjs/common';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { DurableJobStore } from '../jobs/job-store.js';
import type { OnboardingFlowConfigurationResolver } from './onboarding-session.types.js';
import type { OnboardingSagaAdapter } from './onboarding-saga.types.js';
import { MysqlOnboardingSagaRecoveryStore, ONBOARDING_SAGA_RECOVERY_STORE, OnboardingSagaRecoveryService,
  type OnboardingSagaRecoveryStore } from './onboarding-saga-recovery.js';

@Module({})
export class OnboardingStatusModule {
  static register(identityModule: DynamicModule, environment: ApiEnvironment, metaAppConfigModule: NestDynamicModule): DynamicModule {
    return {
      module: OnboardingStatusModule,
      imports: [identityModule, metaAppConfigModule, JobsModule.register(environment)],
      controllers: [OnboardingStatusController, OnboardingCodeSubmissionController, MetaProviderCallbackController, OnboardingSagaRecoveryController],
      providers: [
        {
          provide: PortalSessionGuard,
          useFactory: (sessions: PortalSessionVerifier) => new PortalSessionGuard(sessions),
          inject: [PortalSessionVerifier],
        },
        { provide: ONBOARDING_SESSION_STORE, useFactory: () => new MysqlOnboardingSessionStore(environment.database) },
        { provide: OnboardingStateSigner, useValue: new OnboardingStateSigner(environment.onboardingStateSigningKey) },
        { provide: ONBOARDING_CODE_PROTECTOR, useValue: new OnboardingCodeProtector(environment.onboardingStateSigningKey) },
        { provide: META_ONBOARDING_SAGA_ADAPTER, useValue: undefined },
        {
          provide: ONBOARDING_CONFIGURATION_RESOLVER,
          useFactory: (registry: MetaAppConfigRegistry) => new MetaOnboardingConfigurationResolver(registry, environment.nodeEnv),
          inject: [META_APP_CONFIG_REGISTRY],
        },
        {
          provide: ONBOARDING_CODE_STORE,
          useFactory: (database: DurableWorkDatabase, jobs: DurableJobStore) => new MysqlOnboardingCodeSubmissionStore(database, jobs),
          inject: [DURABLE_WORK_DATABASE, DURABLE_JOB_STORE],
        },
        {
          provide: ONBOARDING_SAGA_RECOVERY_STORE,
          useFactory: (database: DurableWorkDatabase, jobs: DurableJobStore) => new MysqlOnboardingSagaRecoveryStore(database, jobs),
          inject: [DURABLE_WORK_DATABASE, DURABLE_JOB_STORE],
        },
        {
          provide: OnboardingSagaRecoveryService,
          useFactory: (
            sessions: MysqlOnboardingSessionStore,
            contexts: TenantContextService,
            authorization: TenantAuthorizationService,
            configurations: OnboardingFlowConfigurationResolver,
            recovery: OnboardingSagaRecoveryStore,
            adapter: OnboardingSagaAdapter | undefined,
          ) => new OnboardingSagaRecoveryService(sessions, contexts, authorization, configurations, recovery, adapter),
          inject: [ONBOARDING_SESSION_STORE, TenantContextService, TenantAuthorizationService,
            ONBOARDING_CONFIGURATION_RESOLVER, ONBOARDING_SAGA_RECOVERY_STORE, META_ONBOARDING_SAGA_ADAPTER],
        },
        { provide: ONBOARDING_PROVIDER_LAUNCH, useClass: UnavailableOnboardingProviderLaunch },
        {
          provide: OnboardingSessionService,
          useFactory: (
            store: MysqlOnboardingSessionStore,
            contexts: TenantContextService,
            authorization: TenantAuthorizationService,
            signer: OnboardingStateSigner,
            launch: UnavailableOnboardingProviderLaunch,
            configurationResolver: OnboardingFlowConfigurationResolver,
          ) => new OnboardingSessionService(store, contexts, authorization, signer, launch, () => new Date(), configurationResolver),
          inject: [ONBOARDING_SESSION_STORE, TenantContextService, TenantAuthorizationService,
            OnboardingStateSigner, ONBOARDING_PROVIDER_LAUNCH, ONBOARDING_CONFIGURATION_RESOLVER],
        },
        {
          provide: OnboardingCodeSubmissionService,
          useFactory: (
            sessions: MysqlOnboardingSessionStore,
            contexts: TenantContextService,
            authorization: TenantAuthorizationService,
            configurations: OnboardingFlowConfigurationResolver,
            protector: OnboardingCodeProtector,
            codes: MysqlOnboardingCodeSubmissionStore,
            adapter: OnboardingSagaAdapter | undefined,
          ) => new OnboardingCodeSubmissionService(sessions, contexts, authorization, configurations, protector, codes, adapter),
          inject: [ONBOARDING_SESSION_STORE, TenantContextService, TenantAuthorizationService,
            ONBOARDING_CONFIGURATION_RESOLVER, ONBOARDING_CODE_PROTECTOR, ONBOARDING_CODE_STORE, META_ONBOARDING_SAGA_ADAPTER],
        },
        { provide: ONBOARDING_STATUS_READER, useExisting: OnboardingSessionService },
        {
          provide: OnboardingCompletionService,
          useFactory: (store: MysqlOnboardingSessionStore) => new OnboardingCompletionService(store),
          inject: [ONBOARDING_SESSION_STORE],
        },
        { provide: ONBOARDING_COMPLETION_PORT, useExisting: OnboardingCompletionService },
      ],
      exports: [ONBOARDING_COMPLETION_PORT, OnboardingCompletionService],
    };
  }
}
