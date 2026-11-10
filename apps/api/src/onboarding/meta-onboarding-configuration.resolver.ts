import type { RuntimeEnvironment } from '../config/environment.js';
import type { MetaAppConfigRegistry } from '../meta-config/meta-app-config.registry.js';
import { metaProfileForOnboardingFlow } from './onboarding-session.service.js';
import type { OnboardingFlowConfiguration, OnboardingFlowConfigurationResolver, OnboardingFlowVariant } from './onboarding-session.types.js';

/** Adapts M4.01's exact profile/evidence gate to the onboarding session contract. */
export class MetaOnboardingConfigurationResolver implements OnboardingFlowConfigurationResolver {
  constructor(private readonly registry: MetaAppConfigRegistry, private readonly environment: RuntimeEnvironment) {}

  resolve(flowVariant: OnboardingFlowVariant): OnboardingFlowConfiguration | undefined {
    const profile = metaProfileForOnboardingFlow(flowVariant);
    const configuration = this.registry.resolve(profile.flowVariant, profile.authVariant, this.environment);
    if (!configuration) return undefined;
    const publicProfile = this.registry.bootstrap().profiles.find((item) =>
      item.flowVariant === profile.flowVariant && item.authVariant === profile.authVariant);
    if (!publicProfile?.enabled) return undefined;
    return Object.freeze({
      configurationRef: configuration.configurationRef,
      providerAppId: configuration.providerAppId,
      providerEnvironment: configuration.environment,
      authVariant: profile.authVariant,
      capabilityManifestVersion: configuration.capabilityManifestVersion,
      graphApiVersion: configuration.versions.graphApi.value,
    });
  }
}
