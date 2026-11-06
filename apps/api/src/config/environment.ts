import { isIP } from 'node:net';
import { createPublicKey, randomBytes } from 'node:crypto';
import type { TicketExchangeConfiguration } from '../auth-exchange/ticket-contract.js';
import type { ConfiguredTicketPublicKey } from '../auth-exchange/configured-ticket-key-set.js';
import type { WorkerServiceCredentialHash } from '../identity/identity.trust.js';
import {
  parseMetaAppConfigurations,
  type MetaAppConfiguration,
} from '../meta-config/meta-app-config.configuration.js';

export type RuntimeEnvironment = 'development' | 'test' | 'staging' | 'production';

export class CredentialKeyRingConfiguration {
  readonly #keys = new Map<string, Buffer>();
  readonly #activeVersion: string;

  constructor(activeVersion: string, keys: readonly { readonly version: string; readonly key: Buffer }[]) {
    this.#activeVersion = activeVersion;
    for (const entry of keys) this.#keys.set(entry.version, Buffer.from(entry.key));
  }

  activeVersion(): string { return this.#activeVersion; }
  keyFor(version: string): Buffer | undefined {
    const key = this.#keys.get(version);
    return key ? Buffer.from(key) : undefined;
  }
}

export interface ApiEnvironment {
  readonly nodeEnv: RuntimeEnvironment;
  readonly port: number;
  readonly bindAddress: string;
  readonly allowedHosts: readonly string[];
  /** Exact scheme/host/port browser origin allowlist; wildcards are never accepted. */
  readonly allowedOrigins: readonly string[];
  /** Exact Suite4 parent origins permitted by the embed deployment. Empty disables embedding. */
  readonly suite4EmbedOrigins: readonly string[];
  readonly trustedProxyCidrs: false | readonly string[];
  /** Sliding portal-session expiry; proposal default, not confirmed against Suite4 behavior. */
  readonly portalSessionIdleTimeoutSeconds: number;
  /** Absolute portal-session expiry; proposal default, not confirmed against Suite4 behavior. */
  readonly portalSessionAbsoluteTimeoutSeconds: number;
  /** Opt-in local lifecycle queueing; provider inspection remains impossible without explicit adapters. */
  readonly credentialLifecycleSchedulerEnabled?: boolean;
  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly name: string;
    readonly user: string;
    readonly password: string;
    readonly connectTimeoutMs: number;
  };
  /** Server-only profiles; absent configuration keeps every Meta action unavailable. */
  readonly metaAppConfigurations?: readonly MetaAppConfiguration[];
  readonly portalSessionRecoveryKey: string;
  /** Optional runtime-only key ring. Missing keys intentionally disable credential operations. */
  readonly credentialKeyRing?: CredentialKeyRingConfiguration;
  /** Optional server-side HMAC key for OAuth state; absent disables new onboarding starts. */
  readonly onboardingStateSigningKey?: string;
  /** Absent configuration disables Suite4 ticket exchange without disabling other API routes. */
  readonly portalEntryTicket?: {
    readonly configuration: TicketExchangeConfiguration;
    readonly publicKeys: readonly ConfiguredTicketPublicKey[];
    /** Set by validation only for isolated tests using a loopback listener. */
    readonly allowInsecureLoopbackOrigins: boolean;
  };
  readonly identity?: {
    /** Exact verified issuer/subject pairs granted platform identity administration. Empty is fail-closed. */
    readonly platformIdentityAdmins: readonly { readonly issuer: string; readonly subject: string }[];
    /** Hash-only worker credentials mapped to SERVICE principals; raw proof comes from runtime secret storage. */
    readonly workerServiceCredentials?: readonly WorkerServiceCredentialHash[];
  };
}

export class EnvironmentValidationError extends Error {
  constructor(readonly fieldNames: readonly string[]) {
    super(`Invalid API configuration fields: ${fieldNames.join(', ')}`);
    this.name = 'EnvironmentValidationError';
  }
}

const REQUIRED_FIELDS = [
  'NODE_ENV',
  'API_PORT',
  'API_BIND_ADDRESS',
  'API_ALLOWED_HOSTS',
  'API_TRUSTED_PROXIES',
  'API_DATABASE_HOST',
  'API_DATABASE_PORT',
  'API_DATABASE_NAME',
  'API_DATABASE_USER',
  'API_DATABASE_PASSWORD',
  'API_DATABASE_CONNECT_TIMEOUT_MS',
] as const;

