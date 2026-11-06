import {
  buildMetaBootstrap,
  type MetaAppConfiguration,
  type MetaBootstrapResponse,
} from './meta-app-config.configuration.js';
import { META_CAPABILITY_MANIFEST, type MetaAuthenticationVariant, type MetaProductFlow } from './capability-manifest.js';

export const META_APP_CONFIG_REGISTRY = Symbol('META_APP_CONFIG_REGISTRY');

export class MetaAppConfigRegistry {
  constructor(private readonly profiles: readonly MetaAppConfiguration[] = []) {}

  /** Resolve only the exact server-selected flow, auth variant and runtime environment. */
  resolve(
    flowVariant: MetaProductFlow,
    authVariant: MetaAuthenticationVariant,
    environment: MetaAppConfiguration['environment'],
  ): MetaAppConfiguration | undefined {
    const profile = this.profiles.find((item) => item.flowVariant === flowVariant &&
      item.authVariant === authVariant && item.environment === environment);
    if (!profile) return undefined;
    const availability = this.bootstrap().profiles.find((item) =>
      item.flowVariant === flowVariant && item.authVariant === authVariant);
    return availability?.enabled ? profile : undefined;
  }

  /** Safe UI/bootstrap projection; no credential reference, redirect URI or private setting escapes. */
  bootstrap(): MetaBootstrapResponse {
    return buildMetaBootstrap(this.profiles);
  }

  /** Versioned server-side policy lookup used by later provider adapters. */
  capabilityPolicy(flowVariant: MetaProductFlow, authVariant: MetaAuthenticationVariant) {
    return META_CAPABILITY_MANIFEST.filter((entry) => entry.flowVariant === flowVariant && entry.authVariant === authVariant);
  }
}
