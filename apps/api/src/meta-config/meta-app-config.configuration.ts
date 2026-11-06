import {
  capabilityManifestFor,
  META_CAPABILITY_MANIFEST,
  META_CAPABILITY_MANIFEST_VERSION,
  type MetaAuthenticationVariant,
  type MetaCapabilityManifestEntry,
  type MetaOperation,
  type MetaProductFlow,
} from './capability-manifest.js';
import type { RuntimeEnvironment } from '../config/environment.js';

export interface MetaVersionEvidence {
  readonly value: string;
  readonly status: 'VERIFIED' | 'NOT_CONFIRMED';
  readonly evidenceUrl?: string;
  readonly verifiedAt?: string;
}

export interface TrustedMetaProviderAppId {
  readonly environment: RuntimeEnvironment;
  readonly flowVariant: MetaProductFlow;
  readonly authVariant: MetaAuthenticationVariant;
  readonly providerAppIdRef: string;
  readonly providerAppId: string;
}

export interface MetaPermissionEvidence {
  readonly permission: string;
  readonly permissionStatus: 'CONFIRMED' | 'NOT_CONFIRMED';
  readonly accessLevel: 'STANDARD' | 'ADVANCED' | 'NOT_CONFIRMED';
  readonly appReviewStatus: 'APPROVED' | 'NOT_REQUIRED' | 'SUBMITTED' | 'REJECTED' | 'NOT_CONFIRMED';
  readonly sandboxStatus: 'PASSED' | 'FAILED' | 'NOT_TESTED';
  readonly approvalOwner?: string;
  readonly evidenceUrl?: string;
}

export interface MetaCapabilityEvidence {
  readonly operation: MetaOperation;
  readonly permissions: readonly MetaPermissionEvidence[];
}

export interface MetaAppConfiguration {
  readonly configurationRef: string;
  readonly environment: RuntimeEnvironment;
  readonly flowVariant: MetaProductFlow;
  readonly authVariant: MetaAuthenticationVariant;
  readonly providerAppIdRef: string;
  readonly providerAppId: string;
  readonly publicConfigId?: string;
  readonly appMode: 'DEVELOPMENT' | 'LIVE';
  readonly appDomain: string;
  readonly callbackUri: string;
  readonly redirectAllowlist: readonly string[];
  /** Secret-manager references only; values are never accepted in this registry. */
  readonly appSecretRef: string;
  readonly tokenConfigurationRef: string;
  readonly capabilityManifestVersion: string;
  readonly enabled: boolean;
  readonly rollbackConfigurationRef?: string;
  readonly versions: {
    readonly graphApi: MetaVersionEvidence;
    readonly javascriptSdk?: MetaVersionEvidence;
    readonly embeddedSignup?: MetaVersionEvidence;
  };
  readonly capabilityEvidence: readonly MetaCapabilityEvidence[];
}

export type MetaBootstrapReason =
  | 'CONFIGURATION_MISSING'
  | 'CONFIGURATION_DISABLED'
  | 'VERSION_EVIDENCE_REQUIRED'
  | 'PERMISSION_MAPPING_NOT_CONFIRMED'
  | 'CAPABILITY_EVIDENCE_MISSING'
  | 'ACCESS_LEVEL_NOT_CONFIRMED'
  | 'APP_REVIEW_NOT_CONFIRMED'
  | 'SANDBOX_NOT_CONFIRMED';

export interface MetaBootstrapCapability {
  readonly operation: MetaOperation;
  readonly enabled: boolean;
  readonly reasonCode: MetaBootstrapReason | null;
}

export interface MetaBootstrapProfile {
  readonly flowVariant: MetaProductFlow;
  readonly authVariant: MetaAuthenticationVariant;
  readonly enabled: boolean;
  readonly reasonCode: MetaBootstrapReason | null;
  readonly providerAppId?: string;
  readonly publicConfigId?: string;
  readonly appDomain?: string;
  readonly javascriptSdkVersion?: string;
  readonly embeddedSignupVersion?: string;
  readonly capabilities: readonly MetaBootstrapCapability[];
}

export interface MetaBootstrapResponse {
  readonly manifestVersion: string;
  readonly profiles: readonly MetaBootstrapProfile[];
}

