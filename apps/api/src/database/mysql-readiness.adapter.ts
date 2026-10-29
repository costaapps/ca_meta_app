import { createConnection } from 'mysql2/promise';
import type { ApiEnvironment } from '../config/environment.js';
import type { DatabaseReadinessPort } from './database-readiness.port.js';

export class MysqlReadinessAdapter implements DatabaseReadinessPort {
  constructor(private readonly environment: ApiEnvironment['database']) {}

  async check(): Promise<void> {
    const connection = await createConnection({
      host: this.environment.host,
      port: this.environment.port,
      database: this.environment.name,
      user: this.environment.user,
      password: this.environment.password,
      connectTimeout: this.environment.connectTimeoutMs,
      multipleStatements: false,
    });
    try {
      await connection.ping();
    } finally {
      await connection.end();
    }
  }
}