function required(source: NodeJS.ProcessEnv, key: string, invalid: string[]): string {
  const value = source[key];
  if (value === undefined || value.trim().length === 0) {
    invalid.push(key);
    return '';
  }
  return value.trim();
}

function requiredSecret(source: NodeJS.ProcessEnv, key: string, invalid: string[]): string {
  const value = source[key];
  if (value === undefined || value.trim().length === 0) {
    invalid.push(key);
    return '';
  }
  return value;
}

function integerField(
  source: NodeJS.ProcessEnv,
  key: string,
  minimum: number,
  maximum: number,
  invalid: string[],
): number {
  const value = required(source, key, invalid);
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    invalid.push(key);
    return minimum;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    invalid.push(key);
    return minimum;
  }
  return parsed;
}

function optionalIntegerField(
  source: NodeJS.ProcessEnv,
  key: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
  invalid: string[],
): number {
  const value = source[key];
  if (value === undefined) return defaultValue;
  if (!/^(0|[1-9]\d*)$/.test(value.trim())) {
    invalid.push(key);
    return defaultValue;
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    invalid.push(key);
    return defaultValue;
  }
  return parsed;
}

function optionalBooleanField(source: NodeJS.ProcessEnv, key: string, defaultValue: boolean, invalid: string[]): boolean {
  const value = source[key];
  if (value === undefined) return defaultValue;
  if (value.trim() === 'true') return true;
  if (value.trim() === 'false') return false;
  invalid.push(key);
  return defaultValue;
}

function normalizeAllowedHost(value: string): string | undefined {
  if (value.length === 0 || value.includes('*') || value.includes('/') || value.includes('@')) return undefined;
  if (isIP(value) !== 0) return value.toLowerCase();

  const hostname = value.endsWith('.') ? value.slice(0, -1) : value;
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    !hostname.split('.').every((label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    )
  ) {
    return undefined;
  }
  return hostname.toLowerCase();
}

function allowedHostsField(value: string, invalid: string[]): readonly string[] {
  const entries = value.split(',').map((entry) => entry.trim());
  const normalized = entries.map(normalizeAllowedHost);
  if (
    entries.length === 0 ||
    entries.some((entry) => entry.length === 0) ||
    normalized.some((entry) => entry === undefined) ||
    new Set(normalized).size !== normalized.length
  ) {
    invalid.push('API_ALLOWED_HOSTS');
    return [];
  }
  return normalized as string[];
}

function allowedOriginsField(value: string, nodeEnv: string, invalid: string[]): readonly string[] {
  const entries = value.split(',').map((entry) => entry.trim());
  const origins = entries.map((entry) => {
    try {
      const url = new URL(entry);
      const loopbackHttp = nodeEnv === 'test' || nodeEnv === 'development'
        ? ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        : false;
      if (
        entry.includes('*') || url.origin !== entry || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHttp))
      ) return undefined;
      return url.origin;
    } catch {
      return undefined;
    }
  });
  if (entries.length === 0 || entries.some((entry) => !entry) || origins.some((origin) => origin === undefined) ||
    new Set(origins).size !== origins.length) {
    invalid.push('API_ALLOWED_ORIGINS');
    return [];
  }
  return origins as string[];
}

function suite4EmbedOriginsField(value: string, invalid: string[]): readonly string[] {
  if (value.trim() === '') return [];
  const entries = value.split(',').map((entry) => entry.trim());
  const origins = entries.map((entry) => {
    try {
      const url = new URL(entry);
      if (entry.includes('*') || url.protocol !== 'https:' || url.origin !== entry || url.username || url.password ||
          url.pathname !== '/' || url.search || url.hash) return undefined;
      return url.origin;
    } catch {
      return undefined;
    }
  });
  if (entries.some((entry) => entry.length === 0) || origins.some((origin) => origin === undefined) ||
      new Set(origins).size !== origins.length) {
    invalid.push('API_SUITE4_EMBED_ORIGINS');
    return [];
  }
  return Object.freeze(origins as string[]);
}

