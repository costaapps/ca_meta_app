import { createHash } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';
import type { MigrationEnvironment } from './migration-environment.js';
import type { MigrationStep, MigrationStepContext, VersionedMigration } from './migration.types.js';
import { DOMAIN_TABLES, MIGRATIONS } from './migrations.js';
import { tableExists } from './schema-inspection.js';

export const MIGRATION_LEDGER = 'ca_meta_schema_migrations';
export const MIGRATION_STEP_LEDGER = 'ca_meta_migration_steps';

export interface MigrationRunHooks {
  readonly afterDdl?: (migrationId: string, stepId: string) => Promise<void> | void;
  readonly afterBackfillBatch?: (
    migrationId: string,
    stepId: string,
    nextCursor: string | null,
    done: boolean,
  ) => Promise<void> | void;
}

export interface MigrationStatus {
  readonly serverVersion: string;
  readonly database: string;
  readonly migrations: readonly { id: string; schemaVersion: number; state: string; checksumMatches: boolean }[];
}

const ledgerSql = [
  `CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER} (
    migration_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    schema_version INT UNSIGNED NOT NULL,
    checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    started_at DATETIME(6) NOT NULL,
    applied_at DATETIME(6) NULL,
    PRIMARY KEY (migration_id)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS ${MIGRATION_STEP_LEDGER} (
    migration_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    step_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    cursor_value VARCHAR(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    started_at DATETIME(6) NOT NULL,
    applied_at DATETIME(6) NULL,
    PRIMARY KEY (migration_id, step_id),
    CONSTRAINT fk_ca_meta_step_migration FOREIGN KEY (migration_id)
      REFERENCES ${MIGRATION_LEDGER} (migration_id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
];

export function migrationLockName(database: string): string {
  const suffix = createHash('sha256').update(database, 'utf8').digest('hex').slice(0, 40);
  return `ca_meta:migrate:${suffix}`;
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  if (error instanceof Error) return error.name;
  return 'UnknownError';
}

async function assertMariaDb(queryRunner: QueryRunner, environment: MigrationEnvironment): Promise<string> {
  const rows = await queryRunner.query(
    'SELECT VERSION() AS version, DATABASE() AS database_name, CURRENT_USER() AS db_user, @@session.time_zone AS session_time_zone',
  ) as Array<{ version: string; database_name: string; db_user: string; session_time_zone: string }>;
  const row = rows[0];
  if (!row || !row.version.includes('MariaDB')) throw new Error('Migration preflight requires MariaDB.');
  if (row.database_name !== environment.database.name) throw new Error('Migration preflight database mismatch.');
  if (!row.db_user || row.db_user.split('@', 1)[0] !== environment.database.user) {
    throw new Error('Migration preflight connected as an unexpected database user.');
  }
  return row.version;
}

async function assertMigrationGrants(queryRunner: QueryRunner, databaseName: string): Promise<void> {
  const rows = await queryRunner.query('SHOW GRANTS') as Array<Record<string, string>>;
  const grants = rows.flatMap((row) => Object.values(row)).filter((value) => typeof value === 'string');
  const privileges = new Set<string>();
  let hasDatabaseGrant = false;
  for (const grant of grants) {
    const normalized = grant.toUpperCase();
    if (/\bON\s+\*\.\*/.test(normalized) && !/\bGRANT\s+USAGE\b/.test(normalized)) {
      throw new Error('Migration preflight rejects global database privileges.');
    }
    if (/\bWITH\s+GRANT\s+OPTION\b/.test(normalized)) {
      throw new Error('Migration preflight rejects GRANT OPTION.');
    }
    const objectMatch = grant.match(/\bON\s+`?([^`\s]+)`?\.\*\s+TO\b/i);
    if (!objectMatch || objectMatch[1]?.toLowerCase() !== databaseName.toLowerCase()) continue;
    hasDatabaseGrant = true;
    const privilegeMatch = grant.match(/^\s*GRANT\s+(.+?)\s+ON\b/i);
    for (const privilege of (privilegeMatch?.[1] ?? '').split(',').map((item) => item.trim().toUpperCase())) {
      if (privilege) privileges.add(privilege);
    }
  }
  const required = ['SELECT', 'INSERT', 'UPDATE', 'CREATE', 'ALTER', 'INDEX', 'REFERENCES'];
  if (!hasDatabaseGrant || required.some((privilege) => !privileges.has(privilege))) {
    throw new Error('Migration preflight found insufficient database-scoped migration privileges.');
  }
}

