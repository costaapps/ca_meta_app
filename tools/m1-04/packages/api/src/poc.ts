import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createDataSource } from './data-source';
import {
  acknowledgeJob,
  claimNextJob,
  persistFakeEffect,
  type OutboxJob,
} from './worker';

type CountRow = { count: number | string };
type JobRow = { id: number | string; status: string; attempts: number | string };
type PlanRow = { key: string | null; type: string; rows: number | string };

function count(value: number | string): number {
  return Number(value);
}

async function enqueueJob(operationKey: string, tenantRef: string): Promise<void> {
  await dataSource.transaction(async (manager) => {
    await manager.query('INSERT INTO m104_records (attributes) VALUES (?)', [
      JSON.stringify({ tenantRef, synthetic: true }),
    ]);
    await manager.query(
      'INSERT INTO m104_outbox_jobs (operation_key, tenant_ref) VALUES (?, ?)',
      [operationKey, tenantRef],
    );
  });
}

async function verifyNestMariaDbRuntime(): Promise<void> {
  const server = spawn(process.execPath, [join(__dirname, 'main.js')], {
    env: process.env,
    stdio: 'ignore',
  });
  const deadline = Date.now() + 10_000;
  let ready = false;
  try {
    while (Date.now() < deadline && server.exitCode === null) {
      try {
        const response = await fetch('http://127.0.0.1:3000/health/live');
        if (response.ok) {
          const body = (await response.json()) as { status?: string };
          ready = body.status === 'ok';
          if (ready) break;
        }
      } catch {
        // The Nest process can need a short time to establish its MariaDB pool.
      }
      await delay(50);
    }
    assert.equal(ready, true, 'Nest API starts and its TypeORM MariaDB connection is ready');
    server.kill('SIGTERM');
    const stopped = await Promise.race([
      once(server, 'exit').then(() => true),
      delay(5_000).then(() => false),
    ]);
    assert.equal(stopped, true, 'Nest API exits after SIGTERM and releases its connection pool');
  } finally {
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  process.stdout.write('nestjs-mariadb=health endpoint passed; SIGTERM shutdown passed\n');
}

const dataSource = createDataSource();

async function main(): Promise<void> {
  await dataSource.initialize();
  try {
    const server = (await dataSource.query('SELECT VERSION() AS version')) as Array<{
      version: string;
    }>;
    process.stdout.write(`database=${server[0].version}\n`);

    const firstMigration = await dataSource.runMigrations();
    const secondMigration = await dataSource.runMigrations();
    assert.equal(firstMigration.length, 1, 'the explicit migration is applied once');
    assert.equal(secondMigration.length, 0, 'rerunning the migration is a no-op');
    process.stdout.write('migrations=1 then 0 (explicit ledger, synchronize=false)\n');
    await verifyNestMariaDbRuntime();

    await dataSource.query(
      'INSERT INTO m104_records (attributes) VALUES (?)',
      [JSON.stringify({ tenantRef: 'tenant-target', synthetic: true })],
    );
    await assert.rejects(
      dataSource.query('INSERT INTO m104_records (attributes) VALUES (?)', ['not-json']),
      (error: unknown) => error instanceof Error && /json|constraint/i.test(error.message),
      'MariaDB JSON alias rejects invalid JSON',
    );
    const extracted = (await dataSource.query(
      "SELECT tenant_ref FROM m104_records WHERE attributes = ?",
      [JSON.stringify({ tenantRef: 'tenant-target', synthetic: true })],
    )) as Array<{ tenant_ref: string }>;
    assert.equal(extracted[0]?.tenant_ref, 'tenant-target');

    const insertCount = 600;
    for (let offset = 0; offset < insertCount; offset += 100) {
      const values = Array.from({ length: 100 }, (_, localOffset) => {
        const index = offset + localOffset;
        const tenantRef = index === insertCount - 1 ? 'tenant-target' : `tenant-${index}`;
        return JSON.stringify({ tenantRef, synthetic: true, sample: index });
      });
      const tuples = values.map(() => '(?)').join(',');
      await dataSource.query(
        `INSERT INTO m104_records (attributes) VALUES ${tuples}`,
        values,
      );
    }
    const plan = (await dataSource.query(
      "EXPLAIN SELECT id FROM m104_records WHERE tenant_ref = 'tenant-target'",
    )) as PlanRow[];
    assert.equal(
      plan[0]?.key,
      'idx_m104_records_tenant_ref',
      'the optimizer selects the generated-column index for the selective lookup',
    );
    process.stdout.write(`json=valid accepted; invalid rejected; generated-index=${plan[0].key}; plan=${plan[0].type}\n`);

    const beforeRollback = (await dataSource.query(
      'SELECT COUNT(*) AS count FROM m104_records',
    )) as CountRow[];
    await assert.rejects(
      dataSource.transaction(async (manager) => {
        await manager.query('INSERT INTO m104_records (attributes) VALUES (?)', [
          JSON.stringify({ tenantRef: 'rollback-a', synthetic: true }),
        ]);
        await manager.query('INSERT INTO m104_records (attributes) VALUES (?)', [
          JSON.stringify({ tenantRef: 'rollback-b', synthetic: true }),
        ]);
        throw new Error('intentional DML rollback');
      }),
      /intentional DML rollback/,
    );
    const afterRollback = (await dataSource.query(
      'SELECT COUNT(*) AS count FROM m104_records',
    )) as CountRow[];
    assert.equal(count(afterRollback[0].count), count(beforeRollback[0].count));
    process.stdout.write('dml-rollback=passed (two writes absent after failure)\n');

    await enqueueJob('concurrent-a', 'tenant-a');
    await enqueueJob('concurrent-b', 'tenant-b');
    const concurrentClaims = await Promise.all([
      claimNextJob(dataSource),
      claimNextJob(dataSource),
    ]);
    assert.ok(concurrentClaims[0]);
    assert.ok(concurrentClaims[1]);
    assert.notEqual(
      concurrentClaims[0].id,
      concurrentClaims[1].id,
      'parallel workers do not claim the same locked row',
    );
    for (const job of concurrentClaims as OutboxJob[]) {
      await persistFakeEffect(dataSource, job.operation_key);
      await acknowledgeJob(dataSource, job.id);
    }
    process.stdout.write('concurrent-claims=2 unique outbox rows claimed with SKIP LOCKED\n');

    const crashOperationKey = 'crash-window-synthetic';
    await enqueueJob(crashOperationKey, 'tenant-crash');
    const childPath = join(__dirname, 'worker-child.js');
    const crash = spawnSync(
      process.execPath,
      [childPath, 'crash-after-effect', crashOperationKey],
      { env: process.env, encoding: 'utf8', timeout: 15_000 },
    );
    assert.equal(crash.error, undefined, 'crash worker process starts');
    assert.equal(crash.status, 73, 'first worker crashes after sink acceptance and before ACK');
    await delay(2_300);
    const restarted = spawnSync(
      process.execPath,
      [childPath, 'normal', crashOperationKey],
      { env: process.env, encoding: 'utf8', timeout: 15_000 },
    );
    assert.equal(restarted.error, undefined, 'restarted worker process starts');
    assert.equal(restarted.status, 0, 'replacement worker reclaims the expired lease and ACKs');
    const effects = (await dataSource.query(
      'SELECT COUNT(*) AS count FROM m104_fake_effects WHERE operation_key = ?',
      [crashOperationKey],
    )) as CountRow[];
    const crashJob = (await dataSource.query(
      'SELECT id, status, attempts FROM m104_outbox_jobs WHERE operation_key = ?',
      [crashOperationKey],
    )) as JobRow[];
    assert.equal(count(effects[0].count), 1, 'idempotent fake sink records one applied effect');
    assert.equal(crashJob[0]?.status, 'DONE');
    assert.equal(count(crashJob[0]?.attempts ?? 0), 2);
    process.stdout.write('crash-redelivery=worker process exited before ACK; new process reclaimed lease; attempts=2 effect-count=1\n');

    const shutdownFirst = 'shutdown-inflight';
    const shutdownNext = 'shutdown-next';
    await enqueueJob(shutdownFirst, 'tenant-shutdown');
    await enqueueJob(shutdownNext, 'tenant-shutdown');
    const workerProcess = spawn(
      process.execPath,
      [join(__dirname, 'worker-child.js'), 'graceful-loop', shutdownFirst],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const output: string[] = [];
    const lines = createInterface({ input: workerProcess.stdout });
    let markClaimed!: () => void;
    let failClaimed!: (error: Error) => void;
    const claimed = new Promise<void>((resolve, reject) => {
      markClaimed = resolve;
      failClaimed = reject;
    });
    const expectedClaimLine = `CLAIMED:${shutdownFirst}`;
    lines.on('line', (line) => {
      output.push(line);
      if (line === expectedClaimLine) markClaimed();
    });
    workerProcess.once('error', (error) => failClaimed(error));
    const exited = once(workerProcess, 'exit');
    const claimTimeout = setTimeout(
      () => failClaimed(new Error('worker did not claim the shutdown test job')),
      10_000,
    );
    try {
      await claimed;
      clearTimeout(claimTimeout);
      workerProcess.kill('SIGTERM');
      await delay(50);
      assert.equal(workerProcess.exitCode, null, 'SIGTERM does not abandon an in-flight job');
      const [exitCode, signal] = await Promise.race([
        exited as Promise<[number | null, NodeJS.Signals | null]>,
        delay(5_000).then(() => {
          throw new Error('worker did not exit after draining its in-flight job');
        }),
      ]);
      assert.equal(exitCode, 0);
      assert.equal(signal, null);
    } finally {
      clearTimeout(claimTimeout);
      lines.close();
      if (workerProcess.exitCode === null) workerProcess.kill('SIGKILL');
    }
    assert.deepEqual(output, [expectedClaimLine], 'the worker never claims the next job after SIGTERM');
    const shutdownRows = (await dataSource.query(
      'SELECT operation_key, status FROM m104_outbox_jobs WHERE operation_key IN (?, ?) ORDER BY id',
      [shutdownFirst, shutdownNext],
    )) as Array<{ operation_key: string; status: string }>;
    assert.deepEqual(shutdownRows.map((row) => row.status), ['DONE', 'PENDING']);
    process.stdout.write('worker-sigterm=real child process drained one claimed job, exited 0, and left the next PENDING\n');

    const totals = (await dataSource.query(`
      SELECT
        (SELECT COUNT(*) FROM m104_outbox_jobs) AS jobs,
        (SELECT COUNT(*) FROM m104_fake_effects) AS fake_effects
    `)) as Array<{ jobs: number | string; fake_effects: number | string }>;
    process.stdout.write(`synthetic-summary jobs=${count(totals[0].jobs)} fake-effects=${count(totals[0].fake_effects)} external-calls=0 production-writes=0\n`);
    process.stdout.write('M1.04 MariaDB/worker PoC PASS\n');
  } finally {
    await dataSource.destroy();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : 'unknown error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