function isUnspecifiedIpv6(address: string): boolean {
  if (isIP(address) !== 6) return false;
  const [left, right = ''] = address.toLowerCase().split('::');
  const leftWords = left === '' ? [] : left.split(':');
  const rightWords = right === '' ? [] : right.split(':');
  const words = address.includes('::')
    ? [...leftWords, ...Array(Math.max(0, 8 - leftWords.length - rightWords.length)).fill('0'), ...rightWords]
    : address.split(':');
  return words.length === 8 && words.every((word) => /^0{1,4}$/.test(word));
}

function ipv6Words(address: string): readonly number[] | undefined {
  let normalized = address.toLowerCase();
  if (normalized.includes('.')) {
    const boundary = normalized.lastIndexOf(':');
    const ipv4 = normalized.slice(boundary + 1).split('.');
    if (ipv4.length !== 4 || ipv4.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) {
      return undefined;
    }
    const high = (Number(ipv4[0]) << 8) | Number(ipv4[1]);
    const low = (Number(ipv4[2]) << 8) | Number(ipv4[3]);
    normalized = `${normalized.slice(0, boundary + 1)}${high.toString(16)}:${low.toString(16)}`;
  }
  const pieces = normalized.split('::');
  if (pieces.length > 2) return undefined;
  const left = pieces[0] === '' ? [] : pieces[0].split(':');
  const right = pieces.length === 1 || pieces[1] === '' ? [] : pieces[1].split(':');
  const missing = pieces.length === 1 ? 0 : 8 - left.length - right.length;
  if (missing < 0 || (pieces.length === 1 && left.length !== 8)) return undefined;
  const words = [...left, ...Array(missing).fill('0'), ...right].map((word) => Number.parseInt(word, 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : undefined;
}

function includesAllIpv4MappedRange(address: string, prefixBits: number): boolean {
  const words = ipv6Words(address);
  if (!words || prefixBits > 96) return false;
  const target = [0, 0, 0, 0, 0, 0xffff, 0, 0];
  for (let bit = 0; bit < prefixBits; bit += 1) {
    const word = Math.floor(bit / 16);
    const offset = 15 - (bit % 16);
    if (((words[word] >> offset) & 1) !== ((target[word] >> offset) & 1)) return false;
  }
  return true;
}

function trustedProxiesField(value: string, invalid: string[]): false | readonly string[] {
  if (value === 'none') return false;

  const entries = value.split(',').map((entry) => entry.trim());
  const valid = entries.length > 0 && entries.every((entry) => {
    const [address, prefix, extra] = entry.split('/');
    const family = isIP(address);
    if (extra !== undefined || family === 0 || address === '0.0.0.0' || isUnspecifiedIpv6(address)) return false;
    if (prefix === undefined) return true;
    if (!/^(0|[1-9]\d*)$/.test(prefix)) return false;
    const bits = Number(prefix);
    if (bits === 0 || bits > (family === 4 ? 32 : 128)) return false;
    if (family === 6 && includesAllIpv4MappedRange(address, bits)) return false;
    return true;
  });
  if (!valid) {
    invalid.push('API_TRUSTED_PROXIES');
    return false;
  }
  return entries;
}

function platformIdentityAdminsField(source: NodeJS.ProcessEnv, invalid: string[]): readonly { readonly issuer: string; readonly subject: string }[] {
  const value = source.API_PLATFORM_IDENTITY_ADMIN_IDENTITIES_JSON;
  if (value === undefined || value.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > 100) throw new Error();
    const identities = parsed.map((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error();
      const issuer = Reflect.get(entry, 'issuer');
      const subject = Reflect.get(entry, 'subject');
      if (typeof issuer !== 'string' || issuer.length < 1 || issuer.length > 255 ||
          typeof subject !== 'string' || subject.length < 1 || subject.length > 255 ||
          issuer.trim() !== issuer || subject.trim() !== subject) throw new Error();
      return Object.freeze({ issuer, subject });
    });
    const keys = identities.map(({ issuer, subject }) => `${issuer}\0${subject}`);
    if (new Set(keys).size !== keys.length) throw new Error();
    return Object.freeze(identities);
  } catch {
    invalid.push('API_PLATFORM_IDENTITY_ADMIN_IDENTITIES_JSON');
    return [];
  }
}

function workerServiceCredentialHashesField(
  source: NodeJS.ProcessEnv,
  invalid: string[],
): readonly WorkerServiceCredentialHash[] | undefined {
  const field = 'API_JOB_WORKER_CREDENTIAL_HASHES_JSON';
  const value = source[field];
  if (value === undefined || value.trim() === '') return undefined;
  try {
    if (Buffer.byteLength(value, 'utf8') > 16 * 1024) throw new Error();
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 20) throw new Error();
    const entries = parsed.map((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error();
      const principalId = Reflect.get(entry, 'principalId');
      const credentialSha256 = Reflect.get(entry, 'credentialSha256');
      if (Object.keys(entry).some((name) => name !== 'principalId' && name !== 'credentialSha256') ||
          typeof principalId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(principalId) ||
          typeof credentialSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(credentialSha256)) throw new Error();
      return Object.freeze({ principalId, credentialSha256 });
    });
    if (new Set(entries.map(({ credentialSha256 }) => credentialSha256)).size !== entries.length) throw new Error();
    return Object.freeze(entries);
  } catch {
    invalid.push(field);
    return undefined;
  }
}

