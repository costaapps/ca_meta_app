import { createHash, randomUUID } from 'node:crypto';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { OutboxEventEnvelope } from '../jobs/event-validation.js';
import type { OutboxService } from '../outbox/outbox-service.js';
import {
  isAssetObservationTenantAssetRef,
  parseAssetObservationSnapshot,
  reduceAssetObservation,
  toPublicAssetStatusObservation,
  type AssetObservationInput,
  type AssetObservationSnapshot,
  AssetObservationInputError,
  AssetObservationNotFoundError,
} from './asset-observation.service.js';
import { isMetaAssetKind } from './meta-assets.types.js';

export type AssetObservationWriteResult =
  | { readonly kind: 'RECORDED'; readonly snapshot: AssetObservationSnapshot }
  | { readonly kind: 'SUPERSEDED' }
  | { readonly kind: 'SUPPRESSED_REVOKED' };

interface ObservationRow {
  readonly snapshot_json: string | AssetObservationSnapshot;
}

/** Tenant-scoped append-only observation storage. It never writes authorization, grant or credential tables. */
export class MysqlAssetObservationRepository {
  constructor(
    private readonly database: DurableWorkDatabase,
    private readonly outbox: Pick<OutboxService, 'appendWithin'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(input: {
    readonly tenantId: string;
    readonly assetId: string;
    readonly authorizationId: string;
    readonly observation: AssetObservationInput;
  }): Promise<AssetObservationWriteResult> {
    if (!isAssetObservationTenantAssetRef(input.tenantId, input.assetId) || !isAssetObservationTenantAssetRef(input.tenantId, input.authorizationId)) {
      throw new AssetObservationInputError();
    }
    const dataSource = await this.database.getDataSource();
    const fetchedAtDate = this.now();
    if (!Number.isFinite(fetchedAtDate.getTime())) throw new AssetObservationInputError();
    const fetchedAt = fetchedAtDate.toISOString();
    return dataSource.transaction(async (manager) => {
      const tenantRows = await manager.query('SELECT id FROM ca_meta_tenants WHERE id = ? FOR UPDATE', [input.tenantId]) as Array<{ id: string }>;
      if (tenantRows.length !== 1) throw new AssetObservationNotFoundError();
      const assetRows = await manager.query(
        `SELECT asset.id, asset.asset_kind FROM ca_meta_asset_authorizations aa
         INNER JOIN ca_meta_authorizations auth ON auth.tenant_id = aa.tenant_id AND auth.id = aa.authorization_id
         INNER JOIN ca_meta_assets asset ON asset.tenant_id = aa.tenant_id AND asset.id = aa.asset_id
         WHERE aa.tenant_id = ? AND aa.authorization_id = ? AND aa.asset_id = ?
           AND aa.state = 'ACTIVE' AND aa.verification_state = 'VERIFIED'
           AND auth.authorization_state IN ('ACTIVE', 'PARTIAL') FOR UPDATE`,
        [input.tenantId, input.authorizationId, input.assetId],
      ) as Array<{ id: string; asset_kind: string }>;
      const asset = assetRows[0];
      if (!asset) return Object.freeze({ kind: 'SUPPRESSED_REVOKED' as const });
      if (asset.asset_kind !== input.observation.kind) throw new AssetObservationInputError();

      const previousRows = await manager.query(
        'SELECT snapshot_json FROM ca_meta_asset_observations WHERE tenant_id = ? AND authorization_id = ? AND asset_id = ? ORDER BY version DESC LIMIT 1 FOR UPDATE',
        [input.tenantId, input.authorizationId, input.assetId],
      ) as ObservationRow[];
      const previous = previousRows[0] ? parseSnapshot(previousRows[0].snapshot_json) : null;
      const nextVersion = (previous?.version ?? 0) + 1;
      const snapshot = reduceAssetObservation({ previous, authorizationRef: input.authorizationId, incoming: input.observation, fetchedAt,
        nextVersion });
      if (!snapshot) return Object.freeze({ kind: 'SUPERSEDED' as const });

      await manager.query(
        'INSERT INTO ca_meta_asset_observations (id, tenant_id, authorization_id, asset_id, version, schema_version, source, observed_at, fetched_at, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [randomUUID(), input.tenantId, input.authorizationId, input.assetId, snapshot.version, snapshot.schemaVersion, snapshot.source,
          mysqlDate(snapshot.observedAt), mysqlDate(snapshot.fetchedAt), JSON.stringify(snapshot), mysqlDate(fetchedAt)],
      );
      const actionableReason = toPublicAssetStatusObservation(snapshot, 'VERIFIED', fetchedAt).actionableReason;
      if (snapshot.driftCodes.length > 0 && actionableReason !== 'NONE') {
        await this.outbox.appendWithin(manager, assetDriftEvent({
          tenantId: input.tenantId,
          authorizationId: input.authorizationId,
          assetId: input.assetId,
          snapshot,
          actionableReason,
        }));
      }
      return Object.freeze({ kind: 'RECORDED' as const, snapshot });
    });
  }

