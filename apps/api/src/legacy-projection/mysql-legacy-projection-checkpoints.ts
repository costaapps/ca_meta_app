import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { LegacyProjectionCheckpoint, LegacyProjectionCheckpointStore } from './legacy-projection.types.js';
import { LegacyProjectionError } from './legacy-projection.types.js';

interface CheckpointRow {
  tenant_id: string; destination_key_hash: string; central_ref: string; source_version: number | string;
  projection_schema_version: number | string; content_hash: string; tombstone: number | string;
  state: LegacyProjectionCheckpoint['state']; safe_error_code: string | null;
}

function fromRow(row: CheckpointRow | undefined): LegacyProjectionCheckpoint | undefined {
  if (!row) return undefined;
  const sourceVersion = Number(row.source_version);
  const projectionSchemaVersion = Number(row.projection_schema_version);
  if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1 ||
      !Number.isSafeInteger(projectionSchemaVersion) || projectionSchemaVersion < 1) {
    throw new Error('Stored projection checkpoint version is invalid.');
  }
  return Object.freeze({
    tenantId: row.tenant_id, destinationKeyHash: row.destination_key_hash, centralRef: row.central_ref,
    sourceVersion, projectionSchemaVersion, contentHash: row.content_hash, tombstone: Number(row.tombstone) === 1,
    state: row.state, safeErrorCode: row.safe_error_code,
  });
}

/** Central checkpoint writes are separate from destination commits; retries repeat the idempotent target upsert. */
export class MysqlLegacyProjectionCheckpointStore implements LegacyProjectionCheckpointStore {
  constructor(private readonly database: DurableWorkDatabase) {}

  async read(tenantId: string, destinationKeyHash: string, centralRef: string): Promise<LegacyProjectionCheckpoint | undefined> {
    const source = await this.database.getDataSource();
    const rows = await source.query(
      `SELECT tenant_id, destination_key_hash, central_ref, source_version, projection_schema_version,
              content_hash, tombstone, state, safe_error_code
       FROM ca_meta_legacy_projection_checkpoints
       WHERE tenant_id = ? AND destination_key_hash = ? AND central_ref = ? LIMIT 1`,
      [tenantId, destinationKeyHash, centralRef],
    ) as CheckpointRow[];
    return fromRow(rows[0]);
  }

  async listByDestination(tenantId: string, destinationKeyHash: string): Promise<readonly LegacyProjectionCheckpoint[]> {
    const source = await this.database.getDataSource();
    const rows = await source.query(
      `SELECT tenant_id, destination_key_hash, central_ref, source_version, projection_schema_version,
              content_hash, tombstone, state, safe_error_code
       FROM ca_meta_legacy_projection_checkpoints
       WHERE tenant_id = ? AND destination_key_hash = ? ORDER BY central_ref`,
      [tenantId, destinationKeyHash],
    ) as CheckpointRow[];
    return Object.freeze(rows.map((row) => fromRow(row)!).filter(Boolean));
  }

  async record(checkpoint: LegacyProjectionCheckpoint): Promise<void> {
    const source = await this.database.getDataSource();
    await source.transaction(async (manager) => {
      await manager.query(
        `INSERT IGNORE INTO ca_meta_legacy_projection_checkpoints
         (tenant_id, destination_key_hash, central_ref, source_version, projection_schema_version,
          content_hash, tombstone, state, safe_error_code, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
        [checkpoint.tenantId, checkpoint.destinationKeyHash, checkpoint.centralRef, checkpoint.sourceVersion,
          checkpoint.projectionSchemaVersion, checkpoint.contentHash, checkpoint.tombstone ? 1 : 0,
          checkpoint.state, checkpoint.safeErrorCode],
      );
      const rows = await manager.query(
        `SELECT tenant_id, destination_key_hash, central_ref, source_version, projection_schema_version,
                content_hash, tombstone, state, safe_error_code
         FROM ca_meta_legacy_projection_checkpoints
         WHERE tenant_id = ? AND destination_key_hash = ? AND central_ref = ? FOR UPDATE`,
        [checkpoint.tenantId, checkpoint.destinationKeyHash, checkpoint.centralRef],
      ) as CheckpointRow[];
      const current = fromRow(rows[0]);
      if (!current) throw new Error('Projection checkpoint could not be locked.');
      if (checkpoint.sourceVersion < current.sourceVersion) return;
      if (checkpoint.sourceVersion === current.sourceVersion && checkpoint.contentHash !== current.contentHash) {
        throw new LegacyProjectionError('PROJECTION_VERSION_CONFLICT', 'Projection revision conflicts with different content.');
      }
      await manager.query(
        `UPDATE ca_meta_legacy_projection_checkpoints
         SET source_version = ?, projection_schema_version = ?, content_hash = ?, tombstone = ?, state = ?,
             safe_error_code = ?, updated_at = UTC_TIMESTAMP(6)
         WHERE tenant_id = ? AND destination_key_hash = ? AND central_ref = ? AND source_version = ? AND content_hash = ?`,
        [checkpoint.sourceVersion, checkpoint.projectionSchemaVersion, checkpoint.contentHash, checkpoint.tombstone ? 1 : 0,
          checkpoint.state, checkpoint.safeErrorCode,
          checkpoint.tenantId, checkpoint.destinationKeyHash, checkpoint.centralRef, current.sourceVersion, current.contentHash],
      );
    });
  }
}
