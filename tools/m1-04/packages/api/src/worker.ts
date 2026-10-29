import type { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';

export interface OutboxJob {
  id: string;
  operation_key: string;
  tenant_ref: string;
  attempts: number;
  claimToken: string;
}

function validateLeaseSeconds(leaseSeconds: number): void {
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) {
    throw new RangeError('leaseSeconds must be an integer in [1, 300]');
  }
}

function affectedRows(result: unknown): number {
  if (Array.isArray(result)) return result.length === 0 ? 0 : affectedRows(result[0]);
  if (typeof result === 'object' && result !== null && 'affectedRows' in result) {
    return Number(result.affectedRows);
  }
  return 0;
}

export async function claimNextJob(
  dataSource: DataSource,
  leaseSeconds = 2,
): Promise<OutboxJob | null> {
  validateLeaseSeconds(leaseSeconds);

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

    const claimToken = randomUUID();
    await runner.query(
      `UPDATE m104_outbox_jobs
       SET status = 'RUNNING', attempts = attempts + 1,
           claim_token = ?,
           lease_until = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ${leaseSeconds} SECOND)
       WHERE id = ?`,
      [claimToken, job.id],
    );
    await runner.commitTransaction();
    return { ...job, attempts: Number(job.attempts) + 1, claimToken };
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

export async function renewJobLease(
  dataSource: DataSource,
  jobId: string,
  claimToken: string,
  leaseSeconds = 2,
): Promise<boolean> {
  validateLeaseSeconds(leaseSeconds);
  const result: unknown = await dataSource.query(
    `UPDATE m104_outbox_jobs
     SET lease_until = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ${leaseSeconds} SECOND)
     WHERE id = ? AND status = 'RUNNING' AND claim_token = ?
       AND lease_until > UTC_TIMESTAMP(6)`,
    [jobId, claimToken],
  );
  return affectedRows(result) === 1;
}

export async function persistFakeEffect(dataSource: DataSource, operationKey: string): Promise<void> {
  await dataSource.query(
    `INSERT INTO m104_fake_effects (operation_key, effect_count)
     VALUES (?, 1)
     ON DUPLICATE KEY UPDATE effect_count = effect_count`,
    [operationKey],
  );
}

export async function acknowledgeJob(
  dataSource: DataSource,
  jobId: string,
  claimToken: string,
): Promise<boolean> {
  const result: unknown = await dataSource.query(
    `UPDATE m104_outbox_jobs
     SET status = 'DONE', lease_until = NULL, claim_token = NULL
     WHERE id = ? AND status = 'RUNNING' AND claim_token = ?
       AND lease_until > UTC_TIMESTAMP(6)`,
    [jobId, claimToken],
  );
  return affectedRows(result) === 1;
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
