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

export interface MetaWebhookAdapters {
  readonly secrets?: MetaWebhookSecretProvider;
  readonly payloadProtector?: MetaWebhookPayloadProtector;
  readonly processor?: MetaWebhookItemProcessor;
  readonly replayAuthorization?: MetaWebhookReplayAuthorization;
}

@Module({})
export class MetaWebhooksModule {
  static register(environment: ApiEnvironment, durableWorkModule: DynamicModule, adapters: MetaWebhookAdapters = {}): DynamicModule {
    return {
      module: MetaWebhooksModule,
      // Reuse the exact shared jobs module instance exported by MetaAssetsModule.
      imports: [durableWorkModule],
      controllers: [MetaWebhookController],
      providers: [
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
