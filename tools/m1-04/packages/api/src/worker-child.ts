import 'reflect-metadata';
import { setTimeout as delay } from 'node:timers/promises';
import { createDataSource } from './data-source';
import { acknowledgeJob, claimNextJob, persistFakeEffect, runWorker } from './worker';

async function main(): Promise<void> {
  const mode = process.argv[2];
  const expectedOperationKey = process.argv[3];
  const dataSource = createDataSource();
  await dataSource.initialize();

  if (mode === 'graceful-loop') {
    const stop = new AbortController();
    const onSigterm = (): void => stop.abort();
    process.once('SIGTERM', onSigterm);
    try {
      await runWorker(dataSource, stop.signal, async (job) => {
        process.stdout.write(`CLAIMED:${job.operation_key}\n`);
        await delay(500);
        await persistFakeEffect(dataSource, job.operation_key);
        const acknowledged = await acknowledgeJob(dataSource, job.id, job.claimToken);
        if (!acknowledged) throw new Error('worker lost its lease before ACK');
      });
    } finally {
      process.off('SIGTERM', onSigterm);
      await dataSource.destroy();
    }
    return;
  }

  const job = await claimNextJob(dataSource);
  if (!job) {
    await dataSource.destroy();
    process.exitCode = 4;
    return;
  }
  if (job.operation_key !== expectedOperationKey) {
    await dataSource.destroy();
    throw new Error('claimed job did not match the expected synthetic operation');
  }

  await persistFakeEffect(dataSource, job.operation_key);
  if (mode === 'crash-after-effect') {
    // Intentional process crash: fake sink accepted the operation, but no DB ACK is written.
    process.exit(73);
  }

  const acknowledged = await acknowledgeJob(dataSource, job.id, job.claimToken);
  if (!acknowledged) throw new Error('worker lost its lease before ACK');
  await dataSource.destroy();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown error';
  process.stderr.write(`worker-child failed: ${message}\n`);
  process.exitCode = 1;
});
