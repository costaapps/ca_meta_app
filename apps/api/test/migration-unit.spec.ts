import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MigrationEnvironmentError, readMigrationEnvironment } from '../src/database/migrations/migration-environment.js';
import { migrationStepChecksum } from '../src/database/migrations/migration-fingerprint.js';
import { DOMAIN_TABLES, MIGRATIONS } from '../src/database/migrations/migrations.js';
import { DURABLE_WORK_MIGRATION } from '../src/database/migrations/durable-work.js';
import { IDENTITY_MIGRATION } from '../src/database/migrations/identity.js';
import { PORTAL_SESSIONS_MIGRATION } from '../src/database/migrations/portal-sessions.js';
import { TICKET_RETRY_MIGRATION } from '../src/database/migrations/ticket-retry.js';
import { META_ASSETS_MIGRATION, META_ASSETS_TABLES } from '../src/database/migrations/meta-assets.js';
import { MAGIC_LINKS_MIGRATION, MAGIC_LINK_TABLES } from '../src/database/migrations/magic-links.js';
import { PORTAL_SESSION_ENTRY_MODE_MIGRATION } from '../src/database/migrations/portal-session-entry-mode.js';
import { ONBOARDING_SESSIONS_MIGRATION, ONBOARDING_SESSION_TABLES } from '../src/database/migrations/onboarding-sessions.js';

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
  assert.equal(MIGRATIONS.length, 10);
  assert.deepEqual(MIGRATIONS.map((migration) => migration.schemaVersion), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  for (const migration of MIGRATIONS) assert.match(migration.checksum, /^[a-f0-9]{64}$/);
  assert.deepEqual(MIGRATIONS[0]?.steps.map((step) => step.phase), ['expand', 'expand', 'expand', 'expand']);
  assert.deepEqual(MIGRATIONS[1]?.steps.map((step) => step.phase), ['expand', 'expand', 'expand', 'backfill', 'validate']);
  assert.deepEqual(DURABLE_WORK_MIGRATION.steps.slice(0, 6).map((step) => step.id), [
    'create-durable-jobs', 'create-job-attempt-history', 'create-outbox-events',
    'create-inbox-events', 'create-job-dead-letters', 'create-replay-audit',
  ]);
  assert.ok(DURABLE_WORK_MIGRATION.steps.some((step) => step.id === 'replay-audit-no-update'));
  assert.ok(DURABLE_WORK_MIGRATION.steps.some((step) => step.id === 'replay-audit-no-delete'));
  const laneDispatchStep = DURABLE_WORK_MIGRATION.steps.find((step) => step.id === 'create-job-lane-dispatch');
  assert.ok(laneDispatchStep);
  assert.deepEqual(JSON.parse(laneDispatchStep.definition).indexes, [
    { name: 'PRIMARY', columns: ['lane'], unique: true },
  ]);
  assert.ok(DURABLE_WORK_MIGRATION.steps[0]?.definition.includes('ix_ca_meta_job_ambiguous_expired'));
  assert.ok(DURABLE_WORK_MIGRATION.steps[0]?.definition.includes('ix_ca_meta_job_tenant_resource_active'));
  assert.equal(IDENTITY_MIGRATION.id, '202610300001-principals-memberships');
  assert.equal(META_ASSETS_MIGRATION.schemaVersion, 7);
  assert.equal(MAGIC_LINKS_MIGRATION.schemaVersion, 8);
  assert.equal(PORTAL_SESSION_ENTRY_MODE_MIGRATION.id, '202610300009-portal-session-entry-mode');
  assert.equal(PORTAL_SESSION_ENTRY_MODE_MIGRATION.schemaVersion, 9);
  assert.equal(ONBOARDING_SESSIONS_MIGRATION.id, '202611030010-persisted-onboarding-sessions');
  assert.equal(ONBOARDING_SESSIONS_MIGRATION.schemaVersion, 10);
  assert.equal(MIGRATIONS[MIGRATIONS.length - 4]?.id, META_ASSETS_MIGRATION.id);
  assert.equal(MIGRATIONS[MIGRATIONS.length - 3]?.id, MAGIC_LINKS_MIGRATION.id);
  assert.equal(MIGRATIONS[MIGRATIONS.length - 2]?.id, PORTAL_SESSION_ENTRY_MODE_MIGRATION.id);
  assert.equal(MIGRATIONS[MIGRATIONS.length - 1]?.id, ONBOARDING_SESSIONS_MIGRATION.id);
  assert.ok(META_ASSETS_TABLES.every((table) => DOMAIN_TABLES.includes(table as typeof DOMAIN_TABLES[number])));
  assert.ok(MAGIC_LINK_TABLES.every((table) => DOMAIN_TABLES.includes(table as typeof DOMAIN_TABLES[number])));
  assert.ok(ONBOARDING_SESSION_TABLES.every((table) => DOMAIN_TABLES.includes(table as typeof DOMAIN_TABLES[number])));
  assert.deepEqual(IDENTITY_MIGRATION.steps.map((step) => step.id), [
    'create-principals', 'create-tenant-memberships', 'create-service-identity-scopes',
    'create-identity-admin-audit', 'identity-admin-audit-no-update', 'identity-admin-audit-no-delete',
  ]);
  const membershipStep = IDENTITY_MIGRATION.steps.find((step) => step.id === 'create-tenant-memberships');
  const serviceScopeStep = IDENTITY_MIGRATION.steps.find((step) => step.id === 'create-service-identity-scopes');
  assert.ok(membershipStep && 'sql' in membershipStep);
  assert.ok(serviceScopeStep && 'sql' in serviceScopeStep);
  assert.ok(membershipStep.sql.includes('PRIMARY KEY (tenant_id, principal_id)'));
  assert.ok(membershipStep.sql.includes("CHECK (principal_kind = 'USER')"));
  for (const role of ['owner', 'admin', 'operator', 'viewer']) {
    assert.ok(membershipStep.sql.includes(`JSON_CONTAINS(roles, JSON_QUOTE('${role}'))`));
  }
  assert.ok(serviceScopeStep.sql.includes("CHECK (principal_kind = 'SERVICE')"));
  assert.ok(membershipStep.sql.includes('FOREIGN KEY (principal_kind, principal_id)'));
  const adminAuditStep = IDENTITY_MIGRATION.steps.find((step) => step.id === 'create-identity-admin-audit');
  assert.ok(adminAuditStep && 'sql' in adminAuditStep);
  assert.ok(adminAuditStep.sql.includes('uq_ca_meta_identity_admin_idem'));
  assert.ok(adminAuditStep.sql.includes('request_hash'));
  assert.ok(IDENTITY_MIGRATION.steps.some((step) => step.id === 'identity-admin-audit-no-update'));
  assert.ok(IDENTITY_MIGRATION.steps.some((step) => step.id === 'identity-admin-audit-no-delete'));
  assert.equal(PORTAL_SESSIONS_MIGRATION.schemaVersion, 5);
  const portalSessionsChecksum = process.platform === 'win32'
    ? '59d87f7c8fef2205f0093805e746d5fd222521f95a015ba30ff993449e420e5e'
    : 'e5b0bee0aad9daa3b8be19214d643ab5d7ceabaf7787227168316b819afec00d';
  assert.equal(PORTAL_SESSIONS_MIGRATION.checksum, portalSessionsChecksum);
  assert.deepEqual(PORTAL_SESSIONS_MIGRATION.steps.map((step) => step.id), [
    'create-portal-pre-auth', 'create-portal-sessions', 'create-portal-ticket-jtis', 'create-abuse-limit-buckets',
  ]);
  const sessionStep = PORTAL_SESSIONS_MIGRATION.steps.find((step) => step.id === 'create-portal-sessions');
  assert.ok(sessionStep && 'sql' in sessionStep);
  assert.ok(sessionStep.sql.includes('secret_hash'));
  assert.ok(sessionStep.sql.includes('csrf_token_hash'));
  assert.ok(sessionStep.sql.includes('idle_expires_at'));
  assert.ok(sessionStep.sql.includes('absolute_expires_at'));
  const ticketStep = PORTAL_SESSIONS_MIGRATION.steps.find((step) => step.id === 'create-portal-ticket-jtis');
  assert.ok(ticketStep && 'sql' in ticketStep && ticketStep.sql.includes('PRIMARY KEY (issuer, jti_hash)'));
  assert.equal(TICKET_RETRY_MIGRATION.id, '202610300004-exact-ticket-retry-binding');
  assert.equal(TICKET_RETRY_MIGRATION.schemaVersion, 6);
  assert.deepEqual(TICKET_RETRY_MIGRATION.steps.map((step) => step.id), ['add-exact-portal-ticket-hash']);
  const ticketHashStep = TICKET_RETRY_MIGRATION.steps[0];
  assert.ok(ticketHashStep && 'sql' in ticketHashStep);
  assert.deepEqual(ticketHashStep.compatiblePriorSteps?.map(({ migrationId, stepId }) => ({ migrationId, stepId })), [{
    migrationId: PORTAL_SESSIONS_MIGRATION.id,
    stepId: 'create-portal-ticket-jtis',
  }]);
  assert.ok(ticketHashStep.sql.includes('ticket_sha256 CHAR(64)'));
  assert.ok(ticketHashStep.sql.includes('NULL'));
  assert.ok(ticketHashStep.definition.includes('store only SHA-256'));
  const entryModeStep = PORTAL_SESSION_ENTRY_MODE_MIGRATION.steps[0];
  assert.ok(entryModeStep && 'sql' in entryModeStep);
  assert.match(entryModeStep.sql, /entry_mode ENUM\('PORTAL_TOP_LEVEL','SUITE4_EMBED'\) NOT NULL DEFAULT 'PORTAL_TOP_LEVEL'/);
  assert.match(entryModeStep.definition, /PORTAL_TOP_LEVEL/);
});

