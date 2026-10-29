import { readMigrationEnvironment } from './migration-environment.js';
import { deployMigrations, readMigrationStatus, safeMigrationError } from './migration-runner.js';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'deploy' && command !== 'status') {
    process.stderr.write('Usage: migrate:deploy | migrate:status\n');
    process.exitCode = 2;
    return;
  }
  try {
    const environment = readMigrationEnvironment(process.env);
    if (command === 'deploy') {
      await deployMigrations(environment);
      process.stdout.write('Migrations are applied.\n');
      return;
    }
    const status = await readMigrationStatus(environment);
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error && error.name === 'MigrationEnvironmentError'
      ? error.message
      : safeMigrationError(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

void main();
