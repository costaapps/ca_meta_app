import { performance } from 'node:perf_hooks';

export const CLOCK = Symbol('CLOCK');

export interface MonotonicClock {
  now(): number;
}

export class SystemMonotonicClock implements MonotonicClock {
  now(): number {
    return performance.now();
  }
}
