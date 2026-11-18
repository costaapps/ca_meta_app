export type MetaProductFlow = 'FACEBOOK' | 'INSTAGRAM' | 'WHATSAPP_EXCLUSIVE' | 'WHATSAPP_COEXISTENCE';
export type MetaAuthVariant = 'FACEBOOK_LOGIN_FOR_BUSINESS' | 'INSTAGRAM_VIA_FACEBOOK_LOGIN' | 'INSTAGRAM_LOGIN' |
  'WHATSAPP_EMBEDDED_SIGNUP' | 'WHATSAPP_BUSINESS_APP_ONBOARDING';
export type OnboardingFlowVariant = 'FACEBOOK_LOGIN' | 'INSTAGRAM_VIA_FACEBOOK_LOGIN' | 'INSTAGRAM_LOGIN' |
  'WHATSAPP_CLOUD_API' | 'WHATSAPP_COEXISTENCE';

export interface OnboardingCapability {
  readonly operation: string;
  readonly enabled: boolean;
  readonly reasonCode: string | null;
}

export interface OnboardingFlowProfile {
  readonly product: MetaProductFlow;
  readonly authVariant: MetaAuthVariant;
  readonly flowVariant: OnboardingFlowVariant;
  readonly enabled: boolean;
  readonly reasonCode: string | null;
  readonly availability: string;
  readonly capabilities: readonly OnboardingCapability[];
  readonly requestedCapabilities: readonly string[];
  readonly blockedReason: string | null;
}

export interface OnboardingFlowGroup {
  readonly id: MetaProductFlow;
  readonly title: string;
  readonly summary: string;
}

export const ONBOARDING_FLOW_GROUPS: readonly OnboardingFlowGroup[] = Object.freeze([
  Object.freeze({ id: 'FACEBOOK', title: 'Facebook', summary: 'Conecte uma Página do Facebook.' }),
  Object.freeze({ id: 'INSTAGRAM', title: 'Instagram', summary: 'Escolha a autorização apropriada para a conta profissional.' }),
  Object.freeze({ id: 'WHATSAPP_EXCLUSIVE', title: 'WhatsApp API', summary: 'Conecte um número dedicado à operação do Msg4.' }),
  Object.freeze({ id: 'WHATSAPP_COEXISTENCE', title: 'WhatsApp + aplicativo', summary: 'Conecte cada número por uma autorização Coexistence individual.' }),
]);

