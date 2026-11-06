import { createHash, randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { MetaWebhookApplication, MetaWebhookResourceRoute, ProtectedMetaWebhookPayload } from './meta-webhook.types.js';
import type { ParsedMetaWebhookItem } from './meta-webhook-validation.js';

export interface MetaWebhookPersistResult {
  readonly received: number;
  readonly inserted: number;
  readonly duplicate: number;
  readonly quarantined: number;
}

interface AssetRouteRow {
  tenant_id: string;
  app_configuration_id: string;
  asset_id: string;
}

export interface MetaWebhookEventRow {
  id: string;
  payload_reference?: string;
  provider_app_id: string;
  environment: string;
  delivery_id: string | null;
  item_locator_json: string;
  event_ref: string;
  event_type: string;
  tenant_id: string | null;
  app_configuration_id: string | null;
  asset_id: string | null;
  route_state: 'ROUTED' | 'QUARANTINED';
  process_state: 'PENDING' | 'RUNNING' | 'RETRY_PENDING' | 'PROCESSED' | 'DEAD_LETTER' | 'BLOCKED';
  quarantine_reason: string | null;
  lease_owner: string | null;
  lease_version: number;
  attempt: number;
  lease_until: string | null;
  key_reference: string | null;
  nonce: Buffer | null;
  authentication_tag: Buffer | null;
  ciphertext: Buffer | null;
  expires_at: string | Date | null;
}

export interface ClaimedMetaWebhookItem {
  readonly id: string;
  readonly eventRef: string;
  readonly eventType: string;
  readonly tenantId: string;
  readonly appConfigurationId: string;
  readonly assetId: string;
  readonly attempt: number;
  readonly leaseVersion: number;
  readonly payload: ProtectedMetaWebhookPayload;
  readonly locator: ParsedMetaWebhookItem['locator'];
}

type AssetRouteResolution =
  | { readonly kind: 'ROUTED'; readonly route: MetaWebhookResourceRoute }
  | { readonly kind: 'UNKNOWN' | 'CONFLICTING' | 'MISSING_REFERENCE' };

function mysqlDate(value: string): string {
  const iso = new Date(value).toISOString();
  return `${iso.slice(0, 19)}.${iso.slice(20, 23)}000`;
}

function affectedRows(value: unknown): number {
  const header = Array.isArray(value) ? value[0] : value;
  return typeof header === 'object' && header !== null && 'affectedRows' in header
    ? Number((header as { affectedRows?: number }).affectedRows ?? 0)
    : 0;
}

export function normalizeSqlTimestamp(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const normalized = value.trim().replace(' ', 'T').replace(/\.(\d{3})\d+/, '.$1');
  const withZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(normalized) ? normalized : `${normalized}Z`;
  return new Date(withZone).toISOString();
}

function safeOpaqueReference(value: string): boolean {
  return /^[A-Za-z0-9:_-]{1,128}$/.test(value);
}

function routeKey(route: MetaWebhookResourceRoute): string {
  return `${route.tenantId}\0${route.appConfigurationId}\0${route.assetId}`;
}

export class MetaWebhookRepository {
  constructor(private readonly database: DurableWorkDatabase) {}

  async persist(input: {
    readonly application: MetaWebhookApplication;
    readonly items: readonly ParsedMetaWebhookItem[];
    readonly rawBody: Buffer;
    readonly payload: ProtectedMetaWebhookPayload;
    readonly receivedAt: Date;
  }): Promise<MetaWebhookPersistResult> {
    const uniqueItems = [...new Map(input.items.map((item) => [item.eventRef, item])).values()];
    const before = await this.findExisting(input.application, uniqueItems.map((item) => item.eventRef));
    const pending = uniqueItems.filter((item) => !before.has(item.eventRef));
    if (pending.length === 0) {
      return { received: input.items.length, inserted: 0, duplicate: input.items.length, quarantined: 0 };
    }

    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => {
      const current = await this.findExistingWithin(manager, input.application, pending.map((item) => item.eventRef));
      const newItems = pending.filter((item) => !current.has(item.eventRef));
      if (newItems.length === 0) {
        return { received: input.items.length, inserted: 0, duplicate: input.items.length, quarantined: 0 };
      }
      this.validateProtectedPayload(input.payload, input.receivedAt);
      await manager.query(
        `INSERT INTO ca_meta_webhook_deliveries
         (id, provider_app_id, environment, key_reference, nonce, authentication_tag, ciphertext,
          raw_sha256, received_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.payload.reference, input.application.providerAppId, input.application.environment,
          input.payload.keyReference, input.payload.nonce, input.payload.authenticationTag,
          input.payload.ciphertext, createHash('sha256').update(input.rawBody).digest(),
          mysqlDate(input.receivedAt.toISOString()), mysqlDate(input.payload.expiresAt),
        ],
      );

      let quarantined = 0;
      let inserted = 0;
      let duplicates = input.items.length - newItems.length;
      for (const item of newItems) {
        const resolution = await this.resolveAssetRouteWithin(manager, input.application, item);
        const route = resolution.kind === 'ROUTED' ? resolution.route : undefined;
        const routeState = route ? 'ROUTED' : 'QUARANTINED';
        const eventId = randomUUID();
        await manager.query(
          `INSERT INTO ca_meta_webhook_events
           (id, provider_app_id, environment, event_ref, event_type, object_type, field_name,
            item_identity_hash, payload_hash, delivery_id, item_locator_json, tenant_id,
            app_configuration_id, asset_id, route_state, process_state, quarantine_reason,
            attempt, lease_version, received_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
           ON DUPLICATE KEY UPDATE id = id`,
          [
            eventId, input.application.providerAppId, input.application.environment,
            item.eventRef, item.eventType, item.object, item.field,
            Buffer.from(item.eventRef, 'hex'), Buffer.from(item.eventRef, 'hex'), input.payload.reference,
            JSON.stringify(item.locator), route?.tenantId ?? null, route?.appConfigurationId ?? null,
            route?.assetId ?? null, routeState, route ? 'PENDING' : 'BLOCKED',
            route ? null : resolution.kind === 'MISSING_REFERENCE' ? 'RESOURCE_REFERENCE_MISSING' :
              resolution.kind === 'CONFLICTING' ? 'CONFLICTING_ASSET_OWNER' : 'UNKNOWN_ASSET',
            mysqlDate(input.receivedAt.toISOString()),
          ],
        );
        const durableIdentity = await manager.query(
          `SELECT id, event_ref FROM ca_meta_webhook_events
           WHERE provider_app_id = ? AND environment = ? AND item_identity_hash = ? FOR UPDATE`,
          [input.application.providerAppId, input.application.environment, Buffer.from(item.eventRef, 'hex')],
        ) as Array<{ id: string; event_ref: string }>;
        if (durableIdentity.length !== 1 || durableIdentity[0]?.event_ref !== item.eventRef) {
          throw new Error('Meta webhook item identity insert conflicted with a different row.');
        }
        if (durableIdentity[0]?.id === eventId) {
          inserted += 1;
          if (!route) quarantined += 1;
          continue;
        }
        // A concurrent delivery may have committed the same per-item key while this transaction waited
        // on the unique index. ACK only when that exact identity is now durable.
        duplicates += 1;
      }
      if (inserted === 0) {
        await manager.query('DELETE FROM ca_meta_webhook_deliveries WHERE id = ?', [input.payload.reference]);
      }
      return { received: input.items.length, inserted, duplicate: duplicates, quarantined };
    });
  }

  async claimNext(workerRef: string, leaseMs = 30_000): Promise<ClaimedMetaWebhookItem | null> {
    if (!safeOpaqueReference(workerRef) || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
      throw new RangeError('Invalid Meta webhook worker lease.');
    }
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => {
      const rows = await manager.query(
        `SELECT event.id, event.event_ref, event.event_type, event.tenant_id,
                event.app_configuration_id, event.asset_id, event.attempt,
                event.lease_version, event.item_locator_json, delivery.id AS payload_reference,
                delivery.key_reference, delivery.nonce, delivery.authentication_tag,
                delivery.ciphertext, delivery.expires_at
         FROM ca_meta_webhook_events event
         INNER JOIN ca_meta_webhook_deliveries delivery ON delivery.id = event.delivery_id
         WHERE event.route_state = 'ROUTED'
           AND (event.process_state IN ('PENDING', 'RETRY_PENDING')
             OR (event.process_state = 'RUNNING' AND event.lease_until < UTC_TIMESTAMP(6)))
           AND (event.next_attempt_at IS NULL OR event.next_attempt_at <= UTC_TIMESTAMP(6))
         ORDER BY event.received_at, event.id LIMIT 1 FOR UPDATE`,
      ) as MetaWebhookEventRow[];
      const row = rows[0];
      if (!row) return null;
      const leaseVersion = Number(row.lease_version) + 1;
      const nextAttempt = Number(row.attempt) + 1;
      await manager.query(
        `UPDATE ca_meta_webhook_events SET process_state = 'RUNNING', attempt = ?, lease_owner = ?,
           lease_version = ?, lease_until = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? MICROSECOND),
           updated_at = UTC_TIMESTAMP(6)
         WHERE id = ?`,
        [nextAttempt, workerRef, leaseVersion, leaseMs * 1_000, row.id],
      );
      return {
        id: row.id,
        eventRef: row.event_ref,
        eventType: row.event_type,
        tenantId: row.tenant_id as string,
        appConfigurationId: row.app_configuration_id as string,
        assetId: row.asset_id as string,
        attempt: nextAttempt,
        leaseVersion,
        payload: {
          reference: row.payload_reference as string,
          keyReference: row.key_reference as string,
          nonce: Buffer.from(row.nonce as Buffer),
          authenticationTag: Buffer.from(row.authentication_tag as Buffer),
          ciphertext: Buffer.from(row.ciphertext as Buffer),
          expiresAt: normalizeSqlTimestamp(row.expires_at as string | Date),
        },
        locator: JSON.parse(row.item_locator_json) as ParsedMetaWebhookItem['locator'],
      };
    });
  }

  async finalize(input: {
    readonly eventId: string;
    readonly workerRef: string;
    readonly leaseVersion: number;
    readonly state: 'PROCESSED' | 'RETRY_PENDING' | 'DEAD_LETTER';
    readonly safeErrorCode?: string;
  }): Promise<void> {
    if (input.safeErrorCode !== undefined && !/^[A-Z][A-Z0-9_]{0,63}$/.test(input.safeErrorCode)) {
      throw new Error('Meta webhook worker error code is not a safe identifier.');
    }
    const dataSource = await this.database.getDataSource();
    const result = await dataSource.query(
      `UPDATE ca_meta_webhook_events SET process_state = ?,
         lease_owner = NULL, lease_until = NULL, last_error_code = ?,
         next_attempt_at = CASE WHEN ? = 'RETRY_PENDING'
           THEN DATE_ADD(UTC_TIMESTAMP(6), INTERVAL LEAST(attempt, 8) SECOND) ELSE NULL END,
         updated_at = UTC_TIMESTAMP(6)
       WHERE id = ? AND process_state = 'RUNNING' AND lease_owner = ? AND lease_version = ?`,
      [input.state, input.safeErrorCode ?? null, input.state, input.eventId, input.workerRef, input.leaseVersion],
    );
    if (affectedRows(result) !== 1) throw new Error('Meta webhook lease was lost before finalization.');
  }

  async expireProtectedPayloads(): Promise<number> {
    const dataSource = await this.database.getDataSource();
    const result = await dataSource.query(
      `DELETE delivery FROM ca_meta_webhook_deliveries delivery
       WHERE delivery.expires_at <= UTC_TIMESTAMP(6)
         AND NOT EXISTS (
           SELECT 1 FROM ca_meta_webhook_events event
           WHERE event.delivery_id = delivery.id
             AND event.process_state IN ('PENDING', 'RUNNING', 'RETRY_PENDING')
         )`,
    );
    return affectedRows(result);
  }

  async getQuarantined(itemId: string): Promise<MetaWebhookEventRow | undefined> {
    const dataSource = await this.database.getDataSource();
    const rows = await dataSource.query(
      `SELECT event.id, event.provider_app_id, event.environment, event.delivery_id,
              event.item_locator_json, event.event_ref, event.event_type, event.tenant_id,
              event.app_configuration_id, event.asset_id, event.route_state, event.process_state,
              event.quarantine_reason, event.lease_owner, event.lease_version, event.attempt,
              delivery.key_reference, delivery.nonce, delivery.authentication_tag,
              delivery.ciphertext, delivery.expires_at
       FROM ca_meta_webhook_events event LEFT JOIN ca_meta_webhook_deliveries delivery
         ON delivery.id = event.delivery_id
       WHERE event.id = ? AND event.route_state = 'QUARANTINED'`, [itemId],
    ) as MetaWebhookEventRow[];
    return rows[0];
  }

  async replayQuarantined(input: {
    readonly item: MetaWebhookEventRow;
    readonly application: MetaWebhookApplication;
    readonly itemLocator: ParsedMetaWebhookItem;
    readonly actorRef: string;
    readonly caseRef: string;
  }): Promise<'ROUTED' | 'STILL_QUARANTINED'> {
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => {
      const resolution = await this.resolveAssetRouteWithin(manager, input.application, input.itemLocator);
      const route = resolution.kind === 'ROUTED' ? resolution.route : undefined;
      const nextState = route ? 'ROUTED' : 'QUARANTINED';
      const reason = route ? null : resolution.kind === 'MISSING_REFERENCE' ? 'RESOURCE_REFERENCE_MISSING' :
        resolution.kind === 'CONFLICTING' ? 'CONFLICTING_ASSET_OWNER' : 'UNKNOWN_ASSET';
      const updated = await manager.query(
        `UPDATE ca_meta_webhook_events SET tenant_id = ?, app_configuration_id = ?, asset_id = ?,
           route_state = ?, process_state = ?, quarantine_reason = ?, attempt = 0, lease_owner = NULL,
           lease_until = NULL, lease_version = lease_version + 1, next_attempt_at = NULL,
           updated_at = UTC_TIMESTAMP(6)
         WHERE id = ? AND route_state = 'QUARANTINED' AND process_state = 'BLOCKED'`,
        [route?.tenantId ?? null, route?.appConfigurationId ?? null, route?.assetId ?? null,
          nextState, route ? 'PENDING' : 'BLOCKED', reason, input.item.id],
      );
      if (affectedRows(updated) !== 1) throw new Error('Quarantined webhook item changed before replay.');
      await manager.query(
        `INSERT INTO ca_meta_webhook_replay_audit
         (id, webhook_event_id, actor_ref, case_ref, outcome, reason_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
        [randomUUID(), input.item.id, input.actorRef, input.caseRef, nextState, reason],
      );
      return route ? 'ROUTED' : 'STILL_QUARANTINED';
    });
  }

  async recordReplayUnavailable(input: {
    readonly eventId: string;
    readonly actorRef: string;
    readonly caseRef: string;
    readonly reasonCode: 'PAYLOAD_EXPIRED_OR_UNAVAILABLE' | 'APPLICATION_CONTEXT_UNAVAILABLE' | 'ITEM_IDENTITY_MISMATCH';
  }): Promise<void> {
    const dataSource = await this.database.getDataSource();
    await dataSource.transaction(async (manager) => {
      const rows = await manager.query(
        `SELECT id FROM ca_meta_webhook_events
         WHERE id = ? AND route_state = 'QUARANTINED' AND process_state = 'BLOCKED' FOR UPDATE`,
        [input.eventId],
      ) as Array<{ id: string }>;
      if (rows.length !== 1) throw new Error('Quarantined webhook item changed before replay audit.');
      await manager.query(
        `INSERT INTO ca_meta_webhook_replay_audit
         (id, webhook_event_id, actor_ref, case_ref, outcome, reason_code, created_at)
         VALUES (?, ?, ?, ?, 'QUARANTINED', ?, UTC_TIMESTAMP(6))`,
        [randomUUID(), input.eventId, input.actorRef, input.caseRef, input.reasonCode],
      );
    });
  }

  private validateProtectedPayload(payload: ProtectedMetaWebhookPayload, receivedAt: Date): void {
    if (!/^[0-9a-f-]{36}$/i.test(payload.reference) || !safeOpaqueReference(payload.keyReference) ||
        !Buffer.isBuffer(payload.nonce) || payload.nonce.length !== 12 ||
        !Buffer.isBuffer(payload.authenticationTag) || payload.authenticationTag.length !== 16 ||
        !Buffer.isBuffer(payload.ciphertext) ||
        payload.ciphertext.length < 1 || payload.ciphertext.length > 2 * 1024 * 1024 ||
        !Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) <= receivedAt.getTime()) {
      throw new Error('Protected webhook payload metadata is invalid.');
    }
  }

  private async findExisting(application: MetaWebhookApplication, eventRefs: readonly string[]): Promise<Set<string>> {
    const dataSource = await this.database.getDataSource();
    return this.findExistingWithin(dataSource.manager, application, eventRefs);
  }

  private async findExistingWithin(manager: EntityManager, application: MetaWebhookApplication,
    eventRefs: readonly string[]): Promise<Set<string>> {
    if (eventRefs.length === 0) return new Set();
    const placeholders = eventRefs.map(() => '?').join(', ');
    const rows = await manager.query(
      `SELECT event_ref FROM ca_meta_webhook_events
       WHERE provider_app_id = ? AND environment = ? AND item_identity_hash IN (${placeholders})`,
      [application.providerAppId, application.environment, ...eventRefs.map((ref) => Buffer.from(ref, 'hex'))],
    ) as Array<{ event_ref: string }>;
    return new Set(rows.map((row) => row.event_ref));
  }

  private async resolveAssetRouteWithin(manager: EntityManager, application: MetaWebhookApplication,
    item: Pick<ParsedMetaWebhookItem, 'resourceKinds' | 'resourceExternalId'>): Promise<AssetRouteResolution> {
    if (!item.resourceExternalId || item.resourceKinds.length === 0) return { kind: 'MISSING_REFERENCE' };
    const quarantinedClaims = await manager.query(
      `SELECT claim.id FROM ca_meta_asset_claim_quarantine claim
       INNER JOIN ca_meta_app_configurations app
         ON app.tenant_id = claim.tenant_id AND app.id = claim.app_configuration_id
        AND app.provider = claim.provider AND app.environment = claim.environment
       WHERE app.provider = 'META' AND app.app_external_id = ? AND app.environment = ?
         AND claim.asset_kind IN (${item.resourceKinds.map(() => '?').join(', ')})
         AND claim.external_id = ? LIMIT 1 FOR UPDATE`,
      [application.providerAppId, application.environment, ...item.resourceKinds, item.resourceExternalId],
    ) as Array<{ id: string }>;
    if (quarantinedClaims.length > 0) return { kind: 'CONFLICTING' };
    const rows = await manager.query(
      `SELECT asset.tenant_id, asset.app_configuration_id, asset.id AS asset_id
       FROM ca_meta_assets asset
       INNER JOIN ca_meta_app_configurations app
         ON app.tenant_id = asset.tenant_id AND app.id = asset.app_configuration_id
        AND app.provider = asset.provider AND app.environment = asset.environment
       INNER JOIN ca_meta_asset_authorizations asset_auth
         ON asset_auth.tenant_id = asset.tenant_id AND asset_auth.asset_id = asset.id
        AND asset_auth.app_configuration_id = asset.app_configuration_id
        AND asset_auth.provider = asset.provider AND asset_auth.environment = asset.environment
       INNER JOIN ca_meta_authorizations authorization
         ON authorization.tenant_id = asset_auth.tenant_id AND authorization.id = asset_auth.authorization_id
        AND authorization.app_configuration_id = asset_auth.app_configuration_id
        AND authorization.provider = asset_auth.provider AND authorization.environment = asset_auth.environment
       WHERE app.provider = 'META' AND app.app_external_id = ? AND app.environment = ?
         AND asset.asset_kind IN (${item.resourceKinds.map(() => '?').join(', ')})
         AND asset.external_id = ? AND asset_auth.state = 'ACTIVE'
         AND asset_auth.verification_state = 'VERIFIED' AND authorization.authorization_state = 'ACTIVE'
       FOR UPDATE`,
      [application.providerAppId, application.environment, ...item.resourceKinds, item.resourceExternalId],
    ) as AssetRouteRow[];
    const unique = new Map(rows.map((row) => {
      const route = { tenantId: row.tenant_id, appConfigurationId: row.app_configuration_id, assetId: row.asset_id };
      return [routeKey(route), route] as const;
    }));
    if (unique.size === 1) return { kind: 'ROUTED', route: [...unique.values()][0] as MetaWebhookResourceRoute };
    return { kind: unique.size === 0 ? 'UNKNOWN' : 'CONFLICTING' };
  }
}