  async findLatest(input: { readonly tenantId: string; readonly authorizationId: string; readonly assetId: string }): Promise<AssetObservationSnapshot | undefined> {
    if (!isAssetObservationTenantAssetRef(input.tenantId, input.assetId) || !isAssetObservationTenantAssetRef(input.tenantId, input.authorizationId)) return undefined;
    const dataSource = await this.database.getDataSource();
    const rows = await dataSource.query(
      'SELECT snapshot_json FROM ca_meta_asset_observations WHERE tenant_id = ? AND authorization_id = ? AND asset_id = ? ORDER BY version DESC LIMIT 1',
      [input.tenantId, input.authorizationId, input.assetId],
    ) as ObservationRow[];
    return rows[0] ? parseSnapshot(rows[0].snapshot_json) : undefined;
  }

  async recordUnavailable(input: { readonly tenantId: string; readonly assetId: string }): Promise<void> {
    if (!isAssetObservationTenantAssetRef(input.tenantId, input.assetId)) throw new AssetObservationInputError();
    const dataSource = await this.database.getDataSource();
    const rows = await dataSource.query(
      `SELECT aa.authorization_id, asset.asset_kind FROM ca_meta_asset_authorizations aa
       INNER JOIN ca_meta_authorizations auth ON auth.tenant_id = aa.tenant_id AND auth.id = aa.authorization_id
       INNER JOIN ca_meta_assets asset ON asset.tenant_id = aa.tenant_id AND asset.id = aa.asset_id
       WHERE aa.tenant_id = ? AND aa.asset_id = ? AND aa.state = 'ACTIVE' AND aa.verification_state = 'VERIFIED'
         AND auth.authorization_state IN ('ACTIVE', 'PARTIAL') ORDER BY aa.authorization_id`,
      [input.tenantId, input.assetId],
    ) as Array<{ authorization_id: string; asset_kind: string }>;
    for (const row of rows) {
      if (!isMetaAssetKind(row.asset_kind)) continue;
      await this.record({ ...input, authorizationId: row.authorization_id, observation: {
        kind: row.asset_kind,
        source: 'META_API',
        observedAt: null,
        status: { value: 'UNAVAILABLE', availability: 'UNAVAILABLE', providerCode: 'DEPENDENCY_UNAVAILABLE' },
        permissions: { availability: 'UNAVAILABLE' },
      } });
    }
  }
}

function assetDriftEvent(input: {
  readonly tenantId: string;
  readonly authorizationId: string;
  readonly assetId: string;
  readonly snapshot: AssetObservationSnapshot;
  readonly actionableReason: 'REAUTHORIZE' | 'CHECK_STATUS' | 'RECONCILE';
}): OutboxEventEnvelope {
  const identity = [input.tenantId, input.authorizationId, input.assetId, String(input.snapshot.version),
    input.snapshot.driftCodes.join(',')].join('\0');
  const digest = createHash('sha256').update(identity).digest('hex');
  const notificationRef = `notice_${digest}`;
  const eventId = `asset-drift:${digest}`;
  return Object.freeze({
    eventId,
    tenantRef: input.tenantId,
    schemaVersion: 1,
    eventType: 'asset.drift.detected',
    aggregateRef: notificationRef,
    aggregateVersion: 1,
    actor: { kind: 'SYSTEM', ref: 'asset-observation' },
    correlationId: eventId,
    causationId: `asset-observation:${digest}`,
    createdAt: input.snapshot.fetchedAt,
    enqueuedAt: input.snapshot.fetchedAt,
    data: {
      kind: 'ASSET_DRIFT_DETECTED',
      notificationRef,
      assetRef: input.assetId,
      status: 'UNREAD',
      driftCodes: input.snapshot.driftCodes,
      actionableReason: input.actionableReason,
    },
  });
}

function parseSnapshot(value: string | AssetObservationSnapshot): AssetObservationSnapshot {
  const parsed = parseAssetObservationSnapshot(value);
  if (!parsed) throw new Error('Stored asset observation is corrupt.');
  return parsed;
}

function mysqlDate(value: string | null): string | null {
  return value === null ? null : value.slice(0, 23).replace('T', ' ').replace(/Z$/, '');
}