const FLOW_VARIANTS: readonly MetaProductFlow[] = [
  'FACEBOOK', 'INSTAGRAM', 'WHATSAPP_EXCLUSIVE', 'WHATSAPP_COEXISTENCE',
];
const AUTH_VARIANTS: readonly MetaAuthenticationVariant[] = [
  'FACEBOOK_LOGIN_FOR_BUSINESS', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN',
  'WHATSAPP_EMBEDDED_SIGNUP', 'WHATSAPP_BUSINESS_APP_ONBOARDING',
];
const ENVIRONMENTS: readonly RuntimeEnvironment[] = ['development', 'test', 'staging', 'production'];
const VERSION_PATTERN = /^v[0-9]{1,2}\.[0-9]{1,3}$/;
const REFERENCE_PATTERN = /^(?:secret|vault|aws-secretsmanager|gcp-secretmanager):\/\/meta-app\/(development|test|staging|production)\/[A-Za-z0-9._/-]{1,250}$/;
const SAFE_REF_PATTERN = /^[A-Za-z0-9._-]{1,96}$/;
const PERMISSION_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const OFFICIAL_EVIDENCE_HOSTS = new Set(['developers.facebook.com', 'www.postman.com']);

const AUTH_BY_FLOW: Readonly<Record<MetaProductFlow, readonly MetaAuthenticationVariant[]>> = Object.freeze({
  FACEBOOK: ['FACEBOOK_LOGIN_FOR_BUSINESS'],
  INSTAGRAM: ['INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN'],
  WHATSAPP_EXCLUSIVE: ['WHATSAPP_EMBEDDED_SIGNUP'],
  WHATSAPP_COEXISTENCE: ['WHATSAPP_BUSINESS_APP_ONBOARDING'],
});

export function parseTrustedMetaProviderAppIds(
  source: string | undefined,
  runtimeEnvironment: RuntimeEnvironment,
  invalid: string[],
): readonly TrustedMetaProviderAppId[] | undefined {
  if (source === undefined || source.trim() === '') return undefined;
  try {
    if (Buffer.byteLength(source, 'utf8') > 16 * 1024) throw new Error();
    const parsed: unknown = JSON.parse(source);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 20) throw new Error();
    const entries = parsed.map((value): TrustedMetaProviderAppId | undefined => {
      if (!isRecord(value) || !exactKeys(value, [
        'environment', 'flowVariant', 'authVariant', 'providerAppIdRef', 'providerAppId',
      ]) || value.environment !== runtimeEnvironment ||
          typeof value.flowVariant !== 'string' || !FLOW_VARIANTS.includes(value.flowVariant as MetaProductFlow) ||
          typeof value.authVariant !== 'string' || !AUTH_VARIANTS.includes(value.authVariant as MetaAuthenticationVariant) ||
          !AUTH_BY_FLOW[value.flowVariant as MetaProductFlow].includes(value.authVariant as MetaAuthenticationVariant) ||
          !text(value.providerAppIdRef, 96) || !SAFE_REF_PATTERN.test(value.providerAppIdRef) ||
          typeof value.providerAppId !== 'string' || !/^\d{1,32}$/.test(value.providerAppId)) return undefined;
      return Object.freeze({
        environment: runtimeEnvironment,
        flowVariant: value.flowVariant as MetaProductFlow,
        authVariant: value.authVariant as MetaAuthenticationVariant,
        providerAppIdRef: value.providerAppIdRef,
        providerAppId: value.providerAppId,
      });
    });
    if (entries.some((entry) => !entry)) throw new Error();
    const typedEntries = entries as TrustedMetaProviderAppId[];
    const keys = typedEntries.map((entry) => `${entry.flowVariant}\0${entry.authVariant}\0${entry.providerAppIdRef}`);
    if (new Set(keys).size !== keys.length) throw new Error();
    return Object.freeze(typedEntries);
  } catch {
    invalid.push('API_META_TRUSTED_APP_IDS_JSON');
    return undefined;
  }
}

