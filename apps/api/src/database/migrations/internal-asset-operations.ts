import type { QueryRunner } from 'typeorm';
import { migrationChecksum } from './migration-fingerprint.js';
import { assertExpectedColumns, tableExists } from './schema-inspection.js';
import type { DdlStep, VersionedMigration } from './migration.types.js';

const columns = [
  'id', 'tenant_id', 'service_principal_id', 'asset_id', 'operation', 'idempotency_key_hash',
  'request_hash', 'status', 'safe_reason_code', 'provider_reference_hash', 'created_at', 'updated_at',
] as const;

async function verifyIndexes(queryRunner: QueryRunner): Promise<void> {
  const rows = await queryRunner.query(
    `SELECT index_name AS name, column_name, non_unique FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'ca_meta_internal_asset_operations'
     ORDER BY index_name, seq_in_index`,
  ) as Array<{ name: string; column_name: string; non_unique: number | string }>;
  const indexes = new Map<string, { readonly unique: boolean; readonly columns: string[] }>();
  for (const row of rows) {
    const found = indexes.get(row.name) ?? { unique: Number(row.non_unique) === 0, columns: [] };
    found.columns.push(row.column_name);
    indexes.set(row.name, found);
  }
  const expected = new Map([
    ['PRIMARY', { columns: ['id'], unique: true }],
    ['uq_ca_meta_internal_asset_operation_idem', { columns: ['tenant_id', 'service_principal_id', 'asset_id', 'operation', 'idempotency_key_hash'], unique: true }],
    ['ix_ca_meta_internal_asset_operation_status', { columns: ['status', 'updated_at'], unique: false }],
    ['ix_ca_meta_internal_asset_operation_principal', { columns: ['service_principal_id'], unique: false }],
    ['ix_ca_meta_internal_asset_operation_asset', { columns: ['tenant_id', 'asset_id'], unique: false }],
  ]);
  if (indexes.size !== expected.size || [...expected].some(([name, cols]) => {
    const found = indexes.get(name);
    return !found || found.columns.join('\0') !== cols.columns.join('\0') || found.unique !== cols.unique;
  })) throw new Error('Migration found an incompatible internal operation index.');
}

const operationLedger: DdlStep = {
  id: 'create-internal-asset-operation-ledger',
  phase: 'expand',
  sql: `CREATE TABLE IF NOT EXISTS ca_meta_internal_asset_operations (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    service_principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    operation VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    safe_reason_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    provider_reference_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_internal_asset_operation_idem (tenant_id, service_principal_id, asset_id, operation, idempotency_key_hash),
    KEY ix_ca_meta_internal_asset_operation_status (status, updated_at),
    KEY ix_ca_meta_internal_asset_operation_principal (service_principal_id),
    KEY ix_ca_meta_internal_asset_operation_asset (tenant_id, asset_id),
    CONSTRAINT ck_ca_meta_internal_asset_operation_kind CHECK (operation IN ('SEND_MESSAGE', 'MANAGE_TEMPLATES', 'MANAGE_COMMENTS', 'READ_STATUS', 'SUBSCRIBE_WEBHOOKS')),
    CONSTRAINT ck_ca_meta_internal_asset_operation_state CHECK (status IN ('UNKNOWN', 'SUCCEEDED', 'FAILED')),
    CONSTRAINT fk_ca_meta_internal_asset_operation_tenant FOREIGN KEY (tenant_id)
      REFERENCES ca_meta_tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_internal_asset_operation_principal FOREIGN KEY (service_principal_id)
      REFERENCES ca_meta_principals (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_internal_asset_operation_asset FOREIGN KEY (tenant_id, asset_id)
      REFERENCES ca_meta_assets (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  definitionVersion: 'v1',
  definition: JSON.stringify({ table: 'ca_meta_internal_asset_operations', columns,
    indexes: ['PRIMARY(id)', 'UNIQUE(tenant_id,service_principal_id,asset_id,operation,idempotency_key_hash)',
      'status,updated_at', 'service_principal_id', '(tenant_id,asset_id)'],
    checks: ['operation allowlist', 'UNKNOWN|SUCCEEDED|FAILED'],
    foreignKeys: ['tenant', 'service principal', '(tenant,asset)'],
    verifier: [assertExpectedColumns.toString(), verifyIndexes.toString(), tableExists.toString()] }),
  retryWhenAbsent: true,
  verify: async ({ queryRunner }) => {
    if (!(await tableExists(queryRunner, 'ca_meta_internal_asset_operations'))) return false;
    await assertExpectedColumns(queryRunner, 'ca_meta_internal_asset_operations', columns);
    await verifyIndexes(queryRunner);
    return true;
  },
};

const definition = {
  id: '202611110021-internal-asset-operations',
  schemaVersion: 21,
  minimumSupportedApiVersion: 1,
  steps: [operationLedger],
} as const;

export const INTERNAL_ASSET_OPERATIONS_MIGRATION: VersionedMigration = {
  ...definition,
  checksum: migrationChecksum(definition),
};

export const INTERNAL_ASSET_OPERATION_TABLES = ['ca_meta_internal_asset_operations'] as const;
