import { createHash } from 'node:crypto';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise';
import type { ApiEnvironment } from '../../config/environment.js';
import { SafeBoundaryError } from './security.errors.js';

export type AbuseLimitPolicy = 'PORTAL_PREAUTH' | 'PORTAL_EXCHANGE' | 'MAGIC_LINK_REQUEST' | 'MAGIC_LINK_CONSUME' |
  'ONBOARDING_START' | 'SESSION_STATUS' | 'ADMIN_ACTION';
export type AbuseLimitDimension = 'ip' | 'actor' | 'tenant';

interface Policy {
  readonly limit: number;
  readonly windowSeconds: number;
  readonly dimensions: readonly AbuseLimitDimension[];
}

export const ABUSE_LIMIT_POLICIES: Readonly<Record<AbuseLimitPolicy, Policy>> = Object.freeze({
  PORTAL_PREAUTH: { limit: 20, windowSeconds: 60, dimensions: ['ip'] },
  PORTAL_EXCHANGE: { limit: 10, windowSeconds: 60, dimensions: ['ip', 'actor'] },
  MAGIC_LINK_REQUEST: { limit: 5, windowSeconds: 60, dimensions: ['ip', 'tenant'] },
  MAGIC_LINK_CONSUME: { limit: 10, windowSeconds: 60, dimensions: ['ip', 'actor'] },
  ONBOARDING_START: { limit: 20, windowSeconds: 60, dimensions: ['ip', 'actor', 'tenant'] },
  SESSION_STATUS: { limit: 120, windowSeconds: 60, dimensions: ['ip', 'actor', 'tenant'] },
  ADMIN_ACTION: { limit: 30, windowSeconds: 60, dimensions: ['ip', 'actor', 'tenant'] },
});

export interface AbuseLimitDimensions {
  readonly ip?: string;
  readonly actor?: string;
  readonly tenant?: string;
}

export abstract class AbuseLimitService {
  abstract consume(policy: AbuseLimitPolicy, dimensions: AbuseLimitDimensions): Promise<void>;
}

function hashDimension(kind: AbuseLimitDimension, value: string): string {
  return createHash('sha256').update(`abuse-limit\0${kind}\0${value}`, 'utf8').digest('hex');
}

@Injectable()
export class MysqlAbuseLimitService extends AbuseLimitService implements OnApplicationShutdown {
  private readonly pool: Pool;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(environment: ApiEnvironment['database']) {
    super();
    this.pool = createPool({
      host: environment.host,
      port: environment.port,
      database: environment.name,
      user: environment.user,
      password: environment.password,
      connectTimeout: environment.connectTimeoutMs,
      connectionLimit: 8,
      waitForConnections: true,
      queueLimit: 100,
      multipleStatements: false,
      charset: 'utf8mb4',
      dateStrings: true,
      timezone: 'Z',
    });
    this.cleanupTimer = setInterval(() => {
      void this.pool.execute(
        'DELETE FROM ca_meta_abuse_limit_buckets WHERE updated_at < DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 2 DAY) LIMIT 1000',
      ).catch(() => undefined);
    }, 15 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  async consume(policyName: AbuseLimitPolicy, dimensions: AbuseLimitDimensions): Promise<void> {
    const policy = ABUSE_LIMIT_POLICIES[policyName];
    if (!policy) throw new Error('Unsupported abuse limit policy.');
    const applicable = policy.dimensions.map((kind) => ({ kind, value: dimensions[kind] }));
    if (applicable.some(({ value }) => typeof value !== 'string' || value.length === 0 || value.length > 512)) {
      throw new SafeBoundaryError('RATE_LIMITED');
    }
    for (const { kind, value } of applicable) {
      const digest = hashDimension(kind, value as string);
      const connection = await this.pool.getConnection();
      try {
        const [windowRows] = await connection.execute<Array<RowDataPacket & { window_start: string }>>(
          `SELECT DATE_FORMAT(FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(UTC_TIMESTAMP(6)) / ?) * ?), '%Y-%m-%d %H:%i:%s') AS window_start`,
          [policy.windowSeconds, policy.windowSeconds],
        );
        const windowStart = windowRows[0]?.window_start;
        if (!windowStart) throw new Error('Database did not return an abuse limit window.');
        await connection.execute(
        `INSERT INTO ca_meta_abuse_limit_buckets
         (policy, dimension_hash, window_start, request_count, updated_at)
         VALUES (?, ?, ?, 1, UTC_TIMESTAMP(6))
         ON DUPLICATE KEY UPDATE request_count = request_count + 1, updated_at = UTC_TIMESTAMP(6)`,
          [policyName, digest, windowStart],
        );
        const [counts] = await connection.execute<Array<RowDataPacket & { request_count: number | string }>>(
          `SELECT request_count FROM ca_meta_abuse_limit_buckets
           WHERE policy = ? AND dimension_hash = ? AND window_start = ? LIMIT 1`,
          [policyName, digest, windowStart],
        );
        if (Number(counts[0]?.request_count ?? 0) > policy.limit) throw new SafeBoundaryError('RATE_LIMITED');
      } finally {
        connection.release();
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.cleanupTimer);
    await this.pool.end();
  }
}
