import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import { parseOutboxEvent, type OutboxEventEnvelope } from '../jobs/event-validation.js';
import type { LegacyProjectionRecord, LegacyProjectionSnapshot, LegacyProjectionSource, LegacyProjectionTargetKey } from './legacy-projection.types.js';
import { LegacyProjectionError } from './legacy-projection.types.js';

interface OutboxRow { payload_json: string | Buffer | unknown }
interface AssetProjectionRow {
  central_ref: string; legacy_database_id: string; legacy_company_id: string; environment: LegacyProjectionTargetKey['environment'];
  legacy_asset_ref: string; asset_kind: string; external_id: string; display_name: string | null;
  source_version: string | number; status: 'ACTIVE' | 'REMOVED'; parent_asset_id: string | null; parent_legacy_asset_ref: string | null;
}
interface ConfigProjectionRow {
  central_ref: string; legacy_database_id: string; legacy_company_id: string; environment: LegacyProjectionTargetKey['environment'];
  legacy_asset_ref: string; config_version: string | number; status: 'ACTIVE' | 'REMOVED';
}

function eventFromJson(value: string | Buffer | unknown): OutboxEventEnvelope {
  const parsed = Buffer.isBuffer(value) ? JSON.parse(value.toString('utf8')) as unknown :
    typeof value === 'string' ? JSON.parse(value) as unknown : value;
  return parseOutboxEvent(parsed);
}

function eventReference(event: OutboxEventEnvelope, key: string): string {
  const value = event.data[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new LegacyProjectionError('INVALID_EVENT_REFERENCE', 'Outbox event reference is invalid.');
  }
  return value;
}

function projectionKind(assetKind: string): LegacyProjectionRecord['kind'] | undefined {
  if (assetKind === 'FACEBOOK_PAGE' || assetKind === 'INSTAGRAM_BUSINESS_ACCOUNT' || assetKind === 'INSTAGRAM_CREATOR_ACCOUNT') return 'PAGE';
  if (assetKind === 'WHATSAPP_PHONE_NUMBER' || assetKind === 'WHATSAPP_BUSINESS_ACCOUNT') return 'WHATSAPP_NUMBER';
  return undefined;
}

const PROJECTED_GRANTS: Readonly<Record<string, string>> = Object.freeze({
  pages_show_list: 'PAGES_SHOW_LIST',
  pages_read_engagement: 'PAGES_READ_ENGAGEMENT',
  pages_manage_metadata: 'PAGES_MANAGE_METADATA',
  instagram_basic: 'INSTAGRAM_BASIC',
  instagram_manage_comments: 'INSTAGRAM_MANAGE_COMMENTS',
  instagram_manage_messages: 'INSTAGRAM_MANAGE_MESSAGES',
  whatsapp_business_management: 'WHATSAPP_BUSINESS_MANAGEMENT',
  whatsapp_business_messaging: 'WHATSAPP_BUSINESS_MESSAGING',
});

interface GrantProjectionRow { asset_id: string; grant_name: string }

function appendTargetGroups(
  groups: Map<string, { target: LegacyProjectionTargetKey; records: LegacyProjectionRecord[] }>,
  incoming: LegacyProjectionSnapshot['targets'],
): void {
  for (const group of incoming) {
    const key = JSON.stringify([group.target.legacyDatabaseId, group.target.legacyCompanyId, group.target.environment]);
    const entry = groups.get(key) ?? { target: group.target, records: [] };
    entry.records.push(...group.records);
    groups.set(key, entry);
  }
}

function groupRows<T extends { legacy_database_id: string; legacy_company_id: string; environment: LegacyProjectionTargetKey['environment'] }>(
  rows: readonly T[],
  makeRecord: (row: T) => LegacyProjectionRecord,
): LegacyProjectionSnapshot['targets'] {
  const groups = new Map<string, { target: LegacyProjectionTargetKey; records: LegacyProjectionRecord[] }>();
  for (const row of rows) {
    const target: LegacyProjectionTargetKey = {
      legacyDatabaseId: row.legacy_database_id,
      legacyCompanyId: row.legacy_company_id,
      environment: row.environment,
    };
    const key = JSON.stringify([target.legacyDatabaseId, target.legacyCompanyId, target.environment]);
    const group = groups.get(key) ?? { target, records: [] };
    group.records.push(makeRecord(row));
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => Object.freeze({ target: Object.freeze(group.target), records: Object.freeze(group.records) }));
}

