import { createHash } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { destinationKeyHash, projectionContentHash, validateProjectionRecord, validateProjectionTarget } from './legacy-projection.mapper.js';
import type {
  LegacyProjectionCheckpoint,
  LegacyProjectionDestination,
  LegacyProjectionRebuildResult,
  LegacyProjectionRecord,
  LegacyProjectionTargetKey,
} from './legacy-projection.types.js';
import { LegacyProjectionError } from './legacy-projection.types.js';

interface RebuildTargetRow {
  IdAsset: string; CentralAssetRef: string | null; ExternalId: string | null; DisplayName: string | null;
  AssetKind: string | null; ParentLegacyAssetRef: string | null; CapabilitiesJson: string | Buffer | unknown;
  ConfigVersion?: number | string | null; Status: string; ProjectionVersion: number | string;
  ProjectionSchemaVersion: number | string; ContentHash: string; IsDeleted: number | string;
}

const PROJECTOR_TABLES = ['MetaConnectedPages', 'MetaConnectedNumbers', 'MetaAssetAutomationConfigs'] as const;

function reportHash(entries: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([...entries].sort()), 'utf8').digest('hex');
}

function parseCapabilities(value: unknown): readonly string[] {
  const parsed = Buffer.isBuffer(value) ? JSON.parse(value.toString('utf8')) as unknown :
    typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed) || !parsed.every((capability) => typeof capability === 'string')) {
    throw new LegacyProjectionError('REBUILD_ROW_INVALID', 'Owned destination row has invalid capability metadata.');
  }
  return parsed;
}

function tombstoneFromRow(table: typeof PROJECTOR_TABLES[number], row: RebuildTargetRow, version: number): LegacyProjectionRecord {
  if (!row.CentralAssetRef || !row.IdAsset || !Number.isSafeInteger(version) || version < 1) {
    throw new LegacyProjectionError('REBUILD_ROW_INVALID', 'Owned destination row cannot be reconstructed safely.');
  }
  if (table === 'MetaAssetAutomationConfigs') {
    const configVersion = Number(row.ConfigVersion);
    if (!Number.isSafeInteger(configVersion) || configVersion < 0) {
      throw new LegacyProjectionError('REBUILD_ROW_INVALID', 'Owned automation row has an invalid configuration version.');
    }
    return validateProjectionRecord({
      kind: 'AUTOMATION_CONFIG', centralRef: row.CentralAssetRef, legacyAssetRef: row.IdAsset,
      sourceVersion: version, status: 'REMOVED', externalId: null, displayName: null, assetKind: null,
      parentLegacyAssetRef: null, capabilities: Object.freeze([]), configVersion, tombstone: true,
    });
  }
  return validateProjectionRecord({
    kind: table === 'MetaConnectedPages' ? 'PAGE' : 'WHATSAPP_NUMBER',
    centralRef: row.CentralAssetRef, legacyAssetRef: row.IdAsset, sourceVersion: version, status: 'REMOVED',
    externalId: row.ExternalId ?? null, displayName: row.DisplayName ?? null, assetKind: row.AssetKind ?? null,
    parentLegacyAssetRef: row.ParentLegacyAssetRef ?? null, capabilities: parseCapabilities(row.CapabilitiesJson),
    configVersion: null, tombstone: true,
  });
}

function targetTable(record: LegacyProjectionRecord): 'MetaConnectedPages' | 'MetaConnectedNumbers' | 'MetaAssetAutomationConfigs' {
  if (record.kind === 'PAGE') return 'MetaConnectedPages';
  if (record.kind === 'WHATSAPP_NUMBER') return 'MetaConnectedNumbers';
  return 'MetaAssetAutomationConfigs';
}

function selectTargetRows(table: typeof PROJECTOR_TABLES[number], forUpdate: boolean, byAsset = false): string {
  const fields = table === 'MetaAssetAutomationConfigs'
    ? 'IdAsset, CentralAssetRef, ConfigVersion, Status, ProjectionVersion, ProjectionSchemaVersion, ContentHash, IsDeleted'
    : 'IdAsset, CentralAssetRef, ExternalId, DisplayName, AssetKind, ParentLegacyAssetRef, CapabilitiesJson, Status, ProjectionVersion, ProjectionSchemaVersion, ContentHash, IsDeleted';
  return `SELECT ${fields} FROM ${table} WHERE IdDatabase = ? AND IdCompany = ? AND Environment = ?${byAsset ? ' AND IdAsset = ?' : ''}${forUpdate ? ' FOR UPDATE' : ''}`;
}

