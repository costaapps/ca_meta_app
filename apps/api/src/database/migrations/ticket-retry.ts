import type { QueryRunner } from 'typeorm';
import { migrationChecksum } from './migration-fingerprint.js';
import { verifyPortalTicketJtiTableShape } from './portal-sessions.js';
import type { DdlStep, VersionedMigration } from './migration.types.js';

async function verifyTicketHashColumn(queryRunner: QueryRunner): Promise<boolean> {
  const rows = await queryRunner.query(
    `SELECT data_type, character_maximum_length, is_nullable, character_set_name, collation_name
     FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'ca_meta_portal_ticket_jtis' AND column_name = 'ticket_sha256'`,
  ) as Array<{
    data_type: string;
    character_maximum_length: number | string | null;
    is_nullable: string;
    character_set_name: string | null;
    collation_name: string | null;
  }>;
  const row = rows[0];
  if (!row) return false;
  if (row.data_type !== 'char' || Number(row.character_maximum_length) !== 64 || row.is_nullable !== 'YES' ||
    row.character_set_name !== 'ascii' || row.collation_name !== 'ascii_bin') {
    throw new Error('Migration preflight found an unexpected portal ticket hash column.');
  }
  return true;
}

async function verifyCurrentTicketJtiTable({ queryRunner }: import('./migration.types.js').MigrationStepContext): Promise<boolean> {
  if (!(await verifyTicketHashColumn(queryRunner))) return false;
  return verifyPortalTicketJtiTableShape(queryRunner, 'v6');
}

const compatiblePriorSteps: NonNullable<DdlStep['compatiblePriorSteps']> = [{
  migrationId: '202610300002-portal-sessions-and-abuse-limits',
  stepId: 'create-portal-ticket-jtis',
  verify: verifyCurrentTicketJtiTable,
}];

const addTicketHash: DdlStep = {
  id: 'add-exact-portal-ticket-hash',
  phase: 'expand',
  sql: 'ALTER TABLE ca_meta_portal_ticket_jtis ADD COLUMN ticket_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER jti_hash',
  definitionVersion: 'v1',
  definition: JSON.stringify({
    table: 'ca_meta_portal_ticket_jtis',
    column: { name: 'ticket_sha256', type: 'CHAR(64)', charset: 'ascii', collation: 'ascii_bin', nullable: true },
    purpose: 'exact compact ticket recovery binding; store only SHA-256',
    legacyRows: 'NULL digest is non-recoverable and must be denied',
    compatiblePriorSteps: compatiblePriorSteps.map(({ migrationId, stepId, verify }) => ({
      migrationId, stepId, verify: verify.toString(),
    })),
  }),
  retryWhenAbsent: true,
  verify: verifyCurrentTicketJtiTable,
  compatiblePriorSteps,
};

const definition = {
  id: '202610300004-exact-ticket-retry-binding',
  schemaVersion: 6,
  minimumSupportedApiVersion: 1,
  steps: [addTicketHash],
} as const;

export const TICKET_RETRY_MIGRATION: VersionedMigration = {
  ...definition,
  checksum: migrationChecksum(definition),
};