function credentialKeyRingField(source: NodeJS.ProcessEnv, invalid: string[]): CredentialKeyRingConfiguration | undefined {
  const field = 'API_CREDENTIAL_KEYRING_JSON';
  const value = source[field];
  if (value === undefined || value.trim() === '') return undefined;
  const keys: Array<{ version: string; key: Buffer }> = [];
  try {
    if (Buffer.byteLength(value, 'utf8') > 128 * 1024) throw new Error();
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    if (Object.keys(parsed).some((name) => name !== 'activeVersion' && name !== 'keys')) throw new Error();
    const activeVersion = Reflect.get(parsed, 'activeVersion');
    const sourceKeys = Reflect.get(parsed, 'keys');
    if (typeof activeVersion !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(activeVersion) ||
        typeof sourceKeys !== 'object' || sourceKeys === null || Array.isArray(sourceKeys)) throw new Error();
    const entries = Object.entries(sourceKeys as Record<string, unknown>);
    if (entries.length === 0 || entries.length > 20) throw new Error();
    for (const [version, encoded] of entries) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(version) || typeof encoded !== 'string' || encoded.length > 128) throw new Error();
      const key = Buffer.from(encoded, 'base64');
      if (key.length !== 32 || key.toString('base64') !== encoded) {
        key.fill(0);
        throw new Error();
      }
      keys.push({ version, key });
    }
    if (!keys.some(({ version }) => version === activeVersion)) throw new Error();
    return new CredentialKeyRingConfiguration(activeVersion, keys);
  } catch {
    invalid.push(field);
    return undefined;
  } finally {
    for (const entry of keys) entry.key.fill(0);
  }
}