/** Reads only the current central metadata snapshot and opaque legacy references; no config text or credential tables are selected. */
export class MysqlLegacyProjectionSource implements LegacyProjectionSource {
  constructor(private readonly database: DurableWorkDatabase) {}

  private async loadCapabilities(
    tenantId: string,
    assetIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    const dataSource = await this.database.getDataSource();
    const grantNames = Object.keys(PROJECTED_GRANTS);
    const capabilities = new Map<string, Set<string>>();
    const uniqueAssetIds = [...new Set(assetIds)];
    for (let offset = 0; offset < uniqueAssetIds.length; offset += 250) {
      const chunk = uniqueAssetIds.slice(offset, offset + 250);
      if (chunk.length === 0) continue;
      const rows = await dataSource.query(
        `SELECT g.asset_id, g.grant_name
         FROM ca_meta_asset_grants g
         INNER JOIN ca_meta_asset_authorizations aa
           ON aa.tenant_id = g.tenant_id AND aa.authorization_id = g.authorization_id AND aa.asset_id = g.asset_id
          AND aa.app_configuration_id = g.app_configuration_id AND aa.provider = g.provider AND aa.environment = g.environment
         INNER JOIN ca_meta_authorizations auth
           ON auth.tenant_id = g.tenant_id AND auth.id = g.authorization_id
          AND auth.app_configuration_id = g.app_configuration_id AND auth.provider = g.provider AND auth.environment = g.environment
         WHERE g.tenant_id = ? AND g.asset_id IN (${chunk.map(() => '?').join(',')})
           AND g.grant_name IN (${grantNames.map(() => '?').join(',')})
           AND g.status = 'GRANTED' AND aa.state = 'ACTIVE' AND aa.verification_state = 'VERIFIED'
           AND auth.authorization_state IN ('ACTIVE', 'PARTIAL')
         ORDER BY g.asset_id, g.grant_name`,
        [tenantId, ...chunk, ...grantNames],
      ) as GrantProjectionRow[];
      for (const row of rows) {
        const capability = PROJECTED_GRANTS[row.grant_name];
        if (!capability) continue;
        const values = capabilities.get(row.asset_id) ?? new Set<string>();
        values.add(capability);
        capabilities.set(row.asset_id, values);
      }
    }
    return new Map([...capabilities].map(([assetId, values]) => [assetId, Object.freeze([...values].sort())]));
  }

  private assetRecord(row: AssetProjectionRow, capabilities: readonly string[]): LegacyProjectionRecord {
    const kind = projectionKind(row.asset_kind);
    if (!kind) throw new LegacyProjectionError('UNSUPPORTED_ASSET_KIND', 'Asset kind is not mapped to a legacy metadata table.');
    if (row.parent_asset_id && !row.parent_legacy_asset_ref) {
      throw new LegacyProjectionError('PARENT_LEGACY_REFERENCE_MISSING', 'Related asset lacks a mapping in this destination company.');
    }
    return Object.freeze({
      kind, centralRef: row.central_ref, legacyAssetRef: row.legacy_asset_ref, sourceVersion: Number(row.source_version),
      status: row.status, externalId: row.external_id, displayName: row.display_name, assetKind: row.asset_kind,
      parentLegacyAssetRef: row.parent_legacy_asset_ref, capabilities: Object.freeze([...capabilities]), configVersion: null,
      tombstone: row.status === 'REMOVED',
    });
  }

