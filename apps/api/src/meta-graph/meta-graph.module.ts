import { DynamicModule, Module } from '@nestjs/common';
import { CredentialResolverService } from '../credentials/credential-resolver.service.js';
import { META_APP_CONFIG_REGISTRY } from '../meta-config/meta-app-config.registry.js';
import type { MetaAppConfigRegistry } from '../meta-config/meta-app-config.registry.js';
import { MetaGraphClient } from './meta-graph.client.js';
import { NodeMetaGraphTransport } from './meta-graph.transport.js';
import { META_GRAPH_METRICS, META_GRAPH_TRANSPORT } from './meta-graph.types.js';
import type { MetaGraphMetrics } from './meta-graph.types.js';
import { OBSERVABILITY_REGISTRY } from '../observability/observability.registry.js';

@Module({})
export class MetaGraphModule {
  /** Reuse the exact dynamic module instances registered by ApiModule; do not create another vault/resolver graph. */
  static register(metaAssetsModule: DynamicModule, metaAppConfigModule: DynamicModule): DynamicModule {
    return {
      module: MetaGraphModule,
      imports: [metaAssetsModule, metaAppConfigModule],
      providers: [
        { provide: META_GRAPH_TRANSPORT, useFactory: (configs: MetaAppConfigRegistry) => new NodeMetaGraphTransport(configs),
          inject: [META_APP_CONFIG_REGISTRY] },
        { provide: META_GRAPH_METRICS, useExisting: OBSERVABILITY_REGISTRY },
        { provide: MetaGraphClient, useFactory: (configs: MetaAppConfigRegistry, credentials: CredentialResolverService,
          transport: NodeMetaGraphTransport, metrics: MetaGraphMetrics) => new MetaGraphClient(configs, credentials, transport, metrics),
          inject: [META_APP_CONFIG_REGISTRY, CredentialResolverService, META_GRAPH_TRANSPORT, META_GRAPH_METRICS] },
      ],
      exports: [MetaGraphClient],
    };
  }
}
