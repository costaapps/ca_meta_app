import type { DdlStep, VersionedMigration } from './migration.types.js';
import { migrationChecksum } from './migration-fingerprint.js';
import { assertExpectedColumns, tableExists } from './schema-inspection.js';

const checkpointStep: DdlStep = {
  id: 'create-legacy-projection-checkpoints',
  phase: 'expand',
  sql: `CREATE TABLE IF NOT EXISTS ca_meta_legacy_projection_checkpoints (
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    destination_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    central_ref VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    source_version BIGINT UNSIGNED NOT NULL,
    projection_schema_version SMALLINT UNSIGNED NOT NULL,
    content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tombstone TINYINT(1) NOT NULL DEFAULT 0,
    state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    safe_error_code VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (tenant_id, destination_key_hash, central_ref),
    KEY ix_ca_meta_projection_state_updated (tenant_id, state, updated_at),
    CONSTRAINT ck_ca_meta_projection_state CHECK (state IN ('PENDING', 'SYNCED', 'FAILED')),
    CONSTRAINT ck_ca_meta_projection_tombstone CHECK (tombstone IN (0, 1)),
    CONSTRAINT fk_ca_meta_projection_tenant FOREIGN KEY (tenant_id) REFERENCES ca_meta_tenants (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  definitionVersion: 'v1',
  definition: JSON.stringify({
    table: 'ca_meta_legacy_projection_checkpoints',
    columns: ['tenant_id', 'destination_key_hash', 'central_ref', 'source_version', 'projection_schema_version',
      'content_hash', 'tombstone', 'state', 'safe_error_code', 'updated_at'],
    primaryKey: ['tenant_id', 'destination_key_hash', 'central_ref'],
    index: ['tenant_id', 'state', 'updated_at'],
    verify: [assertExpectedColumns.toString(), tableExists.toString()],
  }),
  retryWhenAbsent: true,
  verify: async ({ queryRunner }) => {
    const table = 'ca_meta_legacy_projection_checkpoints';
    if (!(await tableExists(queryRunner, table))) return false;
    return assertExpectedColumns(queryRunner, table, [
      'tenant_id', 'destination_key_hash', 'central_ref', 'source_version', 'projection_schema_version',
      'content_hash', 'tombstone', 'state', 'safe_error_code', 'updated_at',
    ]);
  },
};

const definition = {
  id: '202611120025-legacy-projection-checkpoints',
  schemaVersion: 25,
  minimumSupportedApiVersion: 1,
  steps: [checkpointStep],
} as const;

export const LEGACY_PROJECTION_MIGRATION: VersionedMigration = {
  ...definition,
  checksum: migrationChecksum(definition),
};

export const LEGACY_PROJECTION_TABLES = ['ca_meta_legacy_projection_checkpoints'] as const;