const PROFILES: readonly Pick<MetaAppConfiguration, 'flowVariant' | 'authVariant'>[] = Object.freeze([
  { flowVariant: 'FACEBOOK', authVariant: 'FACEBOOK_LOGIN_FOR_BUSINESS' },
  { flowVariant: 'INSTAGRAM', authVariant: 'INSTAGRAM_VIA_FACEBOOK_LOGIN' },
  { flowVariant: 'INSTAGRAM', authVariant: 'INSTAGRAM_LOGIN' },
  { flowVariant: 'WHATSAPP_EXCLUSIVE', authVariant: 'WHATSAPP_EMBEDDED_SIGNUP' },
  { flowVariant: 'WHATSAPP_COEXISTENCE', authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING' },
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function text(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function exactHttpsUri(value: unknown, allowedOrigins: readonly string[]): value is string {
  if (typeof value !== 'string' || value.length > 2048 || value.includes('*')) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      allowedOrigins.includes(url.origin);
  } catch {
    return false;
  }
}

function normalizedHostname(value: string): string | undefined {
  if (value.includes('/') || value.includes(':') || value.includes('?') || value.includes('#') || value.includes('@')) {
    return undefined;
  }
  try {
    const url = new URL(`https://${value}`);
    if (url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) return undefined;
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return undefined;
  }
}

function isEnvironmentBoundSecretReference(value: unknown, environment: RuntimeEnvironment): value is string {
  if (typeof value !== 'string') return false;
  const match = REFERENCE_PATTERN.exec(value);
  if (!match || match[1] !== environment) return false;
  const namespacePrefix = value.slice(0, value.indexOf(`/${environment}/`) + environment.length + 2);
  const secretPath = value.slice(namespacePrefix.length);
  return secretPath.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function validEvidenceUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && OFFICIAL_EVIDENCE_HOSTS.has(url.hostname) &&
      (url.hostname !== 'www.postman.com' || url.pathname.startsWith('/meta/')) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function parseVersionEvidence(value: unknown, required: boolean): MetaVersionEvidence | undefined {
  if (value === undefined && !required) return undefined;
  if (!isRecord(value) || !exactKeys(value, ['value', 'status', 'evidenceUrl', 'verifiedAt'])) return undefined;
  if (typeof value.value !== 'string' || !VERSION_PATTERN.test(value.value) ||
      (value.status !== 'VERIFIED' && value.status !== 'NOT_CONFIRMED')) return undefined;
  if (value.status === 'VERIFIED') {
    if (!validEvidenceUrl(value.evidenceUrl) || typeof value.verifiedAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value.verifiedAt) || !Number.isFinite(Date.parse(`${value.verifiedAt}T00:00:00Z`))) return undefined;
    return Object.freeze({ value: value.value, status: 'VERIFIED', evidenceUrl: value.evidenceUrl, verifiedAt: value.verifiedAt });
  }
  if (value.evidenceUrl !== undefined || value.verifiedAt !== undefined) return undefined;
  return Object.freeze({ value: value.value, status: 'NOT_CONFIRMED' });
}

function parsePermissionEvidence(value: unknown): MetaPermissionEvidence | undefined {
  if (!isRecord(value) || !exactKeys(value, [
    'permission', 'permissionStatus', 'accessLevel', 'appReviewStatus', 'sandboxStatus', 'approvalOwner', 'evidenceUrl',
  ]) || typeof value.permission !== 'string' || !PERMISSION_PATTERN.test(value.permission) ||
      (value.permissionStatus !== 'CONFIRMED' && value.permissionStatus !== 'NOT_CONFIRMED') ||
      !['STANDARD', 'ADVANCED', 'NOT_CONFIRMED'].includes(String(value.accessLevel)) ||
      !['APPROVED', 'NOT_REQUIRED', 'SUBMITTED', 'REJECTED', 'NOT_CONFIRMED'].includes(String(value.appReviewStatus)) ||
      !['PASSED', 'FAILED', 'NOT_TESTED'].includes(String(value.sandboxStatus))) return undefined;
  if (value.approvalOwner !== undefined && (!text(value.approvalOwner, 128) || value.approvalOwner === 'UNASSIGNED')) return undefined;
  if (value.evidenceUrl !== undefined && !validEvidenceUrl(value.evidenceUrl)) return undefined;
  return Object.freeze({
    permission: value.permission,
    permissionStatus: value.permissionStatus,
    accessLevel: value.accessLevel as MetaPermissionEvidence['accessLevel'],
    appReviewStatus: value.appReviewStatus as MetaPermissionEvidence['appReviewStatus'],
    sandboxStatus: value.sandboxStatus as MetaPermissionEvidence['sandboxStatus'],
    ...(typeof value.approvalOwner === 'string' ? { approvalOwner: value.approvalOwner } : {}),
    ...(typeof value.evidenceUrl === 'string' ? { evidenceUrl: value.evidenceUrl } : {}),
  });
}

function parseCapabilityEvidence(value: unknown): MetaCapabilityEvidence | undefined {
  if (!isRecord(value) || !exactKeys(value, ['operation', 'permissions']) ||
      typeof value.operation !== 'string' || !META_CAPABILITY_MANIFEST.some((entry) => entry.operation === value.operation) ||
      !Array.isArray(value.permissions) || value.permissions.length > 32) return undefined;
  const permissions = value.permissions.map(parsePermissionEvidence);
  if (permissions.some((entry) => !entry)) return undefined;
  const typedPermissions = permissions as MetaPermissionEvidence[];
  if (new Set(typedPermissions.map((entry) => entry.permission)).size !== typedPermissions.length) return undefined;
  return Object.freeze({ operation: value.operation as MetaOperation, permissions: Object.freeze(typedPermissions) });
}

function parseProfile(
  value: unknown,
  runtimeEnvironment: RuntimeEnvironment,
  allowedOrigins: readonly string[],
  trustedProviderAppIds: readonly TrustedMetaProviderAppId[],
): MetaAppConfiguration | undefined {
  if (!isRecord(value) || !exactKeys(value, [
    'configurationRef', 'environment', 'flowVariant', 'authVariant', 'providerAppIdRef', 'publicConfigId', 'appMode',
    'appDomain', 'callbackUri', 'redirectAllowlist', 'appSecretRef', 'tokenConfigurationRef',
    'capabilityManifestVersion', 'enabled', 'rollbackConfigurationRef', 'versions', 'capabilityEvidence',
  ])) return undefined;

  if (!text(value.configurationRef, 96) || !SAFE_REF_PATTERN.test(value.configurationRef) ||
      typeof value.environment !== 'string' || !ENVIRONMENTS.includes(value.environment as RuntimeEnvironment) ||
      value.environment !== runtimeEnvironment ||
      typeof value.flowVariant !== 'string' || !FLOW_VARIANTS.includes(value.flowVariant as MetaProductFlow) ||
      typeof value.authVariant !== 'string' || !AUTH_VARIANTS.includes(value.authVariant as MetaAuthenticationVariant) ||
      !AUTH_BY_FLOW[value.flowVariant as MetaProductFlow].includes(value.authVariant as MetaAuthenticationVariant) ||
      !text(value.providerAppIdRef, 96) || !SAFE_REF_PATTERN.test(value.providerAppIdRef) ||
      (value.publicConfigId !== undefined && (!text(value.publicConfigId, 128) || !SAFE_REF_PATTERN.test(value.publicConfigId))) ||
      (value.appMode !== 'DEVELOPMENT' && value.appMode !== 'LIVE') ||
      value.appMode !== (runtimeEnvironment === 'production' ? 'LIVE' : 'DEVELOPMENT') ||
      !text(value.appDomain, 253) || value.appDomain.includes('*') || value.appDomain.includes('/') ||
      !exactHttpsUri(value.callbackUri, allowedOrigins) ||
      !Array.isArray(value.redirectAllowlist) || value.redirectAllowlist.length === 0 || value.redirectAllowlist.length > 16 ||
      !value.redirectAllowlist.every((uri) => exactHttpsUri(uri, allowedOrigins)) ||
      !value.redirectAllowlist.includes(value.callbackUri) ||
      !isEnvironmentBoundSecretReference(value.appSecretRef, runtimeEnvironment) ||
      !isEnvironmentBoundSecretReference(value.tokenConfigurationRef, runtimeEnvironment) ||
      value.capabilityManifestVersion !== META_CAPABILITY_MANIFEST_VERSION || typeof value.enabled !== 'boolean' ||
      (value.rollbackConfigurationRef !== undefined && (!text(value.rollbackConfigurationRef, 96) || !SAFE_REF_PATTERN.test(value.rollbackConfigurationRef))) ||
      !isRecord(value.versions) || !exactKeys(value.versions, ['graphApi', 'javascriptSdk', 'embeddedSignup']) ||
      !Array.isArray(value.capabilityEvidence) || value.capabilityEvidence.length > 64) return undefined;

  let callback: URL;
  try { callback = new URL(value.callbackUri); } catch { return undefined; }
  const callbackHostname = normalizedHostname(callback.hostname);
  const appHostname = normalizedHostname(value.appDomain);
  if (!callbackHostname || !appHostname || callbackHostname !== appHostname) return undefined;
  const trustedProviderAppId = trustedProviderAppIds.find((entry) =>
    entry.environment === runtimeEnvironment && entry.flowVariant === value.flowVariant &&
    entry.authVariant === value.authVariant && entry.providerAppIdRef === value.providerAppIdRef);
  if (!trustedProviderAppId) return undefined;

  const isEmbeddedSignup = value.authVariant === 'WHATSAPP_EMBEDDED_SIGNUP' ||
    value.authVariant === 'WHATSAPP_BUSINESS_APP_ONBOARDING';
  const needsFacebookSdk = value.authVariant !== 'INSTAGRAM_LOGIN';
  const graphApi = parseVersionEvidence(value.versions.graphApi, true);
  const javascriptSdk = parseVersionEvidence(value.versions.javascriptSdk, needsFacebookSdk);
  const embeddedSignup = parseVersionEvidence(value.versions.embeddedSignup, isEmbeddedSignup);
  if (!graphApi || (needsFacebookSdk && !javascriptSdk) || (isEmbeddedSignup && !embeddedSignup)) return undefined;

  const evidence = value.capabilityEvidence.map(parseCapabilityEvidence);
  if (evidence.some((item) => !item)) return undefined;
  const typedEvidence = evidence as MetaCapabilityEvidence[];
  const evidenceKeys = typedEvidence.map((item) => `${item.operation}`);
  if (new Set(evidenceKeys).size !== evidenceKeys.length) return undefined;
  const profileManifest = capabilityManifestFor(value.flowVariant as MetaProductFlow, value.authVariant as MetaAuthenticationVariant);
  if (typedEvidence.some((item) => {
    const manifest = profileManifest.find((entry) => entry.operation === item.operation);
    return !manifest || item.permissions.some((permission) => !manifest.candidatePermissions.includes(permission.permission));
  })) return undefined;

  return Object.freeze({
    configurationRef: value.configurationRef,
    environment: value.environment as RuntimeEnvironment,
    flowVariant: value.flowVariant as MetaProductFlow,
    authVariant: value.authVariant as MetaAuthenticationVariant,
    providerAppIdRef: value.providerAppIdRef,
    providerAppId: trustedProviderAppId.providerAppId,
    ...(typeof value.publicConfigId === 'string' ? { publicConfigId: value.publicConfigId } : {}),
    appMode: value.appMode,
    appDomain: value.appDomain,
    callbackUri: value.callbackUri,
    redirectAllowlist: Object.freeze([...(value.redirectAllowlist as string[])]),
    appSecretRef: value.appSecretRef as string,
    tokenConfigurationRef: value.tokenConfigurationRef as string,
    capabilityManifestVersion: value.capabilityManifestVersion,
    enabled: value.enabled,
    ...(typeof value.rollbackConfigurationRef === 'string' ? { rollbackConfigurationRef: value.rollbackConfigurationRef } : {}),
    versions: Object.freeze({
      graphApi,
      ...(javascriptSdk ? { javascriptSdk } : {}),
      ...(embeddedSignup ? { embeddedSignup } : {}),
    }),
    capabilityEvidence: Object.freeze(typedEvidence),
  });
}

export function parseMetaAppConfigurations(
  source: string | undefined,
  runtimeEnvironment: RuntimeEnvironment,
  allowedOrigins: readonly string[],
  invalid: string[],
  trustedProviderAppIds?: readonly TrustedMetaProviderAppId[],
): readonly MetaAppConfiguration[] | undefined {
  if (source === undefined || source.trim() === '') return undefined;
  if (!trustedProviderAppIds || trustedProviderAppIds.length === 0) {
    invalid.push('API_META_TRUSTED_APP_IDS_JSON');
    return undefined;
  }
  try {
    if (Buffer.byteLength(source, 'utf8') > 64 * 1024) throw new Error();
    const parsed: unknown = JSON.parse(source);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 20) throw new Error();
    const profiles = parsed.map((item) => parseProfile(item, runtimeEnvironment, allowedOrigins, trustedProviderAppIds));
    if (profiles.some((item) => !item)) throw new Error();
    const typedProfiles = profiles as MetaAppConfiguration[];
    const profileKeys = typedProfiles.map((item) => `${item.flowVariant}\0${item.authVariant}`);
    const refs = typedProfiles.map((item) => item.configurationRef);
    if (new Set(profileKeys).size !== profileKeys.length || new Set(refs).size !== refs.length) throw new Error();
    if (typedProfiles.some((item) => item.rollbackConfigurationRef === item.configurationRef)) throw new Error();
    return Object.freeze(typedProfiles);
  } catch {
    invalid.push('API_META_APP_CONFIGS_JSON');
    return undefined;
  }
}

function evidenceFor(configuration: MetaAppConfiguration, operation: MetaOperation): MetaCapabilityEvidence | undefined {
  return configuration.capabilityEvidence.find((item) => item.operation === operation);
}

function evaluateCapability(
  manifest: MetaCapabilityManifestEntry,
  configuration: MetaAppConfiguration | undefined,
): MetaBootstrapReason | null {
  if (!configuration) return 'CONFIGURATION_MISSING';
  if (!configuration.enabled) return 'CONFIGURATION_DISABLED';
  if (configuration.versions.graphApi.status !== 'VERIFIED' ||
      (configuration.versions.javascriptSdk && configuration.versions.javascriptSdk.status !== 'VERIFIED') ||
      (configuration.versions.embeddedSignup && configuration.versions.embeddedSignup.status !== 'VERIFIED')) {
    return 'VERSION_EVIDENCE_REQUIRED';
  }
  if (manifest.permissionMapping === 'NOT_CONFIRMED' || manifest.candidatePermissions.length === 0) {
    return 'PERMISSION_MAPPING_NOT_CONFIRMED';
  }
  const evidence = evidenceFor(configuration, manifest.operation);
  if (!evidence || evidence.permissions.length !== manifest.candidatePermissions.length) {
    return 'CAPABILITY_EVIDENCE_MISSING';
  }
  const evidenceByPermission = new Map(evidence.permissions.map((permission) => [permission.permission, permission]));
  const requiredEvidence = manifest.candidatePermissions.map((permission) => evidenceByPermission.get(permission));
  if (requiredEvidence.some((permission) => !permission || permission.permissionStatus !== 'CONFIRMED')) {
    return 'CAPABILITY_EVIDENCE_MISSING';
  }
  const permissionEvidence = requiredEvidence as MetaPermissionEvidence[];
  if (manifest.requiredAccessLevel === 'NOT_CONFIRMED' ||
      permissionEvidence.some((permission) => permission.accessLevel === 'NOT_CONFIRMED' ||
        (manifest.requiredAccessLevel === 'ADVANCED' && permission.accessLevel !== 'ADVANCED'))) {
    return 'ACCESS_LEVEL_NOT_CONFIRMED';
  }
  if (manifest.appReviewRequirement === 'NOT_CONFIRMED' ||
      (manifest.appReviewRequirement === 'REQUIRED' && permissionEvidence.some((permission) => permission.appReviewStatus !== 'APPROVED')) ||
      permissionEvidence.some((permission) => permission.appReviewStatus !== 'APPROVED' && permission.appReviewStatus !== 'NOT_REQUIRED')) {
    return 'APP_REVIEW_NOT_CONFIRMED';
  }
  if (manifest.sandboxStatus !== 'NOT_TESTED' || permissionEvidence.some((permission) =>
    permission.sandboxStatus !== 'PASSED' || !permission.approvalOwner || !permission.evidenceUrl)) {
    return 'SANDBOX_NOT_CONFIRMED';
  }
  return null;
}

function overallVersionReason(configuration: MetaAppConfiguration): MetaBootstrapReason | null {
  if (configuration.versions.graphApi.status !== 'VERIFIED' ||
      (configuration.versions.javascriptSdk && configuration.versions.javascriptSdk.status !== 'VERIFIED') ||
      (configuration.versions.embeddedSignup && configuration.versions.embeddedSignup.status !== 'VERIFIED')) {
    return 'VERSION_EVIDENCE_REQUIRED';
  }
  return null;
}

export function buildMetaBootstrap(
  configurations: readonly MetaAppConfiguration[] | undefined,
): MetaBootstrapResponse {
  const profiles = PROFILES.map(({ flowVariant, authVariant }): MetaBootstrapProfile => {
    const configuration = configurations?.find((item) => item.flowVariant === flowVariant && item.authVariant === authVariant);
    const manifest = capabilityManifestFor(flowVariant, authVariant);
    const versionReason = configuration ? overallVersionReason(configuration) : null;
    const capabilities = manifest.map((item): MetaBootstrapCapability => Object.freeze({
      operation: item.operation,
      enabled: evaluateCapability(item, configuration) === null,
      reasonCode: evaluateCapability(item, configuration),
    }));
    let reasonCode: MetaBootstrapReason | null = configuration ? null : 'CONFIGURATION_MISSING';
    if (configuration && !configuration.enabled) reasonCode = 'CONFIGURATION_DISABLED';
    if (configuration && configuration.enabled && versionReason) reasonCode = versionReason;
    if (configuration && configuration.enabled && !versionReason) {
      const discovery = capabilities.find((item) => item.operation === 'ASSET_DISCOVERY');
      reasonCode = discovery ? discovery.reasonCode : 'CAPABILITY_EVIDENCE_MISSING';
    }
    const enabled = configuration !== undefined && reasonCode === null;
    return Object.freeze({
      flowVariant,
      authVariant,
      enabled,
      reasonCode,
      ...(enabled && configuration ? {
        providerAppId: configuration.providerAppId,
        ...(configuration.publicConfigId ? { publicConfigId: configuration.publicConfigId } : {}),
        appDomain: configuration.appDomain,
        ...(configuration.versions.javascriptSdk ? { javascriptSdkVersion: configuration.versions.javascriptSdk.value } : {}),
        ...(configuration.versions.embeddedSignup ? { embeddedSignupVersion: configuration.versions.embeddedSignup.value } : {}),
      } : {}),
      capabilities: Object.freeze(capabilities),
    });
  });
  return Object.freeze({ manifestVersion: META_CAPABILITY_MANIFEST_VERSION, profiles: Object.freeze(profiles) });
}

export function onboardingFlowForMetaProfile(
  flowVariant: MetaProductFlow,
  authVariant: MetaAuthenticationVariant,
): 'FACEBOOK_LOGIN' | 'INSTAGRAM_VIA_FACEBOOK_LOGIN' | 'INSTAGRAM_LOGIN' | 'WHATSAPP_CLOUD_API' | 'WHATSAPP_COEXISTENCE' {
  if (flowVariant === 'FACEBOOK' && authVariant === 'FACEBOOK_LOGIN_FOR_BUSINESS') return 'FACEBOOK_LOGIN';
  if (flowVariant === 'INSTAGRAM' && authVariant === 'INSTAGRAM_VIA_FACEBOOK_LOGIN') return 'INSTAGRAM_VIA_FACEBOOK_LOGIN';
  if (flowVariant === 'INSTAGRAM' && authVariant === 'INSTAGRAM_LOGIN') return 'INSTAGRAM_LOGIN';
  if (flowVariant === 'WHATSAPP_EXCLUSIVE' && authVariant === 'WHATSAPP_EMBEDDED_SIGNUP') return 'WHATSAPP_CLOUD_API';
  return 'WHATSAPP_COEXISTENCE';
}
