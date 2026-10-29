import { readMigrationEnvironment } from '../../src/database/migrations/migration-environment.js';
import { MIGRATIONS } from '../../src/database/migrations/migrations.js';
import { deployMigrations } from '../../src/database/migrations/migration-runner.js';

async function main(): Promise<void> {
  const environment = readMigrationEnvironment(process.env);
  const migrationId = process.argv[2];
  const migration = MIGRATIONS.find((candidate) => candidate.id === migrationId);
  if (!migration) throw new Error('Expected synthetic migration is missing.');
  await deployMigrations(environment, [migration], {
    afterDdl: (_id, stepId) => {
      if (process.env.M2_CRASH_AFTER_DDL_STEP === stepId) process.exit(86);
    },
    afterBackfillBatch: (_id, stepId, _cursor, done) => {
      if (process.env.M2_CRASH_AFTER_BACKFILL_STEP === stepId && !done) process.exit(87);
    },
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? `${error.name}: ${error.message}\n` : 'Migration fixture failed.\n');
  process.exitCode = 1;
});