function recordFromDestinationRow(table: typeof PROJECTOR_TABLES[number], row: RebuildTargetRow): LegacyProjectionRecord {
  const sourceVersion = Number(row.ProjectionVersion);
  const tombstone = Number(row.IsDeleted) === 1;
  if (table === 'MetaAssetAutomationConfigs') {
    return validateProjectionRecord({
      kind: 'AUTOMATION_CONFIG', centralRef: row.CentralAssetRef ?? '', legacyAssetRef: row.IdAsset,
      sourceVersion, status: row.Status as LegacyProjectionRecord['status'], externalId: null, displayName: null,
      assetKind: null, parentLegacyAssetRef: null, capabilities: Object.freeze([]),
      configVersion: row.ConfigVersion === null || row.ConfigVersion === undefined ? null : Number(row.ConfigVersion), tombstone,
    });
  }
  return validateProjectionRecord({
    kind: table === 'MetaConnectedPages' ? 'PAGE' : 'WHATSAPP_NUMBER',
    centralRef: row.CentralAssetRef ?? '', legacyAssetRef: row.IdAsset, sourceVersion,
    status: row.Status as LegacyProjectionRecord['status'], externalId: row.ExternalId ?? null,
    displayName: row.DisplayName ?? null, assetKind: row.AssetKind ?? null,
    parentLegacyAssetRef: row.ParentLegacyAssetRef ?? null, capabilities: parseCapabilities(row.CapabilitiesJson),
    configVersion: null, tombstone,
  });
}

function contentHashFromDestinationRow(table: typeof PROJECTOR_TABLES[number], row: RebuildTargetRow): string | undefined {
  try {
    return projectionContentHash(recordFromDestinationRow(table, row));
  } catch {
    return undefined;
  }
}

async function writeProjectionRecord(
  manager: EntityManager,
  target: LegacyProjectionTargetKey,
  record: LegacyProjectionRecord,
  projectionSchemaVersion: number,
): Promise<void> {
  const table = targetTable(record);
  const hash = projectionContentHash(record);
  if (record.kind === 'AUTOMATION_CONFIG') {
    await manager.query(
      `INSERT INTO MetaAssetAutomationConfigs
       (IdDatabase, IdCompany, Environment, IdAsset, CentralAssetRef, ConfigVersion, Status, ProjectionVersion,
        ProjectionSchemaVersion, ContentHash, IsDeleted, UpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))
       ON DUPLICATE KEY UPDATE CentralAssetRef = VALUES(CentralAssetRef), ConfigVersion = VALUES(ConfigVersion),
         Status = VALUES(Status), ProjectionVersion = VALUES(ProjectionVersion),
         ProjectionSchemaVersion = VALUES(ProjectionSchemaVersion), ContentHash = VALUES(ContentHash),
         IsDeleted = VALUES(IsDeleted), UpdatedAt = VALUES(UpdatedAt)`,
      [target.legacyDatabaseId, target.legacyCompanyId, target.environment, record.legacyAssetRef, record.centralRef,
        record.configVersion, record.status, record.sourceVersion, projectionSchemaVersion, hash, record.tombstone ? 1 : 0],
    );
    return;
  }
  await manager.query(
    `INSERT INTO ${table}
     (IdDatabase, IdCompany, Environment, IdAsset, CentralAssetRef, ExternalId, DisplayName, AssetKind,
      ParentLegacyAssetRef, CapabilitiesJson, Status, ProjectionVersion, ProjectionSchemaVersion,
      ContentHash, IsDeleted, UpdatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))
     ON DUPLICATE KEY UPDATE CentralAssetRef = VALUES(CentralAssetRef), ExternalId = VALUES(ExternalId),
       DisplayName = VALUES(DisplayName), AssetKind = VALUES(AssetKind),
       ParentLegacyAssetRef = VALUES(ParentLegacyAssetRef), CapabilitiesJson = VALUES(CapabilitiesJson),
       Status = VALUES(Status), ProjectionVersion = VALUES(ProjectionVersion),
       ProjectionSchemaVersion = VALUES(ProjectionSchemaVersion), ContentHash = VALUES(ContentHash),
       IsDeleted = VALUES(IsDeleted), UpdatedAt = VALUES(UpdatedAt)`,
    [target.legacyDatabaseId, target.legacyCompanyId, target.environment, record.legacyAssetRef, record.centralRef,
      record.externalId, record.displayName, record.assetKind, record.parentLegacyAssetRef,
      JSON.stringify(record.capabilities), record.status, record.sourceVersion, projectionSchemaVersion,
      hash, record.tombstone ? 1 : 0],
  );
}