  async loadCurrent(tenantId: string, outboxEventId: string, sourceVersion: number): Promise<LegacyProjectionSnapshot | undefined> {
    const dataSource = await this.database.getDataSource();
    const outboxRows = await dataSource.query(
      `SELECT payload_json FROM ca_meta_outbox_events WHERE id = ? AND tenant_id = ? LIMIT 1`,
      [outboxEventId, tenantId],
    ) as OutboxRow[];
    if (!outboxRows[0]) return undefined;
    const event = eventFromJson(outboxRows[0].payload_json);
    if (event.tenantRef !== tenantId || event.aggregateVersion !== sourceVersion) {
      throw new LegacyProjectionError('OUTBOX_REFERENCE_MISMATCH', 'Projection job does not match the tenant outbox event.');
    }
    if (event.eventType === 'connection.changed') return this.loadConnectionSnapshot(tenantId, event);
    if (event.eventType === 'automation.config.changed') return this.loadAutomationSnapshot(tenantId, event);
    throw new LegacyProjectionError('UNSUPPORTED_PROJECTION_EVENT', 'Outbox event is not eligible for metadata projection.');
  }

  async loadTenantCurrent(tenantId: string): Promise<import('./legacy-projection.types.js').LegacyProjectionRebuildSnapshot> {
    const dataSource = await this.database.getDataSource();
    const assets = await dataSource.query(
      `SELECT a.id AS central_ref, l.legacy_database_id, l.legacy_company_id, l.environment,
              l.legacy_asset_ref, a.asset_kind, a.external_id, COALESCE(a.external_name, a.display_name) AS display_name,
              a.version AS source_version,
              CASE WHEN EXISTS (
                SELECT 1 FROM ca_meta_asset_authorizations current_aa
                INNER JOIN ca_meta_authorizations current_auth
                  ON current_auth.tenant_id = current_aa.tenant_id AND current_auth.id = current_aa.authorization_id
                WHERE current_aa.tenant_id = a.tenant_id AND current_aa.asset_id = a.id
                  AND current_aa.state = 'ACTIVE' AND current_aa.verification_state = 'VERIFIED'
                  AND current_auth.authorization_state IN ('ACTIVE', 'PARTIAL')
              ) THEN 'ACTIVE' ELSE 'REMOVED' END AS status,
              rel.target_asset_id AS parent_asset_id, parent.legacy_asset_ref AS parent_legacy_asset_ref
       FROM ca_meta_assets a
       INNER JOIN ca_meta_asset_legacy_refs l
         ON l.tenant_id = a.tenant_id AND l.asset_id = a.id AND l.environment = a.environment
       INNER JOIN ca_meta_tenant_legacy_maps lm
         ON lm.tenant_id = l.tenant_id AND lm.legacy_database_id = l.legacy_database_id
        AND lm.legacy_company_id = l.legacy_company_id AND lm.environment = l.environment
       LEFT JOIN ca_meta_asset_relations rel
         ON rel.tenant_id = a.tenant_id AND rel.source_asset_id = a.id
        AND rel.relation_type IN ('PHONE_TO_ACCOUNT', 'INSTAGRAM_TO_PAGE')
       LEFT JOIN ca_meta_asset_legacy_refs parent
         ON parent.tenant_id = rel.tenant_id AND parent.asset_id = rel.target_asset_id
        AND parent.legacy_database_id = l.legacy_database_id AND parent.legacy_company_id = l.legacy_company_id
        AND parent.environment = l.environment
       WHERE a.tenant_id = ?
       ORDER BY l.legacy_database_id, l.legacy_company_id, l.legacy_asset_ref`,
      [tenantId],
    ) as AssetProjectionRow[];
    const configs = await dataSource.query(
      `SELECT CONCAT('automation:', a.id) AS central_ref, l.legacy_database_id, l.legacy_company_id, l.environment,
              l.legacy_asset_ref, cfg.version AS config_version,
              CASE WHEN EXISTS (
                SELECT 1 FROM ca_meta_asset_authorizations current_aa
                INNER JOIN ca_meta_authorizations current_auth
                  ON current_auth.tenant_id = current_aa.tenant_id AND current_auth.id = current_aa.authorization_id
                WHERE current_aa.tenant_id = a.tenant_id AND current_aa.asset_id = a.id
                  AND current_aa.state = 'ACTIVE' AND current_aa.verification_state = 'VERIFIED'
                  AND current_auth.authorization_state IN ('ACTIVE', 'PARTIAL')
              ) THEN 'ACTIVE' ELSE 'REMOVED' END AS status
       FROM ca_meta_assets a
       INNER JOIN ca_meta_asset_automation_configs cfg ON cfg.tenant_id = a.tenant_id AND cfg.asset_id = a.id
       INNER JOIN ca_meta_asset_legacy_refs l ON l.tenant_id = a.tenant_id AND l.asset_id = a.id AND l.environment = a.environment
       INNER JOIN ca_meta_tenant_legacy_maps lm ON lm.tenant_id = l.tenant_id
        AND lm.legacy_database_id = l.legacy_database_id AND lm.legacy_company_id = l.legacy_company_id AND lm.environment = l.environment
       WHERE a.tenant_id = ? AND cfg.version >= 1
       ORDER BY l.legacy_database_id, l.legacy_company_id, l.legacy_asset_ref`,
      [tenantId],
    ) as ConfigProjectionRow[];

    const assetCapabilities = await this.loadCapabilities(tenantId, assets.map((row) => row.central_ref));
    const configCapabilities = await this.loadCapabilities(tenantId, configs.map((row) => row.central_ref.slice('automation:'.length)));
    const assetGroups = groupRows(assets, (row) => this.assetRecord(row, assetCapabilities.get(row.central_ref) ?? []));
    const configGroups = groupRows(configs, (row) => {
      const configVersion = Number(row.config_version);
      if (!Number.isSafeInteger(configVersion) || configVersion < 1) {
        throw new LegacyProjectionError('INVALID_CONFIG_VERSION', 'Automation configuration version is invalid.');
      }
      return Object.freeze({ kind: 'AUTOMATION_CONFIG', centralRef: row.central_ref, legacyAssetRef: row.legacy_asset_ref,
        sourceVersion: configVersion, status: row.status, externalId: null, displayName: null, assetKind: null,
        parentLegacyAssetRef: null, capabilities: configCapabilities.get(row.central_ref.slice('automation:'.length)) ?? Object.freeze([]),
        configVersion, tombstone: row.status === 'REMOVED' });
    });
    const merged = new Map<string, { target: LegacyProjectionTargetKey; records: LegacyProjectionRecord[] }>();
    appendTargetGroups(merged, assetGroups);
    appendTargetGroups(merged, configGroups);
    return Object.freeze({ tenantId, targets: Object.freeze([...merged.values()].map((group) => Object.freeze({
      target: group.target, records: Object.freeze(group.records),
    }))) });
  }