function portalEntryTicketField(
  source: NodeJS.ProcessEnv,
  nodeEnv: string,
  allowedOrigins: readonly string[],
  invalid: string[],
): ApiEnvironment['portalEntryTicket'] {
  const issuerField = 'API_PORTAL_ENTRY_TICKET_ISSUER';
  const audienceField = 'API_PORTAL_ENTRY_TICKET_AUDIENCE';
  const keysField = 'API_PORTAL_ENTRY_TICKET_PUBLIC_KEYS_JSON';
  const configured = [issuerField, audienceField, keysField].some((name) => {
    const value = source[name];
    return value !== undefined && value.trim() !== '';
  });
  if (!configured) return undefined;

  const issuer = required(source, issuerField, invalid);
  const audience = required(source, audienceField, invalid);
  const keyJson = required(source, keysField, invalid);
  try {
    const parsedIssuer = new URL(issuer);
    if (parsedIssuer.protocol !== 'https:' || parsedIssuer.username || parsedIssuer.password || parsedIssuer.search || parsedIssuer.hash || issuer.length > 512) {
      throw new Error();
    }
  } catch {
    invalid.push(issuerField);
  }
  if (audience.length < 1 || audience.length > 255 || /[\u0000-\u001f\u007f]/.test(audience)) invalid.push(audienceField);
  const clockSkewSeconds = optionalIntegerField(source, 'API_PORTAL_ENTRY_TICKET_CLOCK_SKEW_SECONDS', 5, 0, 5, invalid);
  const maximumLifetimeSeconds = optionalIntegerField(source, 'API_PORTAL_ENTRY_TICKET_MAX_LIFETIME_SECONDS', 60, 1, 60, invalid);

  let publicKeys: readonly ConfiguredTicketPublicKey[] = [];
  try {
    if (Buffer.byteLength(keyJson, 'utf8') > 128 * 1024) throw new Error();
    const parsed: unknown = JSON.parse(keyJson);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 20) throw new Error();
    const keys = parsed.map((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error();
      const kid = Reflect.get(entry, 'kid');
      const publicKeyPem = Reflect.get(entry, 'publicKeyPem');
      if (Object.keys(entry).some((name) => name !== 'kid' && name !== 'publicKeyPem') ||
          typeof kid !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(kid) ||
          typeof publicKeyPem !== 'string' || publicKeyPem.length > 16 * 1024 ||
          publicKeyPem.includes('PRIVATE KEY')) throw new Error();
      const normalizedPem = publicKeyPem.trim();
      if (!normalizedPem.startsWith('-----BEGIN PUBLIC KEY-----')) throw new Error();
      const key = createPublicKey(normalizedPem);
      const modulusLength = key.asymmetricKeyDetails?.modulusLength;
      if (key.type !== 'public' || key.asymmetricKeyType !== 'rsa' || !modulusLength || modulusLength < 2048 || modulusLength > 8192) {
        throw new Error();
      }
      return Object.freeze({ kid, publicKeyPem: normalizedPem });
    });
    if (new Set(keys.map(({ kid }) => kid)).size !== keys.length) throw new Error();
    publicKeys = Object.freeze(keys);
  } catch {
    invalid.push(keysField);
  }
  if (allowedOrigins.length === 0) invalid.push('API_ALLOWED_ORIGINS');

  return Object.freeze({
    configuration: Object.freeze({ issuer, audience, clockSkewSeconds, maximumLifetimeSeconds }),
    publicKeys,
    allowInsecureLoopbackOrigins: nodeEnv === 'test',
  });
}