const PRODUCT_FLOWS = new Set<string>(['FACEBOOK', 'INSTAGRAM', 'WHATSAPP_EXCLUSIVE', 'WHATSAPP_COEXISTENCE']);
const AUTH_FLOWS = new Set<string>([
  'FACEBOOK_LOGIN_FOR_BUSINESS', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN',
  'WHATSAPP_EMBEDDED_SIGNUP', 'WHATSAPP_BUSINESS_APP_ONBOARDING',
]);
const PROFILE_KEYS = new Set([
  'flowVariant', 'authVariant', 'enabled', 'reasonCode', 'capabilities', 'providerAppId', 'publicConfigId',
  'appDomain', 'javascriptSdkVersion', 'embeddedSignupVersion',
]);
const CAPABILITY_OPERATIONS = new Set([
  'ASSET_DISCOVERY', 'SEND_MESSAGE', 'MANAGE_COMMENTS', 'MANAGE_TEMPLATES', 'READ_STATUS',
  'SUBSCRIBE_WEBHOOKS', 'SYNC_HISTORY', 'PHONE_REGISTRATION_CONVENTIONAL',
]);
const ONBOARDING_VARIANTS: readonly OnboardingFlowVariant[] = Object.freeze([
  'FACEBOOK_LOGIN', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN', 'WHATSAPP_CLOUD_API', 'WHATSAPP_COEXISTENCE',
]);
const AVAILABILITY_VALUES = new Set(['CONFIGURATION_MISSING', 'ADAPTER_UNAVAILABLE', 'UNKNOWN', 'AVAILABLE']);
const ENVIRONMENT_VALUES = new Set(['development', 'test', 'staging', 'production']);
const JOURNEYS_BY_VARIANT: Readonly<Record<OnboardingFlowVariant, readonly OnboardingFlowVariant[]>> = Object.freeze({
  FACEBOOK_LOGIN: Object.freeze(['FACEBOOK_LOGIN'] as const),
  INSTAGRAM_VIA_FACEBOOK_LOGIN: Object.freeze(['INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN'] as const),
  INSTAGRAM_LOGIN: Object.freeze(['INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN'] as const),
  WHATSAPP_CLOUD_API: Object.freeze(['WHATSAPP_CLOUD_API'] as const),
  WHATSAPP_COEXISTENCE: Object.freeze(['WHATSAPP_COEXISTENCE'] as const),
});
const VARIANT_PRODUCT: Readonly<Record<OnboardingFlowVariant, MetaProductFlow>> = Object.freeze({
  FACEBOOK_LOGIN: 'FACEBOOK',
  INSTAGRAM_VIA_FACEBOOK_LOGIN: 'INSTAGRAM',
  INSTAGRAM_LOGIN: 'INSTAGRAM',
  WHATSAPP_CLOUD_API: 'WHATSAPP_EXCLUSIVE',
  WHATSAPP_COEXISTENCE: 'WHATSAPP_COEXISTENCE',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function mappedFlow(product: MetaProductFlow, auth: MetaAuthVariant): OnboardingFlowVariant | undefined {
  if (product === 'FACEBOOK' && auth === 'FACEBOOK_LOGIN_FOR_BUSINESS') return 'FACEBOOK_LOGIN';
  if (product === 'INSTAGRAM' && auth === 'INSTAGRAM_VIA_FACEBOOK_LOGIN') return 'INSTAGRAM_VIA_FACEBOOK_LOGIN';
  if (product === 'INSTAGRAM' && auth === 'INSTAGRAM_LOGIN') return 'INSTAGRAM_LOGIN';
  if (product === 'WHATSAPP_EXCLUSIVE' && auth === 'WHATSAPP_EMBEDDED_SIGNUP') return 'WHATSAPP_CLOUD_API';
  if (product === 'WHATSAPP_COEXISTENCE' && auth === 'WHATSAPP_BUSINESS_APP_ONBOARDING') return 'WHATSAPP_COEXISTENCE';
  return undefined;
}

function optionalPublicFieldsAreSafe(profile: Record<string, unknown>): boolean {
  return (profile['providerAppId'] === undefined || (typeof profile['providerAppId'] === 'string' && /^[0-9]{1,32}$/.test(profile['providerAppId']))) &&
    (profile['publicConfigId'] === undefined || (typeof profile['publicConfigId'] === 'string' && profile['publicConfigId'].length >= 1 && profile['publicConfigId'].length <= 96)) &&
    (profile['appDomain'] === undefined || (typeof profile['appDomain'] === 'string' && profile['appDomain'].length >= 1 && profile['appDomain'].length <= 253)) &&
    (profile['javascriptSdkVersion'] === undefined || (typeof profile['javascriptSdkVersion'] === 'string' && /^v[0-9]{1,2}\.[0-9]{1,3}$/.test(profile['javascriptSdkVersion']))) &&
    (profile['embeddedSignupVersion'] === undefined || (typeof profile['embeddedSignupVersion'] === 'string' && /^v[0-9]{1,2}\.[0-9]{1,3}$/.test(profile['embeddedSignupVersion'])));
}

/** Parses the M5.01 bootstrap contract and coalesces only equivalent app-configuration flow groups. */
export function parseOnboardingFlowCatalog(value: unknown, flowListValue: unknown): readonly OnboardingFlowProfile[] | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !['requestId', 'manifestVersion', 'profiles'].includes(key)) ||
      typeof value['requestId'] !== 'string' || value['requestId'].length < 1 || value['requestId'].length > 128 ||
      value['manifestVersion'] !== 'm4.04-2026-11-10.1' || !Array.isArray(value['profiles']) || value['profiles'].length !== 5 ||
      !isRecord(flowListValue) || Object.keys(flowListValue).some((key) => !['items', 'truncated', 'requestId'].includes(key)) ||
      typeof flowListValue['requestId'] !== 'string' || flowListValue['requestId'].length < 1 || flowListValue['requestId'].length > 128 ||
      flowListValue['truncated'] !== false ||
      !Array.isArray(flowListValue['items']) || flowListValue['items'].length < 5 ||
      flowListValue['items'].length > 80 || flowListValue['items'].length % ONBOARDING_VARIANTS.length !== 0) return undefined;

  type FlowBehavior = {
    readonly flowVariant: MetaProductFlow;
    readonly journeys: readonly OnboardingFlowVariant[];
    readonly environment: string;
    readonly enabled: boolean;
    readonly availability: string;
    readonly prerequisites: {
      readonly metaAppConfigured: boolean;
      readonly serverAdapterRegistered: boolean;
      readonly tenantFeatureFlag: 'ENABLED' | 'DISABLED' | 'UNKNOWN';
    };
    readonly requestedCapabilities: readonly string[];
  };
  const groups = new Map<string, Map<OnboardingFlowVariant, FlowBehavior>>();
  const groupEnvironments = new Map<string, string>();
  for (const item of flowListValue['items']) {
    const allowed = ['variant', 'flowVariant', 'journeys', 'appConfigurationRef', 'environment', 'enabled', 'availability', 'prerequisites', 'requestedCapabilities'];
    if (!isRecord(item) || Object.keys(item).some((key) => !allowed.includes(key)) ||
        typeof item['variant'] !== 'string' || !ONBOARDING_VARIANTS.includes(item['variant'] as OnboardingFlowVariant) ||
        (item['appConfigurationRef'] !== null && !isUuid(item['appConfigurationRef'])) ||
        typeof item['flowVariant'] !== 'string' || !PRODUCT_FLOWS.has(item['flowVariant']) ||
        !Array.isArray(item['journeys']) || item['journeys'].length < 1 || item['journeys'].length > 2 ||
        !item['journeys'].every((journey) => typeof journey === 'string' &&
          ONBOARDING_VARIANTS.includes(journey as OnboardingFlowVariant)) ||
        typeof item['environment'] !== 'string' || !ENVIRONMENT_VALUES.has(item['environment']) ||
        typeof item['enabled'] !== 'boolean' ||
        typeof item['availability'] !== 'string' || !AVAILABILITY_VALUES.has(item['availability']) ||
        item['flowVariant'] !== VARIANT_PRODUCT[item['variant'] as OnboardingFlowVariant] ||
        JSON.stringify(item['journeys']) !== JSON.stringify(JOURNEYS_BY_VARIANT[item['variant'] as OnboardingFlowVariant]) ||
        !isRecord(item['prerequisites']) || Object.keys(item['prerequisites']).some((key) =>
          !['metaAppConfigured', 'serverAdapterRegistered', 'tenantFeatureFlag'].includes(key)) ||
        typeof item['prerequisites']['metaAppConfigured'] !== 'boolean' ||
        typeof item['prerequisites']['serverAdapterRegistered'] !== 'boolean' ||
        !['ENABLED', 'DISABLED', 'UNKNOWN'].includes(String(item['prerequisites']['tenantFeatureFlag'])) ||
        !Array.isArray(item['requestedCapabilities']) || item['requestedCapabilities'].length > 32 ||
        !item['requestedCapabilities'].every((capability) => typeof capability === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(capability)) ||
        new Set(item['requestedCapabilities']).size !== item['requestedCapabilities'].length) return undefined;
    const variant = item['variant'] as OnboardingFlowVariant;
    const appConfigurationRef = item['appConfigurationRef'];
    const groupKey = typeof appConfigurationRef === 'string' ? appConfigurationRef.toLowerCase() : 'unconfigured';
    const group = groups.get(groupKey) ?? new Map<OnboardingFlowVariant, FlowBehavior>();
    const prerequisites = item['prerequisites'] as Record<string, unknown>;
    const behavior: FlowBehavior = Object.freeze({
      flowVariant: item['flowVariant'] as MetaProductFlow,
      journeys: Object.freeze([...item['journeys']] as OnboardingFlowVariant[]),
      environment: item['environment'],
      enabled: item['enabled'],
      availability: item['availability'],
      prerequisites: Object.freeze({
        metaAppConfigured: prerequisites['metaAppConfigured'] as boolean,
        serverAdapterRegistered: prerequisites['serverAdapterRegistered'] as boolean,
        tenantFeatureFlag: prerequisites['tenantFeatureFlag'] as FlowBehavior['prerequisites']['tenantFeatureFlag'],
      }),
      requestedCapabilities: Object.freeze([...item['requestedCapabilities']]),
    });
    if (group.has(variant)) return undefined;
    const priorEnvironment = groupEnvironments.get(groupKey);
    if (priorEnvironment !== undefined && priorEnvironment !== behavior.environment) return undefined;
    groupEnvironments.set(groupKey, behavior.environment);
    group.set(variant, behavior);
    groups.set(groupKey, group);
  }
  if (groups.size < 1 || groups.size > 16 || [...groups.values()].some((group) => group.size !== ONBOARDING_VARIANTS.length)) return undefined;

  const flowDefinitions = new Map<OnboardingFlowVariant, FlowBehavior>();
  for (const variant of ONBOARDING_VARIANTS) {
    const behaviors = [...groups.values()].map((group) => group.get(variant));
    const first = behaviors[0];
    if (!first || behaviors.some((behavior) => JSON.stringify(behavior) !== JSON.stringify(first))) return undefined;
    flowDefinitions.set(variant, first);
  }

  const profiles: OnboardingFlowProfile[] = [];
  const seen = new Set<string>();
  for (const item of value['profiles']) {
    if (!isRecord(item) || Object.keys(item).some((key) => !PROFILE_KEYS.has(key)) ||
        typeof item['flowVariant'] !== 'string' || !PRODUCT_FLOWS.has(item['flowVariant']) ||
        typeof item['authVariant'] !== 'string' || !AUTH_FLOWS.has(item['authVariant']) ||
        typeof item['enabled'] !== 'boolean' ||
        !(item['reasonCode'] === null || (typeof item['reasonCode'] === 'string' && item['reasonCode'].length <= 96)) ||
        !Array.isArray(item['capabilities']) || item['capabilities'].length > 16 || !optionalPublicFieldsAreSafe(item)) return undefined;

    const product = item['flowVariant'] as MetaProductFlow;
    const authVariant = item['authVariant'] as MetaAuthVariant;
    const flowVariant = mappedFlow(product, authVariant);
    const key = `${product}:${authVariant}`;
    const flowDefinition = flowVariant ? flowDefinitions.get(flowVariant) : undefined;
    if (!flowVariant || !flowDefinition || seen.has(key)) return undefined;
    seen.add(key);

    const capabilities: OnboardingCapability[] = [];
    for (const capability of item['capabilities']) {
      if (!isRecord(capability) || Object.keys(capability).some((name) => !['operation', 'enabled', 'reasonCode'].includes(name)) ||
          typeof capability['operation'] !== 'string' || !CAPABILITY_OPERATIONS.has(capability['operation']) ||
          typeof capability['enabled'] !== 'boolean' ||
          !(capability['reasonCode'] === null || (typeof capability['reasonCode'] === 'string' && capability['reasonCode'].length <= 96))) return undefined;
      capabilities.push(Object.freeze({
        operation: capability['operation'], enabled: capability['enabled'], reasonCode: capability['reasonCode'],
      }));
    }

    const conventionalCoexistence = product === 'WHATSAPP_COEXISTENCE' &&
      capabilities.some((capability) => capability.operation === 'PHONE_REGISTRATION_CONVENTIONAL' && capability.enabled);
    const enabledCapabilities = capabilities.filter((capability) => capability.enabled).map((capability) => capability.operation);
    const blockedReason = conventionalCoexistence
      ? 'O registro convencional não está disponível no fluxo Coexistence.'
      : item['enabled'] && enabledCapabilities.length === 0
        ? 'Nenhuma capacidade deste fluxo está habilitada.'
        : null;
    const enabled = item['enabled'] && flowDefinition.enabled && flowDefinition.availability === 'AVAILABLE' && blockedReason === null;
    profiles.push(Object.freeze({
      product,
      authVariant,
      flowVariant,
      enabled,
      reasonCode: item['reasonCode'],
      availability: flowDefinition.availability,
      capabilities: Object.freeze(capabilities),
      requestedCapabilities: flowDefinition.requestedCapabilities,
      blockedReason,
    }));
  }

  if (seen.size !== 5 || !['INSTAGRAM:INSTAGRAM_LOGIN', 'INSTAGRAM:INSTAGRAM_VIA_FACEBOOK_LOGIN'].every((key) => seen.has(key))) {
    return undefined;
  }
  return Object.freeze(profiles);
}

