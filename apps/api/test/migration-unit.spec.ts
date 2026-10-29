import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MigrationEnvironmentError, readMigrationEnvironment } from '../src/database/migrations/migration-environment.js';
import { migrationStepChecksum } from '../src/database/migrations/migration-fingerprint.js';
import { MIGRATIONS } from '../src/database/migrations/migrations.js';

const validEnvironment: NodeJS.ProcessEnv = {
  MIGRATION_DATABASE_HOST: '127.0.0.1',
  MIGRATION_DATABASE_PORT: '3306',
  MIGRATION_DATABASE_NAME: 'ca_meta_m203_test',
  MIGRATION_DATABASE_USER: 'ca_meta_migrator',
  MIGRATION_DATABASE_PASSWORD: 'synthetic-secret',
  MIGRATION_DATABASE_CONNECT_TIMEOUT_MS: '5000',
  MIGRATION_LOCK_TIMEOUT_SECONDS: '3',
  MIGRATION_STATEMENT_TIMEOUT_SECONDS: '30',
  MIGRATION_MIN_SUPPORTED_API_VERSION: '1',
  API_DATABASE_USER: 'ca_meta_api',
};

test('migration configuration requires a dedicated runtime identity and never falls back to API credentials', () => {
  const configured = readMigrationEnvironment(validEnvironment);
  assert.equal(configured.database.user, 'ca_meta_migrator');
  assert.equal(configured.apiDatabaseUser, 'ca_meta_api');

  const onlyRuntime = { API_DATABASE_HOST: '127.0.0.1', API_DATABASE_USER: 'ca_meta_api' } as NodeJS.ProcessEnv;
  assert.throws(() => readMigrationEnvironment(onlyRuntime), (error: unknown) => {
    assert.ok(error instanceof MigrationEnvironmentError);
    assert.ok(error.fields.includes('MIGRATION_DATABASE_USER'));
    assert.ok(error.fields.includes('MIGRATION_DATABASE_PASSWORD'));
    return true;
  });
});

test('migration configuration rejects runtime account reuse and privileged built-in users', () => {
  assert.throws(() => readMigrationEnvironment({
    ...validEnvironment,
    MIGRATION_DATABASE_USER: 'ca_meta_api',
  }), (error: unknown) => error instanceof MigrationEnvironmentError && error.fields.includes('MIGRATION_DATABASE_USER'));
  assert.throws(() => readMigrationEnvironment({
    ...validEnvironment,
    MIGRATION_DATABASE_USER: 'root',
  }), (error: unknown) => error instanceof MigrationEnvironmentError && error.fields.includes('MIGRATION_DATABASE_USER'));
});

test('versioned migrations carry deterministic checksums and explicit lifecycle phases', () => {
  assert.equal(MIGRATIONS.length, 2);
  assert.deepEqual(MIGRATIONS.map((migration) => migration.schemaVersion), [1, 2]);
  for (const migration of MIGRATIONS) assert.match(migration.checksum, /^[a-f0-9]{64}$/);
  assert.deepEqual(MIGRATIONS[0]?.steps.map((step) => step.phase), ['expand', 'expand', 'expand', 'expand']);
  assert.deepEqual(MIGRATIONS[1]?.steps.map((step) => step.phase), ['expand', 'expand', 'expand', 'backfill', 'validate']);
});

test('migration fingerprints detect definition configuration and callback drift', () => {
  const verifyPresent = async (): Promise<boolean> => true;
  const verifyMissing = async (): Promise<boolean> => false;
  const ddl = (definition: string, verify: () => Promise<boolean>) => ({
    id: 'ddl-shape',
    phase: 'expand' as const,
    definitionVersion: 'v1',
    definition,
    retryWhenAbsent: true as const,
    sql: 'CREATE TABLE example (id CHAR(36) PRIMARY KEY)',
    verify,
  });
  assert.equal(migrationStepChecksum(ddl('{"columns":["id"]}', verifyPresent)), migrationStepChecksum(ddl('{"columns":["id"]}', verifyPresent)));
  assert.notEqual(migrationStepChecksum(ddl('{"columns":["id"]}', verifyPresent)), migrationStepChecksum(ddl('{"columns":["id","tenant_id"]}', verifyPresent)));
  assert.notEqual(migrationStepChecksum(ddl('{"columns":["id"]}', verifyPresent)), migrationStepChecksum(ddl('{"columns":["id"]}', verifyMissing)));

  const backfill = (runBatch: () => Promise<{ nextCursor: string | null; done: boolean }>) => ({
    id: 'callback-backfill',
    phase: 'backfill' as const,
    definitionVersion: 'v1',
    definition: '{"batchSize":200}',
    batchSize: 200,
    runBatch,
  });
  const originalBackfill = async () => ({ nextCursor: null, done: true });
  const changedBackfill = async () => ({ nextCursor: 'next', done: false });
  assert.notEqual(migrationStepChecksum(backfill(originalBackfill)), migrationStepChecksum(backfill(changedBackfill)));

  const validate = (validateCallback: () => Promise<void>) => ({
    id: 'callback-validation',
    phase: 'validate' as const,
    definitionVersion: 'v1',
    definition: '{"predicate":"exact"}',
    validate: validateCallback,
  });
  const originalValidation = async (): Promise<void> => {};
  const changedValidation = async (): Promise<void> => { throw new Error('different validation'); };
  assert.notEqual(migrationStepChecksum(validate(originalValidation)), migrationStepChecksum(validate(changedValidation)));
});
