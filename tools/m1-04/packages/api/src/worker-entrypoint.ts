import 'reflect-metadata';
import { createDataSource } from './data-source';
import { runWorker, type OutboxJob } from './worker';

export async function startWorker(
  processJob: (job: OutboxJob) => Promise<void>,
): Promise<void> {
  const dataSource = createDataSource();
  await dataSource.initialize();
  const stop = new AbortController();
  const onSigterm = (): void => stop.abort();
  const onSigint = (): void => stop.abort();
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigint);

  try {
    await runWorker(dataSource, stop.signal, processJob);
  } finally {
    process.off('SIGTERM', onSigterm);
    process.off('SIGINT', onSigint);
    await dataSource.destroy();
  }
}