export function validateEnvironment(source: NodeJS.ProcessEnv): ApiEnvironment {
  const invalid: string[] = [];
  const nodeEnv = required(source, 'NODE_ENV', invalid);
  if (!(['development', 'test', 'staging', 'production'] as string[]).includes(nodeEnv)) {
    invalid.push('NODE_ENV');
  }

  const port = integerField(source, 'API_PORT', 0, 65535, invalid);
  if (port === 0 && nodeEnv !== 'test' && nodeEnv !== 'development') invalid.push('API_PORT');

  const bindAddress = required(source, 'API_BIND_ADDRESS', invalid);
  if (isIP(bindAddress) === 0) invalid.push('API_BIND_ADDRESS');
  if (nodeEnv === 'test' && bindAddress !== '127.0.0.1' && bindAddress !== '::1') {
    invalid.push('API_BIND_ADDRESS');
  }

  const allowedHosts = allowedHostsField(required(source, 'API_ALLOWED_HOSTS', invalid), invalid);
  const configuredOrigins = source.API_ALLOWED_ORIGINS?.trim() ?? '';
  if (configuredOrigins === '' && (nodeEnv === 'staging' || nodeEnv === 'production')) invalid.push('API_ALLOWED_ORIGINS');
  const allowedOrigins = configuredOrigins === '' ? [] : allowedOriginsField(configuredOrigins, nodeEnv, invalid);
  const suite4EmbedOrigins = suite4EmbedOriginsField(source.API_SUITE4_EMBED_ORIGINS ?? '', invalid);
  const portalEntryTicket = portalEntryTicketField(source, nodeEnv, allowedOrigins, invalid);
  const trustedProxyCidrs = trustedProxiesField(
    required(source, 'API_TRUSTED_PROXIES', invalid),
    invalid,
  );
  const portalSessionIdleTimeoutSeconds = optionalIntegerField(
    source, 'API_PORTAL_SESSION_IDLE_TIMEOUT_SECONDS', 30 * 60, 60, 24 * 60 * 60, invalid,
  );
  const portalSessionAbsoluteTimeoutSeconds = optionalIntegerField(
    source, 'API_PORTAL_SESSION_ABSOLUTE_TIMEOUT_SECONDS', 8 * 60 * 60, 5 * 60, 30 * 24 * 60 * 60, invalid,
  );
  if (portalSessionAbsoluteTimeoutSeconds < portalSessionIdleTimeoutSeconds) {
    invalid.push('API_PORTAL_SESSION_ABSOLUTE_TIMEOUT_SECONDS');
  }
  const credentialLifecycleSchedulerEnabled = optionalBooleanField(
    source, 'API_CREDENTIAL_LIFECYCLE_SCHEDULER_ENABLED', false, invalid,
  );
  const host = required(source, 'API_DATABASE_HOST', invalid);
  if (!/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) && isIP(host) === 0) {
    invalid.push('API_DATABASE_HOST');
  }
  if (nodeEnv === 'test' && host !== '127.0.0.1' && host !== '::1') {
    invalid.push('API_DATABASE_HOST');
  }
  const databasePort = integerField(source, 'API_DATABASE_PORT', 1, 65535, invalid);
  const databaseName = required(source, 'API_DATABASE_NAME', invalid);
  if (!/^[A-Za-z0-9_]{1,64}$/.test(databaseName)) invalid.push('API_DATABASE_NAME');
  const databaseUser = required(source, 'API_DATABASE_USER', invalid);
  if (!/^[A-Za-z0-9_]{1,64}$/.test(databaseUser)) invalid.push('API_DATABASE_USER');
  const databasePassword = requiredSecret(source, 'API_DATABASE_PASSWORD', invalid);
  const connectTimeoutMs = integerField(
    source,
    'API_DATABASE_CONNECT_TIMEOUT_MS',
    100,
    5000,
    invalid,
  );
  const configuredRecoveryKey = source.API_PORTAL_SESSION_RECOVERY_KEY;
  if ((!configuredRecoveryKey || configuredRecoveryKey.trim() === '') && (nodeEnv === 'staging' || nodeEnv === 'production')) {
    invalid.push('API_PORTAL_SESSION_RECOVERY_KEY');
  }
  const portalSessionRecoveryKey = configuredRecoveryKey && configuredRecoveryKey.trim() !== ''
    ? configuredRecoveryKey
    : randomBytes(32).toString('base64url');
  if (Buffer.byteLength(portalSessionRecoveryKey, 'utf8') < 32) invalid.push('API_PORTAL_SESSION_RECOVERY_KEY');
  const onboardingStateSigningKey = optionalBase64urlKey(source.API_ONBOARDING_STATE_KEY, 'API_ONBOARDING_STATE_KEY', invalid);
  const platformIdentityAdmins = platformIdentityAdminsField(source, invalid);
  const workerServiceCredentials = workerServiceCredentialHashesField(source, invalid);
  const credentialKeyRing = credentialKeyRingField(source, invalid);
  const metaAppConfigurations = parseMetaAppConfigurations(
    source.API_META_APP_CONFIGS_JSON,
    nodeEnv as RuntimeEnvironment,
    allowedOrigins,
    invalid,
  );

  if (invalid.length > 0) {
    const fieldNames = [...new Set([...REQUIRED_FIELDS.filter((name) => source[name] === undefined || source[name]?.trim() === ''), ...invalid])];
    throw new EnvironmentValidationError(fieldNames);
  }

  return {
    nodeEnv: nodeEnv as RuntimeEnvironment,
    port,
    bindAddress,
    allowedHosts,
    allowedOrigins,
    suite4EmbedOrigins,
    trustedProxyCidrs,
    portalSessionIdleTimeoutSeconds,
    portalSessionAbsoluteTimeoutSeconds,
    credentialLifecycleSchedulerEnabled,
    portalSessionRecoveryKey,
    ...(credentialKeyRing ? { credentialKeyRing } : {}),
    ...(onboardingStateSigningKey ? { onboardingStateSigningKey } : {}),
    ...(portalEntryTicket ? { portalEntryTicket } : {}),
    database: {
      host,
      port: databasePort,
      name: databaseName,
      user: databaseUser,
      password: databasePassword,
      connectTimeoutMs,
    },
    ...(metaAppConfigurations ? { metaAppConfigurations } : {}),
    identity: {
      platformIdentityAdmins,
      ...(workerServiceCredentials ? { workerServiceCredentials } : {}),
    },
  };
}

function optionalBase64urlKey(value: string | undefined, field: string, invalid: string[]): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length !== 32 || decoded.toString('base64url') !== value) invalid.push(field);
  } catch {
    invalid.push(field);
  }
  return invalid.includes(field) ? undefined : value;
}
