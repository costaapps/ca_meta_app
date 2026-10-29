import { validateEnvironment } from '../../src/config/environment.js';
import { DurableWorkDatabase } from '../../src/jobs/durable-work-database.js';
import { DurableJobStore } from '../../src/jobs/job-store.js';

async function claimThenWaitForParentKill(): Promise<void> {
  const database = new DurableWorkDatabase(validateEnvironment(process.env));
  const jobs = new DurableJobStore(database, () => 0);
  const claim = await jobs.claimNext('crash-fixture-child', 120, ['INBOX_PROCESS']);
  if (!claim) {
    process.send?.({ type: 'no-claim' });
    process.exit(87);
  }
  process.send?.({ type: 'claimed', jobId: claim.id }, () => {
    // Keep the process alive with an open pool and an unacknowledged lease until the parent kills it.
    setTimeout(() => process.exit(88), 30_000);
  });
}

void claimThenWaitForParentKill().catch(() => process.exit(89));
