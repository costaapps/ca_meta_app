import { createConnection } from 'mysql2/promise';
import type { ApiEnvironment } from '../config/environment.js';
import type { DatabaseReadinessPort } from './database-readiness.port.js';

export interface ReadinessConnection {
  ping(): Promise<void>;
  destroy(): void;
}

export type ReadinessConnectionFactory = (
  environment: ApiEnvironment['database'],
) => Promise<ReadinessConnection>;

const defaultConnectionFactory: ReadinessConnectionFactory = (environment) =>
  createConnection({
    host: environment.host,
    port: environment.port,
    database: environment.name,
    user: environment.user,
    password: environment.password,
    connectTimeout: environment.connectTimeoutMs,
    multipleStatements: false,
  });

export class MysqlReadinessAdapter implements DatabaseReadinessPort {
  constructor(
    private readonly environment: ApiEnvironment['database'],
    private readonly connect: ReadinessConnectionFactory = defaultConnectionFactory,
  ) {}

  async check(): Promise<void> {
    const connection = await this.connect(this.environment);
    let deadline: NodeJS.Timeout | undefined;
    let destroyed = false;
    const destroyOnce = (): void => {
      if (destroyed) return;
      destroyed = true;
      connection.destroy();
    };
    try {
      const ping = Promise.resolve().then(() => connection.ping());
      const timeout = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          destroyOnce();
          reject(new Error('Readiness ping deadline exceeded.'));
        }, this.environment.connectTimeoutMs);
      });
      await Promise.race([ping, timeout]);
    } finally {
      if (deadline) clearTimeout(deadline);
      destroyOnce();
    }
  }
}