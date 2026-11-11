import { DynamicModule, Module } from '@nestjs/common';
import type { ApiEnvironment } from '../config/environment.js';
import { DURABLE_WORK_DATABASE } from '../jobs/jobs.module.js';
import { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import { MetaWebhookController } from './meta-webhook.controller.js';
import {
  FailClosedMetaWebhookPayloadProtector,
  FailClosedMetaWebhookSecretProvider,
  MetaWebhookConfigurationResolver,
  MetaWebhookIngressService,
  metaWebhookConfigurationProfiles,
} from './meta-webhook-ingress.service.js';
import { MetaWebhookRepository } from './meta-webhook.repository.js';
import { MetaWebhookReplayService, FailClosedMetaWebhookReplayAuthorization } from './meta-webhook-replay.service.js';
import { FailClosedMetaWebhookItemProcessor, MetaWebhookWorker } from './meta-webhook-worker.js';
import {
  META_WEBHOOK_ITEM_PROCESSOR,
  META_WEBHOOK_PAYLOAD_PROTECTOR,
  META_WEBHOOK_REPLAY_AUTHORIZATION,
  META_WEBHOOK_SECRET_PROVIDER,
  type MetaWebhookItemProcessor,
  type MetaWebhookPayloadProtector,
  type MetaWebhookReplayAuthorization,
  type MetaWebhookSecretProvider,
} from './meta-webhook.types.js';
import { AuditEventWriter } from '../privacy/audit.service.js';
import { MetaLifecycleCallbackController } from '../meta-lifecycle/meta-lifecycle-callback.controller.js';
import { MetaLifecycleCallbackIngressService, FailClosedMetaLifecycleCallbackVerifier } from '../meta-lifecycle/meta-lifecycle-callback.service.js';
import { MysqlMetaLifecycleCallbackProcessor, FailClosedMetaLifecycleCallbackTargetResolver } from '../meta-lifecycle/mysql-connection-lifecycle.repository.js';
import {
  META_LIFECYCLE_CALLBACK_PROCESSOR,
  META_LIFECYCLE_CALLBACK_TARGET_RESOLVER,
  META_LIFECYCLE_CALLBACK_VERIFIER,
  type MetaLifecycleCallbackProcessor,
  type MetaLifecycleCallbackTargetResolver,
  type MetaLifecycleCallbackVerifier,
} from '../meta-lifecycle/connection-lifecycle.types.js';

export interface MetaWebhookAdapters {
  readonly secrets?: MetaWebhookSecretProvider;
  readonly payloadProtector?: MetaWebhookPayloadProtector;
  readonly processor?: MetaWebhookItemProcessor;
  readonly replayAuthorization?: MetaWebhookReplayAuthorization;
  readonly lifecycleVerifier?: MetaLifecycleCallbackVerifier;
  readonly lifecycleTargetResolver?: MetaLifecycleCallbackTargetResolver;
}

@Module({})
export class MetaWebhooksModule {
  static register(environment: ApiEnvironment, durableWorkModule: DynamicModule, adapters: MetaWebhookAdapters = {}): DynamicModule {
    return {
      module: MetaWebhooksModule,
      // Reuse the exact shared jobs module instance exported by MetaAssetsModule.
      imports: [durableWorkModule],
      controllers: [MetaWebhookController, MetaLifecycleCallbackController],
      providers: [
        { provide: META_LIFECYCLE_CALLBACK_VERIFIER, useValue: adapters.lifecycleVerifier ?? new FailClosedMetaLifecycleCallbackVerifier() },
        { provide: META_LIFECYCLE_CALLBACK_TARGET_RESOLVER, useValue: adapters.lifecycleTargetResolver ?? new FailClosedMetaLifecycleCallbackTargetResolver() },
        {
          provide: META_LIFECYCLE_CALLBACK_PROCESSOR,
          useFactory: (database: DurableWorkDatabase, targets: MetaLifecycleCallbackTargetResolver) =>
            new MysqlMetaLifecycleCallbackProcessor(database, new AuditEventWriter(database), targets),
          inject: [DURABLE_WORK_DATABASE, META_LIFECYCLE_CALLBACK_TARGET_RESOLVER],
        },
        {
          provide: MetaLifecycleCallbackIngressService,
          useFactory: (verifier: MetaLifecycleCallbackVerifier, processor: MetaLifecycleCallbackProcessor) =>
            new MetaLifecycleCallbackIngressService(verifier, processor),
          inject: [META_LIFECYCLE_CALLBACK_VERIFIER, META_LIFECYCLE_CALLBACK_PROCESSOR],
        },
        { provide: META_WEBHOOK_SECRET_PROVIDER, useValue: adapters.secrets ?? new FailClosedMetaWebhookSecretProvider() },
        { provide: META_WEBHOOK_PAYLOAD_PROTECTOR, useValue: adapters.payloadProtector ?? new FailClosedMetaWebhookPayloadProtector() },
        { provide: META_WEBHOOK_ITEM_PROCESSOR, useValue: adapters.processor ?? new FailClosedMetaWebhookItemProcessor() },
        { provide: META_WEBHOOK_REPLAY_AUTHORIZATION, useValue: adapters.replayAuthorization ?? new FailClosedMetaWebhookReplayAuthorization() },
        {
          provide: MetaWebhookConfigurationResolver,
          useFactory: () => new MetaWebhookConfigurationResolver(metaWebhookConfigurationProfiles(environment), environment.nodeEnv),
        },
        {
          provide: MetaWebhookRepository,
          useFactory: (database: DurableWorkDatabase) => new MetaWebhookRepository(database),
          inject: [DURABLE_WORK_DATABASE],
        },
        {
          provide: MetaWebhookIngressService,
          useFactory: (configuration: MetaWebhookConfigurationResolver, secrets: MetaWebhookSecretProvider,
            protector: MetaWebhookPayloadProtector, repository: MetaWebhookRepository) =>
            new MetaWebhookIngressService(configuration, secrets, protector, repository),
          inject: [MetaWebhookConfigurationResolver, META_WEBHOOK_SECRET_PROVIDER, META_WEBHOOK_PAYLOAD_PROTECTOR, MetaWebhookRepository],
        },
        {
          provide: MetaWebhookWorker,
          useFactory: (repository: MetaWebhookRepository, protector: MetaWebhookPayloadProtector, processor: MetaWebhookItemProcessor) =>
            new MetaWebhookWorker(repository, protector, processor, `meta-webhook-worker:${process.pid}`),
          inject: [MetaWebhookRepository, META_WEBHOOK_PAYLOAD_PROTECTOR, META_WEBHOOK_ITEM_PROCESSOR],
        },
        {
          provide: MetaWebhookReplayService,
          useFactory: (repository: MetaWebhookRepository, protector: MetaWebhookPayloadProtector,
            authorization: MetaWebhookReplayAuthorization) => new MetaWebhookReplayService(
              metaWebhookConfigurationProfiles(environment), environment.nodeEnv, repository, protector, authorization),
          inject: [MetaWebhookRepository, META_WEBHOOK_PAYLOAD_PROTECTOR, META_WEBHOOK_REPLAY_AUTHORIZATION],
        },
      ],
      exports: [MetaWebhookIngressService, MetaWebhookWorker, MetaWebhookReplayService],
    };
  }
}