  private async loadConnectionSnapshot(tenantId: string, event: OutboxEventEnvelope): Promise<LegacyProjectionSnapshot> {
    const dataSource = await this.database.getDataSource();
    const connectionRef = eventReference(event, 'connectionRef');
    const rows = await dataSource.query(
      `SELECT a.id AS central_ref, l.legacy_database_id, l.legacy_company_id, l.environment,
              l.legacy_asset_ref, a.asset_kind, a.external_id, COALESCE(a.external_name, a.display_name) AS display_name,
              a.version AS source_version,
              CASE WHEN EXISTS (
                SELECT 1 FROM ca_meta_asset_authorizations current_aa
                INNER JOIN ca_meta_authorizations current_auth
                  ON current_auth.tenant_id = current_aa.tenant_id AND current_auth.id = current_aa.authorization_id
                WHERE current_aa.tenant_id = a.tenant_id AND current_aa.asset_id = a.id
                  AND current_aa.state = 'ACTIVE' AND current_aa.verification_state = 'VERIFIED'
                  AND current_auth.authorization_state IN ('ACTIVE', 'PARTIAL')
              ) THEN 'ACTIVE' ELSE 'REMOVED' END AS status,
              rel.target_asset_id AS parent_asset_id, parent.legacy_asset_ref AS parent_legacy_asset_ref
       FROM ca_meta_assets a
       INNER JOIN ca_meta_asset_authorizations changed_aa
         ON changed_aa.tenant_id = a.tenant_id AND changed_aa.asset_id = a.id
       INNER JOIN ca_meta_authorizations changed_auth
         ON changed_auth.tenant_id = changed_aa.tenant_id AND changed_auth.id = changed_aa.authorization_id
       INNER JOIN ca_meta_asset_legacy_refs l
         ON l.tenant_id = a.tenant_id AND l.asset_id = a.id AND l.environment = a.environment
       INNER JOIN ca_meta_tenant_legacy_maps lm
         ON lm.tenant_id = l.tenant_id AND lm.legacy_database_id = l.legacy_database_id
        AND lm.legacy_company_id = l.legacy_company_id AND lm.environment = l.environment
       LEFT JOIN ca_meta_asset_relations rel
         ON rel.tenant_id = a.tenant_id AND rel.source_asset_id = a.id
        AND rel.relation_type IN ('PHONE_TO_ACCOUNT', 'INSTAGRAM_TO_PAGE')
       LEFT JOIN ca_meta_asset_legacy_refs parent
         ON parent.tenant_id = rel.tenant_id AND parent.asset_id = rel.target_asset_id
        AND parent.legacy_database_id = l.legacy_database_id AND parent.legacy_company_id = l.legacy_company_id
        AND parent.environment = l.environment
       WHERE a.tenant_id = ? AND changed_aa.authorization_id = ?
       ORDER BY l.legacy_database_id, l.legacy_company_id, l.legacy_asset_ref`,
      [tenantId, connectionRef],
    ) as AssetProjectionRow[];
    const capabilities = await this.loadCapabilities(tenantId, rows.map((row) => row.central_ref));
    const targets = groupRows(rows, (row) => this.assetRecord(row, capabilities.get(row.central_ref) ?? []));
    return Object.freeze({ tenantId, event, targets });
  }

