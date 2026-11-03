import type { QueryRunner } from 'typeorm';
import { migrationChecksum } from './migration-fingerprint.js';
import type { DdlStep, VersionedMigration } from './migration.types.js';

const expectedColumnType = "enum('PORTAL_TOP_LEVEL','SUITE4_EMBED')";
const expectedColumnDefault = "'PORTAL_TOP_LEVEL'";

async function verifyEntryModeColumn(queryRunner: QueryRunner): Promise<boolean> {
  const rows = await queryRunner.query(
    `SELECT data_type, column_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'ca_meta_portal_sessions' AND column_name = 'entry_mode'`,
  ) as Array<{
    data_type: string;
    column_type: string;
    is_nullable: string;
    column_default: string | null;
  }>;
  const row = rows[0];
  if (!row) return false;
  if (row.data_type !== 'enum' || row.column_type !== expectedColumnType || row.is_nullable !== 'NO' ||
    row.column_default !== expectedColumnDefault) {
    throw new Error('Migration preflight found an unexpected portal session entry-mode column.');
  }
  return true;
}

const addEntryMode: DdlStep = {
  id: 'add-portal-session-entry-mode',
  phase: 'expand',
  sql: "ALTER TABLE ca_meta_portal_sessions ADD COLUMN entry_mode ENUM('PORTAL_TOP_LEVEL','SUITE4_EMBED') NOT NULL DEFAULT 'PORTAL_TOP_LEVEL' AFTER context_version",
  definitionVersion: 'v1',
  definition: JSON.stringify({
    table: 'ca_meta_portal_sessions',
    column: {
      name: 'entry_mode',
      type: expectedColumnType,
      nullable: false,
      default: 'PORTAL_TOP_LEVEL',
      purpose: 'persist the verified browser-bound pre-auth mode for context-cookie recovery',
    },
    verify: verifyEntryModeColumn.toString(),
  }),
  retryWhenAbsent: true,
  verify: async ({ queryRunner }) => verifyEntryModeColumn(queryRunner),
};

const definition = {
  id: '202610300009-portal-session-entry-mode',
  schemaVersion: 9,
  minimumSupportedApiVersion: 1,
  steps: [addEntryMode],
} as const;

export const PORTAL_SESSION_ENTRY_MODE_MIGRATION: VersionedMigration = {
  ...definition,
  checksum: migrationChecksum(definition),
};