export function onboardingFlowTitle(flowVariant: OnboardingFlowVariant): string {
  switch (flowVariant) {
    case 'FACEBOOK_LOGIN': return 'Facebook Login para Empresas';
    case 'INSTAGRAM_VIA_FACEBOOK_LOGIN': return 'Instagram via Facebook Login';
    case 'INSTAGRAM_LOGIN': return 'Instagram Login';
    case 'WHATSAPP_CLOUD_API': return 'WhatsApp Cloud API';
    case 'WHATSAPP_COEXISTENCE': return 'WhatsApp Business Coexistence';
  }
}

export function onboardingCapabilityLabel(operation: string): string {
  const labels: Readonly<Record<string, string>> = Object.freeze({
    ASSET_DISCOVERY: 'Localizar recursos',
    SEND_MESSAGE: 'Enviar mensagens',
    MANAGE_COMMENTS: 'Gerenciar comentários',
    MANAGE_TEMPLATES: 'Gerenciar modelos',
    READ_STATUS: 'Consultar status',
    SUBSCRIBE_WEBHOOKS: 'Receber atualizações',
    SYNC_HISTORY: 'Sincronizar histórico',
    PHONE_REGISTRATION_CONVENTIONAL: 'Registro convencional de telefone',
  });
  return labels[operation] ?? 'Capacidade adicional';
}