test('M3.05 entry-mode migration accepts only the additive column shape and preserves legacy default', async () => {
  const step = PORTAL_SESSION_ENTRY_MODE_MIGRATION.steps[0];
  assert.ok(step && 'verify' in step);
  const validQueryRunner = {
    async query() {
      return [{
        data_type: 'enum',
        column_type: "enum('PORTAL_TOP_LEVEL','SUITE4_EMBED')",
        is_nullable: 'NO',
        column_default: 'PORTAL_TOP_LEVEL',
      }];
    },
  } as never;
  const invalidQueryRunner = {
    async query() {
      return [{
        data_type: 'enum',
        column_type: "enum('PORTAL_TOP_LEVEL','SUITE4_EMBED')",
        is_nullable: 'YES',
        column_default: null,
      }];
    },
  } as never;
  const missingQueryRunner = { async query() { return []; } } as never;
  const context = { migrationId: PORTAL_SESSION_ENTRY_MODE_MIGRATION.id, stepId: step.id };
  assert.equal(await step.verify({ ...context, queryRunner: validQueryRunner }), true);
  assert.equal(await step.verify({ ...context, queryRunner: missingQueryRunner }), false);
  await assert.rejects(step.verify({ ...context, queryRunner: invalidQueryRunner }), /unexpected portal session entry-mode column/);
});

