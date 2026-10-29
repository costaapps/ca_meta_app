import { Inject, Injectable } from '@nestjs/common';
import { DATABASE_READINESS_PORT, type DatabaseReadinessPort } from '../database/database-readiness.port.js';

@Injectable()
export class ReadinessService {
  constructor(@Inject(DATABASE_READINESS_PORT) private readonly database: DatabaseReadinessPort) {}

  async isReady(): Promise<boolean> {
    try {
      await this.database.check();
      return true;
    } catch {
      return false;
    }
  }
}
