import { isIP } from 'node:net';

export interface MigrationEnvironment {
  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly name: string;
    readonly user: string;
    readonly password: string;
    readonly connectTimeoutMs: number;
  };
  readonly lockTimeoutSeconds: number;
  readonly statementTimeoutSeconds: number;
  readonly minimumSupportedApiVersion: number;
  readonly apiDatabaseUser: string;
}

export class MigrationEnvironmentError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`Invalid migration configuration fields: ${fields.join(', ')}`);
    this.name = 'MigrationEnvironmentError';
  }
}

function required(source: NodeJS.ProcessEnv, key: string, invalid: string[]): string {
  const value = source[key];
  if (value === undefined || value.trim() === '') {
    invalid.push(key);
    return '';
  }
  return value.trim();
}

function integer(source: NodeJS.ProcessEnv, key: string, min: number, max: number, invalid: string[]): number {
  const value = required(source, key, invalid);
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    invalid.push(key);
    return min;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    invalid.push(key);
    return min;
  }
  return number;
}

export function readMigrationEnvironment(source: NodeJS.ProcessEnv): MigrationEnvironment {
  const invalid: string[] = [];
  const host = required(source, 'MIGRATION_DATABASE_HOST', invalid);
  if (!/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) && isIP(host) === 0) {
    invalid.push('MIGRATION_DATABASE_HOST');
  }
  const port = integer(source, 'MIGRATION_DATABASE_PORT', 1, 65535, invalid);
  const name = required(source, 'MIGRATION_DATABASE_NAME', invalid);
  if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) invalid.push('MIGRATION_DATABASE_NAME');
  const user = required(source, 'MIGRATION_DATABASE_USER', invalid);
  if (!/^[A-Za-z0-9_]{1,64}$/.test(user)) invalid.push('MIGRATION_DATABASE_USER');
  const password = source.MIGRATION_DATABASE_PASSWORD;
  if (password === undefined || password.length === 0) invalid.push('MIGRATION_DATABASE_PASSWORD');
  const connectTimeoutMs = integer(source, 'MIGRATION_DATABASE_CONNECT_TIMEOUT_MS', 100, 30_000, invalid);
  const lockTimeoutSeconds = integer(source, 'MIGRATION_LOCK_TIMEOUT_SECONDS', 1, 300, invalid);
  const statementTimeoutSeconds = integer(source, 'MIGRATION_STATEMENT_TIMEOUT_SECONDS', 1, 3600, invalid);
  const minimumSupportedApiVersion = integer(source, 'MIGRATION_MIN_SUPPORTED_API_VERSION', 1, 1_000_000, invalid);
  const apiDatabaseUser = required(source, 'API_DATABASE_USER', invalid);
  if (!/^[A-Za-z0-9_]{1,64}$/.test(apiDatabaseUser)) invalid.push('API_DATABASE_USER');
  if (user === apiDatabaseUser || ['root', 'mysql'].includes(user.toLowerCase())) {
    invalid.push('MIGRATION_DATABASE_USER');
  }

  if (invalid.length > 0) throw new MigrationEnvironmentError([...new Set(invalid)]);
  return {
    database: { host, port, name, user, password: password ?? '', connectTimeoutMs },
    lockTimeoutSeconds,
    statementTimeoutSeconds,
    minimumSupportedApiVersion,
    apiDatabaseUser,
  };
}