test('M3.05 onboarding migration persists only scoped hashes and one-use status metadata', () => {
  const step = ONBOARDING_SESSIONS_MIGRATION.steps[0];
  assert.ok(step && 'sql' in step);
  assert.equal(step.phase, 'expand');
  assert.match(step.sql, /UNIQUE KEY uq_ca_meta_onboarding_idempotency \(tenant_id, idempotency_key_hash\)/);
  assert.match(step.sql, /UNIQUE KEY uq_ca_meta_onboarding_provider_state \(provider_state_hash\)/);
  assert.match(step.sql, /portal_session_id CHAR\(36\)/);
  assert.match(step.sql, /tenant_context_hash CHAR\(64\)/);
  assert.match(step.sql, /provider_state_consumed_at DATETIME\(6\) NULL/);
  assert.match(step.sql, /expires_at > created_at/);
  assert.match(step.definition, /provider state, idempotency key and request body are represented only by SHA-256 digests/);
  assert.match(step.definition, /authorization code is never persisted/);
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
  assert.notEqual(
    migrationStepChecksum(ddl('{"columns":["id"]}', verifyPresent)),
    migrationStepChecksum({
      ...ddl('{"columns":["id"]}', verifyPresent),
      compatiblePriorSteps: [{ migrationId: 'prior-migration', stepId: 'prior-step', verify: verifyMissing }],
    }),
  );

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