async function ensureLedger(queryRunner: QueryRunner): Promise<void> {
  const hasMigrationLedger = await tableExists(queryRunner, MIGRATION_LEDGER);
  const hasStepLedger = await tableExists(queryRunner, MIGRATION_STEP_LEDGER);
  const hasDomainSchema = await Promise.all(DOMAIN_TABLES.map((table) => tableExists(queryRunner, table)));
  if (!hasMigrationLedger && !hasStepLedger && hasDomainSchema.some(Boolean)) {
    throw new Error('Migration preflight found domain tables without a migration ledger; refusing to adopt them.');
  }
  if (hasMigrationLedger && !hasStepLedger) {
    // The second ledger table is created independently because MariaDB DDL commits implicitly.
    for (const sql of ledgerSql) await queryRunner.query(sql);
  } else if (!hasMigrationLedger && hasStepLedger) {
    throw new Error('Migration preflight found a step ledger without its parent ledger.');
  } else if (!hasMigrationLedger && !hasStepLedger) {
    for (const sql of ledgerSql) await queryRunner.query(sql);
  }
  const expectedMigrationColumns = ['migration_id', 'schema_version', 'checksum', 'state', 'started_at', 'applied_at'];
  const expectedStepColumns = ['migration_id', 'step_id', 'checksum', 'state', 'cursor_value', 'started_at', 'applied_at'];
  const migrationColumns = await queryRunner.query(
    `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position`,
    [MIGRATION_LEDGER],
  ) as Array<{ name: string }>;
  const stepColumns = await queryRunner.query(
    `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position`,
    [MIGRATION_STEP_LEDGER],
  ) as Array<{ name: string }>;
  if (migrationColumns.map((row) => row.name).join(',') !== expectedMigrationColumns.join(',')) {
    throw new Error('Migration ledger has an unexpected schema.');
  }
  if (stepColumns.map((row) => row.name).join(',') !== expectedStepColumns.join(',')) {
    throw new Error('Migration step ledger has an unexpected schema.');
  }
}

async function assertKnownMigrationLedger(queryRunner: QueryRunner): Promise<void> {
  const rows = await queryRunner.query(
    `SELECT migration_id, schema_version, checksum FROM ${MIGRATION_LEDGER} ORDER BY schema_version`,
  ) as Array<{ migration_id: string | Buffer; schema_version: string | number; checksum: string | Buffer }>;
  for (const row of rows) {
    const migrationId = Buffer.isBuffer(row.migration_id) ? row.migration_id.toString('ascii') : String(row.migration_id);
    const checksum = Buffer.isBuffer(row.checksum) ? row.checksum.toString('ascii') : String(row.checksum);
    const migration = MIGRATIONS.find((candidate) => candidate.id === migrationId);
    if (!migration || migration.checksum !== checksum || migration.schemaVersion !== Number(row.schema_version)) {
      throw new Error(`Migration ledger contains an unknown migration or checksum: ${migrationId}.`);
    }
  }
}

