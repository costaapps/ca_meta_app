import { migrationChecksum } from './migration-fingerprint.js';
import { assertExpectedColumns, tableExists } from './schema-inspection.js';
import type { DdlStep, VersionedMigration } from './migration.types.js';

const identityEventsTable = 'ca_meta_magic_link_identity_events';
const identityEventColumns = [
  'id', 'event_type', 'proof_ref_hash', 'email_hash', 'principal_id', 'actor_kind', 'actor_ref_hash', 'reason_code', 'created_at',
] as const;

const createIdentityEvents: DdlStep = {
  id: 'create-magic-link-identity-events',
  phase: 'expand',
  sql: `CREATE TABLE IF NOT EXISTS ${identityEventsTable} (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    event_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    proof_ref_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    email_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    actor_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    actor_ref_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    reason_code VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_magic_identity_proof (proof_ref_hash),
    KEY ix_ca_meta_magic_identity_events_target (email_hash, principal_id, created_at),
    CONSTRAINT ck_ca_meta_magic_identity_event_type CHECK (event_type IN ('ASSOCIATED', 'REVOKED')),
    CONSTRAINT ck_ca_meta_magic_identity_event_proof CHECK (
      (event_type = 'ASSOCIATED' AND proof_ref_hash IS NOT NULL AND actor_kind = 'EMAIL_PROOF_VERIFIER'
        AND actor_ref_hash IS NULL AND reason_code = 'VERIFIED_EMAIL')
      OR (event_type = 'REVOKED' AND proof_ref_hash IS NULL AND actor_kind = 'PLATFORM_IDENTITY_ADMIN'
        AND actor_ref_hash IS NOT NULL AND reason_code IN ('IDENTITY_CORRECTION', 'COMPROMISE_REPORTED'))
    ),
    CONSTRAINT fk_ca_meta_magic_identity_event_principal FOREIGN KEY (principal_id) REFERENCES ca_meta_principals (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  definitionVersion: 'v1',
  definition: JSON.stringify({
    table: identityEventsTable,
    columns: identityEventColumns,
    uniqueProofIndex: ['uq_ca_meta_magic_identity_proof', 'proof_ref_hash'],
    principalForeignKey: ['fk_ca_meta_magic_identity_event_principal', 'principal_id', 'ca_meta_principals', 'id'],
    checks: ['ck_ca_meta_magic_identity_event_type', 'ck_ca_meta_magic_identity_event_proof'],
    appendOnly: true,
    actorKinds: ['EMAIL_PROOF_VERIFIER', 'PLATFORM_IDENTITY_ADMIN'],
    reasonCodes: ['VERIFIED_EMAIL', 'IDENTITY_CORRECTION', 'COMPROMISE_REPORTED'],
  }),
  retryWhenAbsent: true,
  verify: async ({ queryRunner }) => {
    if (!(await tableExists(queryRunner, identityEventsTable))) return false;
    await assertExpectedColumns(queryRunner, identityEventsTable, identityEventColumns);
    const rows = await queryRunner.query(
      `SELECT index_name AS name, column_name AS column_name, non_unique AS non_unique
       FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ? AND index_name = 'uq_ca_meta_magic_identity_proof'
       ORDER BY seq_in_index`, [identityEventsTable],
    ) as Array<{ name: string; column_name: string; non_unique: number | string }>;
    if (rows.length !== 1 || rows[0]?.column_name !== 'proof_ref_hash' || Number(rows[0]?.non_unique) !== 0) {
      throw new Error('Magic-link identity ledger has an unexpected proof replay index.');
    }
    const foreignKeys = await queryRunner.query(
      `SELECT constraint_name AS name, column_name AS column_name,
              referenced_table_name AS referenced_table, referenced_column_name AS referenced_column
       FROM information_schema.key_column_usage
       WHERE table_schema = DATABASE() AND table_name = ?
         AND constraint_name = 'fk_ca_meta_magic_identity_event_principal'`, [identityEventsTable],
    ) as Array<{ name: string; column_name: string; referenced_table: string; referenced_column: string }>;
    if (foreignKeys.length !== 1 || foreignKeys[0]?.column_name !== 'principal_id' ||
      foreignKeys[0]?.referenced_table !== 'ca_meta_principals' || foreignKeys[0]?.referenced_column !== 'id') {
      throw new Error('Magic-link identity ledger has an unexpected principal foreign key.');
    }
    const checks = await queryRunner.query(
      `SELECT constraint_name AS name FROM information_schema.table_constraints
       WHERE constraint_schema = DATABASE() AND table_name = ? AND constraint_type = 'CHECK'`, [identityEventsTable],
    ) as Array<{ name: string }>;
    const checkNames = new Set(checks.map((check) => check.name));
    if (!['ck_ca_meta_magic_identity_event_type', 'ck_ca_meta_magic_identity_event_proof'].every((name) => checkNames.has(name))) {
      throw new Error('Magic-link identity ledger has an unexpected event constraint.');
    }
    return true;
  },
};

function appendOnlyTrigger(id: string, event: 'UPDATE' | 'DELETE'): DdlStep {
  const name = `tr_ca_meta_magic_identity_events_no_${event.toLowerCase()}`;
  const statement = "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'magic-link identity events are append-only'";
  const normalize = (value: string) => value.toUpperCase().replace(/[\s`]+/g, '');
  return {
    id,
    phase: 'expand',
    sql: `CREATE TRIGGER ${name} BEFORE ${event} ON ${identityEventsTable} FOR EACH ROW ${statement}`,
    definitionVersion: 'v1',
    definition: JSON.stringify({ name, table: identityEventsTable, event, statement }),
    retryWhenAbsent: true,
    verify: async ({ queryRunner }) => {
      const rows = await queryRunner.query(
        `SELECT action_timing, event_manipulation, event_object_table, action_statement
         FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name = ?`, [name],
      ) as Array<{ action_timing: string; event_manipulation: string; event_object_table: string; action_statement: string }>;
      if (rows.length === 0) return false;
      const row = rows[0];
      if (!row || row.action_timing !== 'BEFORE' || row.event_manipulation !== event ||
        row.event_object_table !== identityEventsTable || normalize(row.action_statement) !== normalize(statement)) {
        throw new Error(`Magic-link identity ledger found an unexpected append-only trigger (${name}).`);
      }
      return true;
    },
  };
}

const identityEventsNoUpdate = appendOnlyTrigger('magic-link-identity-events-no-update', 'UPDATE');
const identityEventsNoDelete = appendOnlyTrigger('magic-link-identity-events-no-delete', 'DELETE');

const migrationDefinition = {
  id: '202611030014-magic-link-identity-ledger',
  schemaVersion: 14,
  minimumSupportedApiVersion: 1,
  steps: [createIdentityEvents, identityEventsNoUpdate, identityEventsNoDelete],
};

export const MAGIC_LINK_IDENTITY_LEDGER_MIGRATION: VersionedMigration = {
  ...migrationDefinition,
  checksum: migrationChecksum(migrationDefinition),
};

export const MAGIC_LINK_IDENTITY_LEDGER_TABLES = [identityEventsTable] as const;