/** Writes only the synthetic/approved target column set; this class does not create or alter destination schemas. */
export class MysqlLegacyProjectionDestination implements LegacyProjectionDestination {
  private readonly keyHash: string;

  constructor(private readonly target: LegacyProjectionTargetKey, private readonly dataSource: DataSource) {
    validateProjectionTarget(target);
    this.keyHash = destinationKeyHash(target);
  }

  async apply(input: {
    readonly target: LegacyProjectionTargetKey;
    readonly tenantId: string;
    readonly records: readonly LegacyProjectionRecord[];
    readonly projectionSchemaVersion: number;
  }): Promise<void> {
    if (destinationKeyHash(validateProjectionTarget(input.target)) !== this.keyHash) {
      throw new LegacyProjectionError('DESTINATION_CATALOG_MISMATCH', 'Resolved destination does not match the requested tenant mapping.');
    }
    await this.dataSource.transaction(async (manager) => {
      for (const unchecked of input.records) {
        const record = validateProjectionRecord(unchecked);
        const table = targetTable(record);
        const existingRows = await manager.query(
          selectTargetRows(table, true, true),
          [input.target.legacyDatabaseId, input.target.legacyCompanyId, input.target.environment, record.legacyAssetRef],
        ) as RebuildTargetRow[];
        const existing = existingRows[0];
        const hash = projectionContentHash(record);
        if (existing) {
          const version = Number(existing.ProjectionVersion);
          if (record.sourceVersion < version) continue;
          if (record.sourceVersion === version) {
            const actualHash = contentHashFromDestinationRow(table, existing);
            if (actualHash === hash && existing.ContentHash === hash) continue;
            if (actualHash !== undefined && actualHash !== hash && existing.ContentHash === actualHash) {
              throw new LegacyProjectionError('PROJECTION_VERSION_CONFLICT', 'Destination revision conflicts with different content.');
            }
            // A stale ContentHash or a field hash that no longer matches it is repairable
            // from this trusted current snapshot, even when the stored revision is unchanged.
          }
        }
        await writeProjectionRecord(manager, input.target, record, input.projectionSchemaVersion);
      }
    });
  }

