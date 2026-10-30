import { isIP } from 'node:net';

export type RuntimeEnvironment = 'development' | 'test' | 'staging' | 'production';

export interface ApiEnvironment {
  readonly nodeEnv: RuntimeEnvironment;
  readonly port: number;
  readonly bindAddress: string;
  readonly allowedHosts: readonly string[];
  readonly trustedProxyCidrs: false | readonly string[];
  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly name: string;
    readonly user: string;
    readonly password: string;
    readonly connectTimeoutMs: number;
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
  const trustedProxyCidrs = trustedProxiesField(
    required(source, 'API_TRUSTED_PROXIES', invalid),
    invalid,
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

  if (invalid.length > 0) {
    const fieldNames = [...new Set([...REQUIRED_FIELDS.filter((name) => source[name] === undefined || source[name]?.trim() === ''), ...invalid])];
    throw new EnvironmentValidationError(fieldNames);
  }

  return {
    nodeEnv: nodeEnv as RuntimeEnvironment,
    port,
    bindAddress,
    allowedHosts,
    trustedProxyCidrs,
    database: {
      host,
      port: databasePort,
      name: databaseName,
      user: databaseUser,
      password: databasePassword,
      connectTimeoutMs,
    },
  };
}