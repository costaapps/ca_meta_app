import type { EntityManager } from 'typeorm';
import type { ClaimedJob, JobFinalization, JobOutcome, JobStore } from '../jobs/job-store.js';
import { JOB_POLICIES, type JobType } from '../jobs/event-validation.js';

export type JobHandler = (job: ClaimedJob, signal: AbortSignal) => Promise<JobOutcome>;
export type JobFinalizer = (manager: EntityManager, job: ClaimedJob, finalization: JobFinalization) => Promise<void>;

export interface WorkerOptions {
  readonly workerRef: string;
  readonly leaseMs: number;
  readonly heartbeatMs?: number;
  readonly idlePollMs?: number;
  /** Test/adapter override may shorten a type deadline, never extend its policy maximum. */
  readonly handlerTimeoutOverrides?: Partial<Record<JobType, number>>;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Claims only jobs with a registered handler. The handler runs after claim commits; each heartbeat is a short separate update. */
export class DurableWorker {
  private readonly handlers: ReadonlyMap<JobType, JobHandler>;
  private readonly finalizers: ReadonlyMap<JobType, JobFinalizer>;
  private readonly heartbeatMs: number;
  private readonly idlePollMs: number;

  constructor(
    private readonly store: JobStore,
    private readonly options: WorkerOptions,
    handlers: ReadonlyMap<JobType, JobHandler>,
    finalizers: ReadonlyMap<JobType, JobFinalizer> = new Map(),
  ) {
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(options.workerRef)) throw new Error('Invalid worker reference.');
    if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 100 || options.leaseMs > 300_000) {
      throw new RangeError('leaseMs must be an integer in [100, 300000].');
    }
    this.heartbeatMs = options.heartbeatMs ?? Math.max(25, Math.floor(options.leaseMs / 3));
    this.idlePollMs = options.idlePollMs ?? 250;
    if (!Number.isSafeInteger(this.heartbeatMs) || this.heartbeatMs < 1 || this.heartbeatMs >= options.leaseMs) {
      throw new RangeError('heartbeatMs must be a positive integer shorter than the lease.');
    }
    if (!Number.isSafeInteger(this.idlePollMs) || this.idlePollMs < 1 || this.idlePollMs > 30_000) {
      throw new RangeError('idlePollMs must be an integer in [1, 30000].');
    }
    for (const [type, timeout] of Object.entries(options.handlerTimeoutOverrides ?? {})) {
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > JOB_POLICIES[type as JobType].maxHandlerMs) {
        throw new RangeError(`handlerTimeoutOverrides.${type} must be positive and no greater than its job policy.`);
      }
    }
    this.handlers = new Map(handlers);
    this.finalizers = new Map(finalizers);
  }

  async run(signal: AbortSignal): Promise<void> {
    const supportedTypes = [...this.handlers.keys()];
    while (!signal.aborted) {
      const job = await this.store.claimNext(this.options.workerRef, this.options.leaseMs, supportedTypes);
      if (!job) {
        await delay(this.idlePollMs, signal);
        continue;
      }
      // SIGTERM stops new claims, then drains the current handler before run() returns.
      await this.execute(job);
    }
  }

  private async execute(job: ClaimedJob): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) return;
    const controller = new AbortController();
    let finished = false;
    let leaseLost = false;
    let timedOut = false;
    const handlerTimeoutMs = this.options.handlerTimeoutOverrides?.[job.type] ?? JOB_POLICIES[job.type].maxHandlerMs;
    const handlerDeadline = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, handlerTimeoutMs);
    const heartbeat = (async () => {
      while (!finished) {
        await delay(this.heartbeatMs);
        if (finished) return;
        try {
          if (!(await this.store.renew(job, this.options.leaseMs))) {
            leaseLost = true;
            controller.abort();
            return;
          }
        } catch {
          leaseLost = true;
          controller.abort();
          return;
        }
      }
    })();

    let outcome: JobOutcome;
    try {
      outcome = await handler(job, controller.signal);
    } catch {
      outcome = job.effectMode === 'AMBIGUOUS'
        ? { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' }
        : { kind: 'RETRYABLE_FAILURE', safeErrorCode: 'HANDLER_FAILED' };
    } finally {
      clearTimeout(handlerDeadline);
      finished = true;
      await heartbeat;
    }
    if (timedOut) {
      outcome = job.effectMode === 'AMBIGUOUS'
        ? { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' }
        : { kind: 'RETRYABLE_FAILURE', safeErrorCode: 'DEPENDENCY_TIMEOUT' };
    }
    if (!leaseLost) {
      const finalizer = this.finalizers.get(job.type);
      if (finalizer) await this.store.finish(job, outcome, undefined,
        (manager, finalization) => finalizer(manager, job, finalization));
      else await this.store.finish(job, outcome);
    }
  }
}
