import { createHash, randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { OutboxService } from '../outbox/outbox-service.js';
import { AutomationConfigVersionConflictError, type AutomationConfigPatch, type AutomationConfigRepository, type AutomationConfigState } from './automation-config.types.js';

interface AutomationConfigRow {
  private_welcome_message: string | null;
  comment_public_reply: string | null;
  comment_private_reply: string | null;
  version: number | string;
  updated_at: string | Date | null;
  projection_state: AutomationConfigState['projectionState'];
}

const EMPTY_CONFIG: AutomationConfigState = Object.freeze({
  privateWelcomeMessage: null,
  commentPublicReply: null,
  commentPrivateReply: null,
  version: 0,
  updatedAt: null,
  projectionState: 'UNKNOWN',
});

function isRecordAffected(result: unknown, expected: number): boolean {
  const header = Array.isArray(result) ? result[0] : result;
  return typeof header === 'object' && header !== null && 'affectedRows' in header &&
    Number((header as { affectedRows?: number }).affectedRows ?? 0) === expected;
}

function sqlTimestamp(value: string): string {
  return `${value.slice(0, 19).replace('T', ' ')}.${value.slice(20, 23)}000`;
}

function formatTimestamp(value: string | Date | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function fromRow(row: AutomationConfigRow | undefined): AutomationConfigState {
  if (!row) return EMPTY_CONFIG;
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 0) throw new Error('Automation configuration version is outside the supported range.');
  return Object.freeze({
    privateWelcomeMessage: row.private_welcome_message,
    commentPublicReply: row.comment_public_reply,
    commentPrivateReply: row.comment_private_reply,
    version,
    updatedAt: formatTimestamp(row.updated_at),
    projectionState: row.projection_state,
  });
}

function actorHash(actorId: string): string {
  return createHash('sha256').update(`automation-config-actor\0${actorId}`, 'utf8').digest('hex');
}

export class MysqlAutomationConfigRepository implements AutomationConfigRepository {
  constructor(private readonly database: DurableWorkDatabase, private readonly outbox: OutboxService) {}

  async read(input: { readonly tenantId: string; readonly assetId: string }): Promise<AutomationConfigState> {
    const dataSource = await this.database.getDataSource();
    const rows = await dataSource.query(
      `SELECT private_welcome_message, comment_public_reply, comment_private_reply, version, updated_at, projection_state
       FROM ca_meta_asset_automation_configs WHERE tenant_id = ? AND asset_id = ? LIMIT 1`,
      [input.tenantId, input.assetId],
    ) as AutomationConfigRow[];
    return fromRow(rows[0]);
  }

  async update(input: {
    readonly tenantId: string;
    readonly assetId: string;
    readonly actorId: string;
    readonly requestId: string;
    readonly patch: AutomationConfigPatch;
  }): Promise<AutomationConfigState> {
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => this.updateWithin(manager, input));
  }

  private async updateWithin(manager: EntityManager, input: {
    readonly tenantId: string;
    readonly assetId: string;
    readonly actorId: string;
    readonly requestId: string;
    readonly patch: AutomationConfigPatch;
  }): Promise<AutomationConfigState> {
    const now = new Date().toISOString();
    const timestamp = sqlTimestamp(now);
    await manager.query(
      `INSERT IGNORE INTO ca_meta_asset_automation_configs
       (tenant_id, asset_id, private_welcome_message, comment_public_reply, comment_private_reply,
        version, projection_state, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, NULL, 0, 'UNKNOWN', ?, NULL)`,
      [input.tenantId, input.assetId, timestamp],
    );
    const rows = await manager.query(
      `SELECT private_welcome_message, comment_public_reply, comment_private_reply, version, updated_at, projection_state
       FROM ca_meta_asset_automation_configs WHERE tenant_id = ? AND asset_id = ? FOR UPDATE`,
      [input.tenantId, input.assetId],
    ) as AutomationConfigRow[];
    const current = fromRow(rows[0]);
    if (!rows[0] || current.version !== input.patch.version || current.version >= Number.MAX_SAFE_INTEGER) {
      throw new AutomationConfigVersionConflictError();
    }
    const nextVersion = current.version + 1;
    const next = Object.freeze({
      privateWelcomeMessage: input.patch.privateWelcomeMessage === undefined ? current.privateWelcomeMessage : input.patch.privateWelcomeMessage || null,
      commentPublicReply: input.patch.commentPublicReply === undefined ? current.commentPublicReply : input.patch.commentPublicReply || null,
      commentPrivateReply: input.patch.commentPrivateReply === undefined ? current.commentPrivateReply : input.patch.commentPrivateReply || null,
      version: nextVersion,
      updatedAt: now,
      projectionState: 'PENDING' as const,
    });
    const updateResult = await manager.query(
      `UPDATE ca_meta_asset_automation_configs
       SET private_welcome_message = ?, comment_public_reply = ?, comment_private_reply = ?,
           version = ?, projection_state = 'PENDING', updated_at = ?
       WHERE tenant_id = ? AND asset_id = ? AND version = ?`,
      [next.privateWelcomeMessage, next.commentPublicReply, next.commentPrivateReply, nextVersion, timestamp,
        input.tenantId, input.assetId, current.version],
    );
    if (!isRecordAffected(updateResult, 1)) {
      throw new AutomationConfigVersionConflictError();
    }
    const changedByHash = actorHash(input.actorId);
    const changedFields = ['privateWelcomeMessage', 'commentPublicReply', 'commentPrivateReply']
      .filter((field) => Object.prototype.hasOwnProperty.call(input.patch, field));
    await manager.query(
      `INSERT INTO ca_meta_asset_automation_config_versions
       (tenant_id, asset_id, version, changed_fields_json, actor_ref_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.tenantId, input.assetId, nextVersion, JSON.stringify(changedFields), changedByHash, timestamp],
    );
    await this.outbox.appendWithin(manager, {
      eventId: `automation-config:${input.assetId}:${nextVersion}`,
      tenantRef: input.tenantId,
      schemaVersion: 1,
      eventType: 'automation.config.changed',
      aggregateRef: input.assetId,
      aggregateVersion: nextVersion,
      actor: { kind: 'USER', ref: input.actorId },
      correlationId: input.requestId,
      causationId: input.requestId,
      createdAt: now,
      enqueuedAt: now,
      data: { kind: 'AUTOMATION_CONFIG_CHANGED', assetRef: input.assetId, configurationVersion: nextVersion },
    });
    return next;
  }
}
