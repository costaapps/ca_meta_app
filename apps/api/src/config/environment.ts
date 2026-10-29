import { isIP } from 'node:net';

export type RuntimeEnvironment = 'development' | 'test' | 'staging' | 'production';

export interface ApiEnvironment {
  readonly nodeEnv: RuntimeEnvironment;
  readonly port: number;
  readonly bindAddress: string;
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

function trustedProxiesField(value: string, invalid: string[]): false | readonly string[] {
  if (value === 'none') return false;

  const entries = value.split(',').map((entry) => entry.trim());
  const valid = entries.length > 0 && entries.every((entry) => {
    const [address, prefix, extra] = entry.split('/');
    if (extra !== undefined || isIP(address) === 0) return false;
    if (prefix === undefined) return true;
    if (!/^(0|[1-9]\d*)$/.test(prefix)) return false;
    const bits = Number(prefix);
    return bits <= (isIP(address) === 4 ? 32 : 128);
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
  const databasePassword = required(source, 'API_DATABASE_PASSWORD', invalid);
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
