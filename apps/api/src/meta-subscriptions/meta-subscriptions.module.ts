import { DynamicModule, Module } from '@nestjs/common';
import { CredentialResolverService } from '../credentials/credential-resolver.service.js';
import { DURABLE_WORK_DATABASE } from '../jobs/jobs.module.js';
import { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import { META_APP_CONFIG_REGISTRY } from '../meta-config/meta-app-config.registry.js';
import type { MetaAppConfigRegistry } from '../meta-config/meta-app-config.registry.js';
import { MetaGraphClient } from '../meta-graph/meta-graph.client.js';
import { META_SUBSCRIPTION_CATALOG, META_SUBSCRIPTION_PROVIDER, META_SUBSCRIPTION_STORE } from './meta-subscriptions.types.js';
import { MetaSubscriptionService } from './meta-subscription.service.js';
import { MetaGraphSubscriptionProvider } from './meta-graph-subscription.provider.js';
import { MysqlMetaSubscriptionCatalog } from './mysql-meta-subscription.catalog.js';
import { MysqlMetaSubscriptionStore } from './mysql-meta-subscription.store.js';

/** Integrators pass the already-created dynamic module instances to preserve one DB, resolver and Graph client. */
@Module({})
export class MetaSubscriptionsModule {
  static register(metaAssetsModule: DynamicModule, metaGraphModule: DynamicModule,
    metaAppConfigModule: DynamicModule): DynamicModule {
    return {
      module: MetaSubscriptionsModule,
      imports: [metaAssetsModule, metaGraphModule, metaAppConfigModule],
      providers: [
        { provide: META_SUBSCRIPTION_STORE, useFactory: (database: DurableWorkDatabase) => new MysqlMetaSubscriptionStore(database),
          inject: [DURABLE_WORK_DATABASE] },
        { provide: META_SUBSCRIPTION_CATALOG, useFactory: (database: DurableWorkDatabase) => new MysqlMetaSubscriptionCatalog(database),
          inject: [DURABLE_WORK_DATABASE] },
        { provide: META_SUBSCRIPTION_PROVIDER, useFactory: (configs: MetaAppConfigRegistry, credentials: CredentialResolverService,
          graph: MetaGraphClient) => new MetaGraphSubscriptionProvider(configs, credentials, graph),
          inject: [META_APP_CONFIG_REGISTRY, CredentialResolverService, MetaGraphClient] },
        { provide: MetaSubscriptionService, useFactory: (store: MysqlMetaSubscriptionStore,
          catalog: MysqlMetaSubscriptionCatalog, provider: MetaGraphSubscriptionProvider) =>
          new MetaSubscriptionService(store, catalog, provider),
          inject: [META_SUBSCRIPTION_STORE, META_SUBSCRIPTION_CATALOG, META_SUBSCRIPTION_PROVIDER] },
      ],
      exports: [MetaSubscriptionService, META_SUBSCRIPTION_STORE, META_SUBSCRIPTION_CATALOG, META_SUBSCRIPTION_PROVIDER],
    };
  }
}