  async reconcile(input: {
    readonly target: LegacyProjectionTargetKey;
    readonly tenantId: string;
    readonly records: readonly LegacyProjectionRecord[];
    readonly knownOwnedCheckpoints: readonly LegacyProjectionCheckpoint[];
    readonly projectionSchemaVersion: number;
    readonly destinationKeyHash: string;
  }): Promise<LegacyProjectionRebuildResult> {
    if (destinationKeyHash(validateProjectionTarget(input.target)) !== this.keyHash ||
        input.destinationKeyHash !== this.keyHash) {
      throw new LegacyProjectionError('DESTINATION_CATALOG_MISMATCH', 'Rebuild target does not match its allowlisted destination.');
    }
    const expected = new Map(input.records.map((record) => [record.centralRef, validateProjectionRecord(record)]));
    const known = new Map<string, LegacyProjectionCheckpoint>();
    for (const checkpoint of input.knownOwnedCheckpoints) {
      if (checkpoint.tenantId !== input.tenantId || checkpoint.destinationKeyHash !== this.keyHash) {
        throw new LegacyProjectionError('REBUILD_CHECKPOINT_SCOPE_MISMATCH', 'Rebuild checkpoint is outside the mapped tenant destination.');
      }
      known.set(checkpoint.centralRef, checkpoint);
    }
    const tombstones: LegacyProjectionRecord[] = [];
    const actualEntries: string[] = [];
    let reconciledExtraCount = 0;
    let ambiguousExtraCount = 0;
    await this.dataSource.transaction(async (manager) => {
      for (const table of PROJECTOR_TABLES) {
        const rows = await manager.query(
          selectTargetRows(table, true),
          [input.target.legacyDatabaseId, input.target.legacyCompanyId, input.target.environment],
        ) as RebuildTargetRow[];
        for (const row of rows) {
          const centralRef = row.CentralAssetRef;
          if (centralRef && expected.has(centralRef)) {
            const expectedRecord = expected.get(centralRef)!;
            const expectedHash = projectionContentHash(expectedRecord);
            const actualHash = contentHashFromDestinationRow(table, row);
            const rowVersion = Number(row.ProjectionVersion);
            if (table === targetTable(expectedRecord) && actualHash !== expectedHash &&
                Number.isSafeInteger(rowVersion) && rowVersion <= expectedRecord.sourceVersion) {
              await writeProjectionRecord(manager, input.target, expectedRecord, input.projectionSchemaVersion);
            } else if (table === targetTable(expectedRecord) && actualHash === expectedHash && row.ContentHash !== actualHash) {
              await manager.query(
                `UPDATE ${table} SET ContentHash = ?
                 WHERE IdDatabase = ? AND IdCompany = ? AND Environment = ? AND IdAsset = ? AND CentralAssetRef = ?`,
                [actualHash, input.target.legacyDatabaseId, input.target.legacyCompanyId, input.target.environment,
                  row.IdAsset, centralRef],
              );
            }
            continue;
          }
          const checkpoint = centralRef ? known.get(centralRef) : undefined;
          if (!checkpoint) { ambiguousExtraCount += 1; continue; }

          const rowVersion = Number(row.ProjectionVersion);
          if (!Number.isSafeInteger(rowVersion) || rowVersion < 1) {
            throw new LegacyProjectionError('REBUILD_ROW_INVALID', 'Owned destination row has an invalid projection version.');
          }
          let tombstone = tombstoneFromRow(table, row, rowVersion);
          const alreadyTombstoned = Number(row.IsDeleted) === 1 && row.Status === 'REMOVED' &&
            contentHashFromDestinationRow(table, row) === projectionContentHash(tombstone) &&
            projectionContentHash(tombstone) === row.ContentHash;
          if (!alreadyTombstoned) {
            const nextVersion = Math.max(rowVersion, checkpoint.sourceVersion) + 1;
            if (!Number.isSafeInteger(nextVersion)) {
              throw new LegacyProjectionError('REBUILD_VERSION_EXHAUSTED', 'Owned destination revision cannot be advanced safely.');
            }
            tombstone = tombstoneFromRow(table, row, nextVersion);
            const hash = projectionContentHash(tombstone);
            await manager.query(
              `UPDATE ${table}
               SET Status = 'REMOVED', ProjectionVersion = ?, ProjectionSchemaVersion = ?, ContentHash = ?,
                   IsDeleted = 1, UpdatedAt = UTC_TIMESTAMP(6)
               WHERE IdDatabase = ? AND IdCompany = ? AND Environment = ? AND IdAsset = ? AND CentralAssetRef = ? AND ProjectionVersion = ?`,
              [nextVersion, input.projectionSchemaVersion, hash, input.target.legacyDatabaseId, input.target.legacyCompanyId, input.target.environment,
                row.IdAsset, centralRef, rowVersion],
            );
          }
          tombstones.push(tombstone);
          reconciledExtraCount += 1;
        }
      }

      // Hash the persisted projected columns after repairs/tombstones. Stored ContentHash is
      // treated as integrity metadata only; it is never evidence of field parity by itself.
      for (const table of PROJECTOR_TABLES) {
        const rows = await manager.query(
          selectTargetRows(table, false),
          [input.target.legacyDatabaseId, input.target.legacyCompanyId, input.target.environment],
        ) as RebuildTargetRow[];
        for (const row of rows) {
          if (!row.CentralAssetRef || !expected.has(row.CentralAssetRef)) continue;
          const actualHash = contentHashFromDestinationRow(table, row);
          actualEntries.push(`${row.CentralAssetRef}:${actualHash ?? 'INVALID'}`);
        }
      }
    });

    const expectedEntries = [...expected.values()].map((record) => `${record.centralRef}:${projectionContentHash(record)}`);
    const expectedHash = reportHash(expectedEntries);
    const actualHash = reportHash(actualEntries);
    const actualCount = actualEntries.length;
    const parity = ambiguousExtraCount > 0 ? 'AMBIGUOUS' :
      actualCount === expected.size && actualHash === expectedHash ? 'MATCHED' : 'MISMATCH';
    return Object.freeze({
      destinationKeyHash: this.keyHash, expectedCount: expected.size, actualCount,
      reconciledExtraCount, ambiguousExtraCount, expectedHash, actualHash, parity,
      tombstones: Object.freeze(tombstones),
    });
  }
}