function stepChecksum(step: MigrationStep): string {
  const value = 'sql' in step
    ? `${step.id}\n${step.phase}\n${step.sql}`
    : `${step.id}\n${step.phase}\n${step.checksum}`;
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function ensureMigrationRecord(
  queryRunner: QueryRunner,
  migration: VersionedMigration,
): Promise<void> {
  await queryRunner.query(
    `INSERT IGNORE INTO ${MIGRATION_LEDGER} (migration_id, schema_version, checksum, state, started_at)
     VALUES (?, ?, ?, 'RUNNING', UTC_TIMESTAMP(6))`,
    [migration.id, migration.schemaVersion, migration.checksum],
  );
  const rows = await queryRunner.query(
    `SELECT schema_version, checksum, state FROM ${MIGRATION_LEDGER} WHERE migration_id = ?`,
    [migration.id],
  ) as Array<{ schema_version: string | number; checksum: string; state: string }>;
  if (!rows[0] || rows[0].checksum !== migration.checksum || Number(rows[0].schema_version) !== migration.schemaVersion) {
    throw new Error(`Migration ${migration.id} checksum differs from the applied ledger.`);
  }
}

async function ensureStepRecord(
  queryRunner: QueryRunner,
  migrationId: string,
  step: MigrationStep,
): Promise<{ checksum: string; state: string; cursor_value: string | null }> {
  const checksum = stepChecksum(step);
  await queryRunner.query(
    `INSERT IGNORE INTO ${MIGRATION_STEP_LEDGER}
     (migration_id, step_id, checksum, state, started_at) VALUES (?, ?, ?, 'STARTED', UTC_TIMESTAMP(6))`,
    [migrationId, step.id, checksum],
  );
  const rows = await queryRunner.query(
    `SELECT checksum, state, cursor_value FROM ${MIGRATION_STEP_LEDGER} WHERE migration_id = ? AND step_id = ?`,
    [migrationId, step.id],
  ) as Array<{ checksum: string; state: string; cursor_value: string | null }>;
  if (!rows[0] || rows[0].checksum !== checksum) {
    throw new Error(`Migration step ${migrationId}/${step.id} checksum differs from the journal.`);
  }
  return rows[0];
}

async function markStepApplied(queryRunner: QueryRunner, migrationId: string, stepId: string): Promise<void> {
  await queryRunner.query(
    `UPDATE ${MIGRATION_STEP_LEDGER} SET state = 'APPLIED', applied_at = UTC_TIMESTAMP(6)
     WHERE migration_id = ? AND step_id = ? AND state = 'STARTED'`,
    [migrationId, stepId],
  );
}

async function runDdlStep(
  queryRunner: QueryRunner,
  migrationId: string,
  step: Extract<MigrationStep, { phase: 'expand' | 'switch' | 'contract' }>,
  hooks: MigrationRunHooks,
): Promise<void> {
  const record = await ensureStepRecord(queryRunner, migrationId, step);
  const context: MigrationStepContext = { queryRunner, migrationId, stepId: step.id };
  const valid = await step.verify(context);
  if (record.state === 'APPLIED') {
    if (!valid) throw new Error(`Applied migration step ${migrationId}/${step.id} no longer matches the database.`);
    return;
  }
  if (!valid) {
    if (!step.retryWhenAbsent) throw new Error(`Migration step ${migrationId}/${step.id} requires a forward-fix.`);
    await queryRunner.query(step.sql);
    await hooks.afterDdl?.(migrationId, step.id);
    if (!(await step.verify(context))) throw new Error(`Migration step ${migrationId}/${step.id} did not verify after DDL.`);
  }
  await markStepApplied(queryRunner, migrationId, step.id);
}

async function runBackfillStep(
  queryRunner: QueryRunner,
  migrationId: string,
  step: Extract<MigrationStep, { phase: 'backfill' }>,
  hooks: MigrationRunHooks,
): Promise<void> {
  let record = await ensureStepRecord(queryRunner, migrationId, step);
  if (record.state === 'APPLIED') return;
  const context: MigrationStepContext = { queryRunner, migrationId, stepId: step.id };
  while (true) {
    await queryRunner.startTransaction();
    try {
      const result = await step.runBatch(context, record.cursor_value, step.batchSize);
      await queryRunner.query(
        `UPDATE ${MIGRATION_STEP_LEDGER} SET cursor_value = ?, state = ?, applied_at = ?
         WHERE migration_id = ? AND step_id = ?`,
        [result.nextCursor, result.done ? 'APPLIED' : 'STARTED', result.done ? new Date() : null, migrationId, step.id],
      );
      await queryRunner.commitTransaction();
      await hooks.afterBackfillBatch?.(migrationId, step.id, result.nextCursor, result.done);
      if (result.done) return;
      record = await ensureStepRecord(queryRunner, migrationId, step);
    } catch (error) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw error;
    }
  }
}

async function runValidationStep(
  queryRunner: QueryRunner,
  migrationId: string,
  step: Extract<MigrationStep, { phase: 'validate' }>,
): Promise<void> {
  const record = await ensureStepRecord(queryRunner, migrationId, step);
  if (record.state === 'APPLIED') return;
  await step.validate({ queryRunner, migrationId, stepId: step.id });
  await markStepApplied(queryRunner, migrationId, step.id);
}

async function runMigration(
  queryRunner: QueryRunner,
  migration: VersionedMigration,
  hooks: MigrationRunHooks,
): Promise<void> {
  await ensureMigrationRecord(queryRunner, migration);
  for (const step of migration.steps) {
    if ('sql' in step) {
      await runDdlStep(queryRunner, migration.id, step, hooks);
    } else if ('runBatch' in step) {
      await runBackfillStep(queryRunner, migration.id, step, hooks);
    } else {
      await runValidationStep(queryRunner, migration.id, step);
    }
  }
  await queryRunner.query(
    `UPDATE ${MIGRATION_LEDGER} SET state = 'APPLIED', applied_at = UTC_TIMESTAMP(6)
     WHERE migration_id = ? AND checksum = ?`,
    [migration.id, migration.checksum],
  );
}

