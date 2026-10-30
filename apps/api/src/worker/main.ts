import 'reflect-metadata';
import { EnvironmentValidationError, validateEnvironment } from '../config/environment.js';
import { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import { DurableJobStore } from '../jobs/job-store.js';
import type { JobType } from '../jobs/event-validation.js';
import { DurableWorker, type JobHandler } from './durable-worker.js';

export async function bootstrapWorker(): Promise<void> {
  let database: DurableWorkDatabase | undefined;
  try {
    const environment = validateEnvironment(process.env);
    database = new DurableWorkDatabase(environment);
    const handlers = new Map<JobType, JobHandler>();
    // M2.05 provides the durable runner. Business/provider adapters register handlers in their own reviewed scope.
    const worker = new DurableWorker(new DurableJobStore(database), {
      workerRef: `api-worker:${process.pid}`,
      leaseMs: 30_000,
    }, handlers);
    const stopping = new AbortController();
    const stop = () => stopping.abort();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    process.stdout.write(`${JSON.stringify({ level: 'info', event: 'worker.started', handlers: 0 })}\n`);
    try {
      await worker.run(stopping.signal);
    } finally {
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
    }
  } catch (error) {
    const fields = error instanceof EnvironmentValidationError ? error.fieldNames : undefined;
    process.stderr.write(`${JSON.stringify({ level: 'error', event: fields ? 'configuration.invalid' : 'worker.failed', ...(fields ? { fields } : {}) })}\n`);
    process.exitCode = 1;
  } finally {
    if (database) await database.close().catch(() => { process.exitCode = 1; });
  }
}

if (require.main === module) void bootstrapWorker();
