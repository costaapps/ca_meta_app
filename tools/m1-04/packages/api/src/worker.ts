import type { DataSource } from 'typeorm';

export interface OutboxJob {
  id: string;
  operation_key: string;
  tenant_ref: string;
  attempts: number;
}

export async function claimNextJob(
  dataSource: DataSource,
  leaseSeconds = 2,
): Promise<OutboxJob | null> {
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) {
    throw new RangeError('leaseSeconds must be an integer in [1, 300]');
  }

  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const rows = (await runner.query(`
      SELECT id, operation_key, tenant_ref, attempts
      FROM m104_outbox_jobs
      WHERE (status = 'PENDING' AND available_at <= UTC_TIMESTAMP(6))
         OR (status = 'RUNNING' AND lease_until <= UTC_TIMESTAMP(6))
      ORDER BY id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `)) as OutboxJob[];

    const job = rows[0];
    if (!job) {
      await runner.commitTransaction();
      return null;
    }

    await runner.query(
      `UPDATE m104_outbox_jobs
       SET status = 'RUNNING', attempts = attempts + 1,
           lease_until = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ${leaseSeconds} SECOND)
       WHERE id = ?`,
      [job.id],
    );
    await runner.commitTransaction();
    return { ...job, attempts: Number(job.attempts) + 1 };
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

export async function persistFakeEffect(dataSource: DataSource, operationKey: string): Promise<void> {
  await dataSource.query(
    `INSERT INTO m104_fake_effects (operation_key, effect_count)
     VALUES (?, 1)
     ON DUPLICATE KEY UPDATE effect_count = effect_count`,
    [operationKey],
  );
}

export async function acknowledgeJob(dataSource: DataSource, jobId: string): Promise<void> {
  await dataSource.query(
    `UPDATE m104_outbox_jobs
     SET status = 'DONE', lease_until = NULL
     WHERE id = ? AND status = 'RUNNING'`,
    [jobId],
  );
}

export async function runWorker(
  dataSource: DataSource,
  stopSignal: AbortSignal,
  processJob: (job: OutboxJob) => Promise<void>,
): Promise<void> {
  while (!stopSignal.aborted) {
    const job = await claimNextJob(dataSource);
    if (!job) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      continue;
    }
    await processJob(job);
  }
}