function dataSourceOptions(environment: MigrationEnvironment) {
  return {
    type: 'mariadb' as const,
    host: environment.database.host,
    port: environment.database.port,
    username: environment.database.user,
    password: environment.database.password,
    database: environment.database.name,
    timezone: 'Z' as const,
    supportBigNumbers: true,
    bigNumberStrings: true,
    connectTimeout: environment.database.connectTimeoutMs,
    synchronize: false,
    migrationsRun: false,
    migrationsTransactionMode: 'none' as const,
    logging: false,
    extra: { connectionLimit: 1 },
  };
}

export async function deployMigrations(
  environment: MigrationEnvironment,
  migrations: readonly VersionedMigration[] = MIGRATIONS,
  hooks: MigrationRunHooks = {},
): Promise<void> {
  const dataSource = new DataSource(dataSourceOptions(environment));
  let queryRunner: QueryRunner | undefined;
  let acquiredLock = false;
  const name = migrationLockName(environment.database.name);
  try {
    await dataSource.initialize();
    queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await assertMariaDb(queryRunner, environment);
    await queryRunner.query("SET SESSION time_zone = '+00:00'");
    await queryRunner.query("SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@session.sql_mode, ''), 'STRICT_ALL_TABLES')");
    await queryRunner.query(`SET SESSION max_statement_time = ${environment.statementTimeoutSeconds}`);
    const lockRows = await queryRunner.query('SELECT GET_LOCK(?, ?) AS acquired', [name, environment.lockTimeoutSeconds]) as Array<{ acquired: number | null }>;
    if (Number(lockRows[0]?.acquired) !== 1) throw new Error('Migration lock acquisition timed out or failed.');
    acquiredLock = true;
    await assertMigrationGrants(queryRunner, environment.database.name);
    await ensureLedger(queryRunner);
    await assertKnownMigrationLedger(queryRunner);
    for (const migration of migrations) {
      if (migration.minimumSupportedApiVersion > environment.minimumSupportedApiVersion) {
        throw new Error(`Migration ${migration.id} requires API baseline ${migration.minimumSupportedApiVersion}.`);
      }
      await runMigration(queryRunner, migration, hooks);
    }
  } finally {
    if (queryRunner) {
      if (acquiredLock) {
        try { await queryRunner.query('SELECT RELEASE_LOCK(?)', [name]); } catch {}
      }
      await queryRunner.release();
    }
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

export async function readMigrationStatus(environment: MigrationEnvironment): Promise<MigrationStatus> {
  const dataSource = new DataSource(dataSourceOptions(environment));
  try {
    await dataSource.initialize();
    const queryRunner = dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      const rows = await queryRunner.query(
        'SELECT VERSION() AS version, DATABASE() AS database_name',
      ) as Array<{ version: string; database_name: string }>;
      const serverVersion = rows[0]?.version ?? 'unknown';
      if (!serverVersion.includes('MariaDB')) throw new Error('Migration preflight requires MariaDB.');
      if (rows[0]?.database_name !== environment.database.name) throw new Error('Migration preflight database mismatch.');
      if (!(await tableExists(queryRunner, MIGRATION_LEDGER))) {
        return { serverVersion, database: environment.database.name, migrations: [] };
      }
      const applied = await queryRunner.query(
        `SELECT migration_id, schema_version, checksum, state FROM ${MIGRATION_LEDGER} ORDER BY schema_version`,
      ) as Array<{ migration_id: string; schema_version: string | number; checksum: string; state: string }>;
      const known = new Map(MIGRATIONS.map((migration) => [migration.id, migration]));
      return {
        serverVersion,
        database: environment.database.name,
        migrations: applied.map((row) => ({
          id: row.migration_id,
          schemaVersion: Number(row.schema_version),
          state: row.state,
          checksumMatches: known.get(row.migration_id)?.checksum === row.checksum &&
            known.get(row.migration_id)?.schemaVersion === Number(row.schema_version),
        })),
      };
    } finally {
      await queryRunner.release();
    }
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

export function safeMigrationError(error: unknown): string {
  return `Migration operation failed (${errorCode(error)}).`;
}
