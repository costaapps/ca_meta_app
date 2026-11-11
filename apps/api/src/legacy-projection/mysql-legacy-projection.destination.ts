import type { DataSource } from 'typeorm';
import { destinationKeyHash, projectionContentHash, validateProjectionRecord, validateProjectionTarget } from './legacy-projection.mapper.js';
import type { LegacyProjectionDestination, LegacyProjectionRecord, LegacyProjectionTargetKey } from './legacy-projection.types.js';
import { LegacyProjectionError } from './legacy-projection.types.js';

interface ExistingTargetRow { ProjectionVersion: number | string; ContentHash: string }

function targetTable(record: LegacyProjectionRecord): 'MetaConnectedPages' | 'MetaConnectedNumbers' | 'MetaAssetAutomationConfigs' {
  if (record.kind === 'PAGE') return 'MetaConnectedPages';
  if (record.kind === 'WHATSAPP_NUMBER') return 'MetaConnectedNumbers';
  return 'MetaAssetAutomationConfigs';
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
          `SELECT ProjectionVersion, ContentHash FROM ${table}
           WHERE IdDatabase = ? AND IdCompany = ? AND IdAsset = ? FOR UPDATE`,
          [input.target.legacyDatabaseId, input.target.legacyCompanyId, record.legacyAssetRef],
        ) as ExistingTargetRow[];
        const existing = existingRows[0];
        const hash = projectionContentHash(record);
        if (existing) {
          const version = Number(existing.ProjectionVersion);
          if (record.sourceVersion < version) continue;
          if (record.sourceVersion === version) {
            if (hash !== existing.ContentHash) {
              throw new LegacyProjectionError('PROJECTION_VERSION_CONFLICT', 'Destination revision conflicts with different content.');
            }
            continue;
          }
        }
        if (record.kind === 'AUTOMATION_CONFIG') {
          await manager.query(
            `INSERT INTO MetaAssetAutomationConfigs
             (IdDatabase, IdCompany, IdAsset, CentralAssetRef, ConfigVersion, Status, ProjectionVersion,
              ProjectionSchemaVersion, ContentHash, IsDeleted, UpdatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))
             ON DUPLICATE KEY UPDATE CentralAssetRef = VALUES(CentralAssetRef), ConfigVersion = VALUES(ConfigVersion),
               Status = VALUES(Status), ProjectionVersion = VALUES(ProjectionVersion),
               ProjectionSchemaVersion = VALUES(ProjectionSchemaVersion), ContentHash = VALUES(ContentHash),
               IsDeleted = VALUES(IsDeleted), UpdatedAt = VALUES(UpdatedAt)`,
            [input.target.legacyDatabaseId, input.target.legacyCompanyId, record.legacyAssetRef, record.centralRef,
              record.configVersion, record.status, record.sourceVersion, input.projectionSchemaVersion, hash, record.tombstone ? 1 : 0],
          );
        } else {
          await manager.query(
            `INSERT INTO ${table}
             (IdDatabase, IdCompany, IdAsset, CentralAssetRef, ExternalId, DisplayName, AssetKind,
              ParentLegacyAssetRef, CapabilitiesJson, Status, ProjectionVersion, ProjectionSchemaVersion,
              ContentHash, IsDeleted, UpdatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))
             ON DUPLICATE KEY UPDATE CentralAssetRef = VALUES(CentralAssetRef), ExternalId = VALUES(ExternalId),
               DisplayName = VALUES(DisplayName), AssetKind = VALUES(AssetKind),
               ParentLegacyAssetRef = VALUES(ParentLegacyAssetRef), CapabilitiesJson = VALUES(CapabilitiesJson),
               Status = VALUES(Status), ProjectionVersion = VALUES(ProjectionVersion),
               ProjectionSchemaVersion = VALUES(ProjectionSchemaVersion), ContentHash = VALUES(ContentHash),
               IsDeleted = VALUES(IsDeleted), UpdatedAt = VALUES(UpdatedAt)`,
            [input.target.legacyDatabaseId, input.target.legacyCompanyId, record.legacyAssetRef, record.centralRef,
              record.externalId, record.displayName, record.assetKind, record.parentLegacyAssetRef,
              JSON.stringify(record.capabilities), record.status, record.sourceVersion, input.projectionSchemaVersion,
              hash, record.tombstone ? 1 : 0],
          );
        }
      }
    });
  }
}
