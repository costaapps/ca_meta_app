import { DataSource } from 'typeorm';
import type { OnModuleDestroy } from '@nestjs/common';
import type { ApiEnvironment } from '../config/environment.js';

export function createDurableWorkDataSource(environment: ApiEnvironment): DataSource {
  return new DataSource({
    type: 'mariadb',
    host: environment.database.host,
    port: environment.database.port,
    username: environment.database.user,
    password: environment.database.password,
    database: environment.database.name,
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: true,
    connectTimeout: environment.database.connectTimeoutMs,
    synchronize: false,
    migrationsRun: false,
    migrationsTransactionMode: 'none',
    logging: false,
    extra: { connectionLimit: 8 },
  });
}

/** Lazy API connection so health/liveness boot does not acquire a DB connection. */
export class DurableWorkDatabase implements OnModuleDestroy {
  private readonly dataSource: DataSource;
  private initializing?: Promise<DataSource>;

  constructor(environment: ApiEnvironment) {
    this.dataSource = createDurableWorkDataSource(environment);
  }

  getDataSource(): Promise<DataSource> {
    if (this.dataSource.isInitialized) return Promise.resolve(this.dataSource);
    this.initializing ??= this.dataSource.initialize().catch((error: unknown) => {
      this.initializing = undefined;
      throw error;
    });
    return this.initializing;
  }

  async close(): Promise<void> {
    if (this.initializing) await this.initializing.catch(() => undefined);
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