  private async loadAutomationSnapshot(tenantId: string, event: OutboxEventEnvelope): Promise<LegacyProjectionSnapshot> {
    const dataSource = await this.database.getDataSource();
    const assetRef = eventReference(event, 'assetRef');
    const rows = await dataSource.query(
      `SELECT CONCAT('automation:', a.id) AS central_ref, l.legacy_database_id, l.legacy_company_id, l.environment,
              l.legacy_asset_ref, cfg.version AS config_version,
              CASE WHEN EXISTS (
                SELECT 1 FROM ca_meta_asset_authorizations current_aa
                INNER JOIN ca_meta_authorizations current_auth
                  ON current_auth.tenant_id = current_aa.tenant_id AND current_auth.id = current_aa.authorization_id
                WHERE current_aa.tenant_id = a.tenant_id AND current_aa.asset_id = a.id
                  AND current_aa.state = 'ACTIVE' AND current_aa.verification_state = 'VERIFIED'
                  AND current_auth.authorization_state IN ('ACTIVE', 'PARTIAL')
              ) THEN 'ACTIVE' ELSE 'REMOVED' END AS status
       FROM ca_meta_assets a
       INNER JOIN ca_meta_asset_automation_configs cfg ON cfg.tenant_id = a.tenant_id AND cfg.asset_id = a.id
       INNER JOIN ca_meta_asset_legacy_refs l ON l.tenant_id = a.tenant_id AND l.asset_id = a.id AND l.environment = a.environment
       INNER JOIN ca_meta_tenant_legacy_maps lm ON lm.tenant_id = l.tenant_id
        AND lm.legacy_database_id = l.legacy_database_id AND lm.legacy_company_id = l.legacy_company_id AND lm.environment = l.environment
       WHERE a.tenant_id = ? AND a.id = ?
       ORDER BY l.legacy_database_id, l.legacy_company_id, l.legacy_asset_ref`,
      [tenantId, assetRef],
    ) as ConfigProjectionRow[];
    const capabilities = await this.loadCapabilities(tenantId, [assetRef]);
    const targets = groupRows(rows, (row) => {
      const configVersion = Number(row.config_version);
      if (!Number.isSafeInteger(configVersion) || configVersion < 1) {
        throw new LegacyProjectionError('INVALID_CONFIG_VERSION', 'Automation configuration version is invalid.');
      }
      return Object.freeze({
        kind: 'AUTOMATION_CONFIG', centralRef: row.central_ref, legacyAssetRef: row.legacy_asset_ref,
        sourceVersion: configVersion, status: row.status, externalId: null, displayName: null, assetKind: null,
        parentLegacyAssetRef: null, capabilities: capabilities.get(assetRef) ?? Object.freeze([]), configVersion,
        tombstone: row.status === 'REMOVED',
      });
    });
    return Object.freeze({ tenantId, event, targets });
  }
}
