import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type MonotonicClock } from '../common/time/clock.port.js';
import { DATABASE_READINESS_PORT, type DatabaseReadinessPort } from '../database/database-readiness.port.js';

export const READINESS_CACHE_MS = 250;

@Injectable()
export class ReadinessService {
  private inFlight: Promise<boolean> | undefined;
  private cached: { readonly checkedAt: number; readonly result: boolean } | undefined;

  constructor(
    @Inject(DATABASE_READINESS_PORT) private readonly database: DatabaseReadinessPort,
    @Inject(CLOCK) private readonly clock: MonotonicClock,
  ) {}

  async isReady(): Promise<boolean> {
    const now = this.clock.now();
    if (this.cached && now >= this.cached.checkedAt && now - this.cached.checkedAt < READINESS_CACHE_MS) {
      return this.cached.result;
    }
    if (this.inFlight) return this.inFlight;

    const current = this.database.check().then(
      () => true,
      () => false,
    );
    this.inFlight = current;
    try {
      const result = await current;
      this.cached = { checkedAt: this.clock.now(), result };
      return result;
    } finally {
      if (this.inFlight === current) this.inFlight = undefined;
    }
  }
}