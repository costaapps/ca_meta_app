import { createHash, randomUUID } from 'node:crypto';
import type { components } from '@ca-meta/contracts';
import { IdentityDeniedError } from '../identity/identity.errors.js';
import { isVerifiedPortalSession, type VerifiedPortalSession } from '../identity/identity.trust.js';
import { isVerifiedServiceTenantScope, ServiceTenantAuthorizationService, TenantAuthorizationService, TenantContextService,
} from '../identity/identity.service.js';
import type { AuthorizedTenantScope, VerifiedServiceTenantScope } from '../identity/identity.types.js';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { DurableJobStore } from '../jobs/job-store.js';
import { canonicalJson } from '../jobs/event-validation.js';

export class NotificationNotFoundError extends Error {
  constructor(message = 'Notification is unavailable in the authorized tenant context.') {
    super(message);
    this.name = 'NotificationNotFoundError';
  }
}
export class NotificationInputError extends Error {}
export class NotificationIdempotencyConflictError extends Error {}
export class NotificationActionUnresolvedError extends Error {}
export class NotificationExternalActionUnavailableError extends Error {}

type Notification = components['schemas']['Notification'];
type NotificationAction = components['schemas']['NotificationActionRequest'];
type NotificationPage = components['schemas']['NotificationListPage'];
type ActionResult = components['schemas']['NotificationActionResult'];
type ActionAccepted = components['schemas']['NotificationActionAccepted'];

interface NotificationRow {
  id: string;
  kind: Notification['kind'];
  asset_id: string;
  message_ref: string | null;
  status: Notification['status'];
  created_at: string | Date;
}

interface ActionReceiptRow {
  id: string;
  notification_id: string;
  action: string;
  request_hash: Buffer | string;
  operation_id: string | null;
  status: string;
}

interface Cursor { createdAt: string; id: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_KIND_SUMMARY: Readonly<Record<string, string>> = Object.freeze({
  MESSAGE_RECEIVED: 'A new WhatsApp message is available.',
  COMMENT_RECEIVED: 'A new comment is available.',
  ASSET_STATUS_CHANGED: 'An account status changed.',
  ACTION_REQUIRED: 'A connection needs your attention.',
});

function digest(value: string): Buffer { return createHash('sha256').update(value, 'utf8').digest(); }
function hex(value: Buffer | string): string { return Buffer.isBuffer(value) ? value.toString('hex') : value.toLowerCase(); }
function cursorDate(value: string | Date): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Stored notification timestamp is invalid.');
  return parsed.toISOString();
}
function encodeCursor(value: Cursor): string { return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'); }
function decodeCursor(value: string | undefined): Cursor | undefined {
  if (value === undefined) return undefined;
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new NotificationInputError();
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    const date = new Date(String(decoded['createdAt']));
    const id = decoded['id'];
    if (!Number.isFinite(date.getTime()) || typeof id !== 'string' || !CURSOR_ID.test(id)) throw new Error();
    return { createdAt: date.toISOString(), id };
  } catch { throw new NotificationInputError(); }
}

function requiredId(value: string): string {
  if (!UUID.test(value)) throw new NotificationNotFoundError();
  return value;
}

export class NotificationsService {
  constructor(
    private readonly database: DurableWorkDatabase,
    private readonly contexts: TenantContextService,
    private readonly authorization: TenantAuthorizationService,
    private readonly serviceAuthorization: ServiceTenantAuthorizationService,
    private readonly jobs?: DurableJobStore,
    private readonly externalActionsEnabled = false,
  ) {}

  async list(session: VerifiedPortalSession, contextRef: string, limit: number, rawCursor: string | undefined,
    requestId: string): Promise<NotificationPage> {
    const scope = await this.portalScope(session, contextRef);
    await this.authorization.authorize(scope, 'RESOURCE_READ', scope.tenantId);
    const cursor = decodeCursor(rawCursor);
    const pageSize = Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : 50;
    const database = await this.database.getDataSource();
    const rows = await database.query(
      `SELECT id, kind, asset_id, message_ref, status, created_at
       FROM ca_meta_notifications
       WHERE tenant_id = ? AND status <> 'DISMISSED'
         AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      [scope.tenantId, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, pageSize + 1],
    ) as NotificationRow[];
    const hasNext = rows.length > pageSize;
    const visible = rows.slice(0, pageSize);
    const items = visible.map((row) => Object.freeze({
      id: row.id,
      kind: row.kind,
      assetRef: row.asset_id,
      messageRef: row.message_ref,
      status: row.status,
      safeSummary: SAFE_KIND_SUMMARY[row.kind] ?? 'A notification is available.',
      createdAt: cursorDate(row.created_at),
      actions: Object.freeze([
        ...(row.status === 'UNREAD' ? ['MARK_READ' as const] : []),
        'DISMISS' as const,
      ]),
    }));
    const last = items.at(-1);
    return Object.freeze({ items: Object.freeze(items), nextCursor: hasNext && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null, requestId });
  }

  async act(session: VerifiedPortalSession, contextRef: string, notificationId: string, idempotencyKey: string,
    action: NotificationAction, requestId: string): Promise<ActionResult | ActionAccepted> {
    const scope = await this.portalScope(session, contextRef);
    const notificationRef = requiredId(notificationId);
    if (!/^[A-Za-z0-9._~-]{16,128}$/.test(idempotencyKey)) throw new NotificationInputError();
    const database = await this.database.getDataSource();
    const keyHash = digest(`${scope.tenantId}\0${idempotencyKey}`);
    const requestHash = digest(canonicalJson(action));

    if (action.action === 'SEND_MESSAGE') {
      await this.authorization.authorize(scope, 'CONNECT', scope.tenantId);
      throw new NotificationExternalActionUnavailableError();
    }
    if (action.action === 'SEND_TEMPLATE' || action.action === 'REPLY_COMMENT') {
      await this.authorization.authorize(scope, 'CONNECT', scope.tenantId);
      if (!this.jobs || !this.externalActionsEnabled) throw new NotificationExternalActionUnavailableError();
      return await this.queueExternalAction({ scope, notificationId: notificationRef,
        keyHash, requestHash, action, requestId });
    }
    await this.authorization.authorize(scope, 'RESOURCE_READ', scope.tenantId);

    return database.transaction(async (manager) => {
      const notification = await manager.query(
        `SELECT id, status FROM ca_meta_notifications WHERE id = ? AND tenant_id = ? FOR UPDATE`,
        [notificationRef, scope.tenantId],
      ) as Array<{ id: string; status: 'UNREAD' | 'READ' | 'DISMISSED' }>;
      const current = notification[0];
      if (!current) throw new NotificationNotFoundError();

      await manager.query(
        `INSERT IGNORE INTO ca_meta_notification_action_receipts
          (id, tenant_id, notification_id, action, idempotency_key_hash, request_hash, operation_id, status, safe_error_code, actor_ref_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'PENDING', NULL, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
        [randomUUID(), scope.tenantId, notificationRef, action.action, keyHash, requestHash, digest(scope.principalId)],
      );
      const receiptRows = await manager.query(
        `SELECT id, notification_id, action, request_hash, operation_id, status
         FROM ca_meta_notification_action_receipts WHERE tenant_id = ? AND idempotency_key_hash = ? FOR UPDATE`,
        [scope.tenantId, keyHash],
      ) as ActionReceiptRow[];
      const receipt = receiptRows[0];
      if (!receipt || receipt.notification_id !== notificationRef || receipt.action !== action.action || hex(receipt.request_hash) !== requestHash.toString('hex')) {
        throw new NotificationIdempotencyConflictError();
      }
      if (receipt.status === 'SUCCEEDED') {
        const latest = await manager.query(
          `SELECT status FROM ca_meta_notifications WHERE id = ? AND tenant_id = ?`, [notificationRef, scope.tenantId],
        ) as Array<{ status: 'READ' | 'DISMISSED' | 'UNREAD' }>;
        return Object.freeze({ notificationId: notificationRef, action: action.action,
          status: latest[0]?.status === 'DISMISSED' ? 'DISMISSED' : 'READ', requestId });
      }
      const target = action.action === 'MARK_READ' ? (current.status === 'DISMISSED' ? 'DISMISSED' : 'READ') : 'DISMISSED';
      await manager.query(
        `UPDATE ca_meta_notifications SET status = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ? AND tenant_id = ?`,
        [target, notificationRef, scope.tenantId],
      );
      await manager.query(
        `UPDATE ca_meta_notification_action_receipts SET status = 'SUCCEEDED', updated_at = UTC_TIMESTAMP(6) WHERE id = ? AND tenant_id = ?`,
        [receipt.id, scope.tenantId],
      );
      return Object.freeze({ notificationId: notificationRef, action: action.action, status: target, requestId });
    });
  }

  private async queueExternalAction(input: {
    readonly scope: AuthorizedTenantScope;
    readonly notificationId: string;
    readonly keyHash: Buffer;
    readonly requestHash: Buffer;
    readonly action: Extract<NotificationAction, { action: 'SEND_TEMPLATE' | 'REPLY_COMMENT' }>;
    readonly requestId: string;
  }): Promise<ActionAccepted> {
    const database = await this.database.getDataSource();
    return await database.transaction(async (manager) => {
      const targets = await manager.query(
        `SELECT n.id, n.kind, n.status AS notification_status, a.id AS asset_id,
                a.app_configuration_id, a.environment, a.asset_kind
         FROM ca_meta_notifications n JOIN ca_meta_assets a
           ON a.tenant_id = n.tenant_id AND a.id = n.asset_id
         WHERE n.id = ? AND n.tenant_id = ? FOR UPDATE`,
        [input.notificationId, input.scope.tenantId],
      ) as Array<{ id: string; kind: string; notification_status: string; asset_id: string; app_configuration_id: string; environment: string; asset_kind: string }>;
      const target = targets[0];
      if (!target || !UUID.test(target.asset_id) || !UUID.test(target.app_configuration_id) ||
          !['development', 'test', 'staging', 'production'].includes(target.environment)) {
        throw new NotificationNotFoundError('Notification target is unavailable in the authorized tenant context.');
      }
      if ((input.action.action === 'SEND_TEMPLATE' && target.asset_kind !== 'WHATSAPP_PHONE_NUMBER') ||
          (input.action.action === 'REPLY_COMMENT' && (target.kind !== 'COMMENT_RECEIVED' ||
            !['FACEBOOK_PAGE', 'INSTAGRAM_BUSINESS_ACCOUNT', 'INSTAGRAM_CREATOR_ACCOUNT'].includes(target.asset_kind)))) {
        throw new NotificationNotFoundError('Notification action is unavailable for this asset.');
      }
      await manager.query(
        `INSERT IGNORE INTO ca_meta_notification_action_receipts
          (id, tenant_id, notification_id, action, idempotency_key_hash, request_hash, operation_id, status, safe_error_code, actor_ref_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'PENDING', NULL, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
        [randomUUID(), input.scope.tenantId, input.notificationId, input.action.action,
          input.keyHash, input.requestHash, digest(input.scope.principalId)],
      );
      const receipts = await manager.query(
        `SELECT id, notification_id, action, request_hash, operation_id, status
         FROM ca_meta_notification_action_receipts WHERE tenant_id = ? AND idempotency_key_hash = ? FOR UPDATE`,
        [input.scope.tenantId, input.keyHash],
      ) as ActionReceiptRow[];
      const receipt = receipts[0];
      if (!receipt || receipt.notification_id !== input.notificationId || receipt.action !== input.action.action ||
          hex(receipt.request_hash) !== input.requestHash.toString('hex')) throw new NotificationIdempotencyConflictError();
      if (!receipt.operation_id && target.notification_status !== 'UNREAD') {
        throw new NotificationNotFoundError('Notification is not unread in the authorized tenant context.');
      }
      if (!receipt.operation_id) {
        const unresolved = await manager.query(
          `SELECT id FROM ca_meta_notification_action_receipts
           WHERE tenant_id = ? AND notification_id = ?
             AND id <> ? AND action IN ('SEND_TEMPLATE', 'REPLY_COMMENT') AND status IN ('PENDING', 'RUNNING', 'UNKNOWN')
           LIMIT 1 FOR UPDATE`,
          [input.scope.tenantId, input.notificationId, receipt.id],
        ) as Array<{ id: string }>;
        if (unresolved.length > 0) throw new NotificationActionUnresolvedError();
        const queued = await this.jobs!.enqueueWithin(manager, {
          tenantId: input.scope.tenantId,
          type: 'NOTIFICATION_ACTION',
          idempotencyKey: input.keyHash.toString('hex'),
          correlationId: input.requestId,
          resourceScopeRef: input.notificationId,
          payload: {
            kind: 'NOTIFICATION_ACTION', notificationId: input.notificationId,
            assetId: target.asset_id, appConfigurationId: target.app_configuration_id,
            environment: target.environment, request: input.action,
          },
        });
        await manager.query(
          `UPDATE ca_meta_notification_action_receipts SET operation_id = ?, updated_at = UTC_TIMESTAMP(6)
           WHERE id = ? AND tenant_id = ?`, [queued.id, receipt.id, input.scope.tenantId],
        );
        return Object.freeze({ notificationId: input.notificationId, operationId: queued.id, status: 'PENDING',
          location: `/api/v1/operations/${queued.id}`, requestId: input.requestId });
      }
      const status = receipt.status === 'RUNNING' || receipt.status === 'SUCCEEDED' || receipt.status === 'FAILED' || receipt.status === 'UNKNOWN'
        ? receipt.status : 'PENDING';
      return Object.freeze({ notificationId: input.notificationId, operationId: receipt.operation_id, status,
        location: `/api/v1/operations/${receipt.operation_id}`, requestId: input.requestId });
    });
  }

  async operation(session: VerifiedPortalSession, contextRef: string, operationId: string,
    requestId: string): Promise<components['schemas']['OperationStatus'] | undefined> {
    const scope = await this.portalScope(session, contextRef);
    await this.authorization.authorize(scope, 'RESOURCE_READ', scope.tenantId);
    if (!UUID.test(operationId)) return undefined;
    const database = await this.database.getDataSource();
    const rows = await database.query(
      `SELECT j.id, r.action, j.status, j.updated_at
       FROM ca_meta_notification_action_receipts r
       JOIN ca_meta_jobs j ON j.tenant_id = r.tenant_id AND j.id = r.operation_id
       WHERE r.tenant_id = ? AND r.operation_id = ? LIMIT 1`,
      [scope.tenantId, operationId],
    ) as Array<{ id: string; action: string; status: string; updated_at: string | Date }>;
    const row = rows[0];
    if (!row) return undefined;
    const status: components['schemas']['OperationStatus']['status'] = row.status === 'QUEUED' || row.status === 'RETRY_PENDING' ? 'PENDING'
      : row.status === 'RUNNING' ? 'RUNNING' : row.status === 'SUCCEEDED' ? 'SUCCEEDED'
      : row.status === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED';
    return Object.freeze({
      id: row.id,
      kind: row.action,
      status,
      requestId,
      updatedAt: cursorDate(row.updated_at),
      nextAction: status === 'PENDING' || status === 'RUNNING' ? 'WAIT' : status === 'UNKNOWN' ? 'CHECK_STATUS' : 'NONE',
    });
  }

  /** Trusted server projection entry point. Summaries are selected from a fixed allowlist. */
  async recordProjection(scope: VerifiedServiceTenantScope, input: {
    readonly id: string; readonly assetId: string; readonly sourceEventRef: string;
    readonly kind: keyof typeof SAFE_KIND_SUMMARY; readonly providerTargetRef?: string; readonly messageRef?: string;
  }): Promise<void> {
    if (!isVerifiedServiceTenantScope(scope) || !UUID.test(input.id) || !UUID.test(input.assetId) || !input.sourceEventRef ||
        input.sourceEventRef.length > 512 || !Object.hasOwn(SAFE_KIND_SUMMARY, input.kind) ||
        (input.messageRef !== undefined && !UUID.test(input.messageRef)) ||
        (input.providerTargetRef !== undefined && !/^[A-Za-z0-9._:-]{1,191}$/.test(input.providerTargetRef))) throw new IdentityDeniedError();
    await this.serviceAuthorization.authorize(scope, 'TENANT_RESOURCE_READ', scope.tenantId);
    const database = await this.database.getDataSource();
    await database.query(
      `INSERT IGNORE INTO ca_meta_notifications
        (id, tenant_id, asset_id, kind, message_ref, provider_target_ref, source_event_hash, status, safe_summary, created_at, updated_at)
       SELECT ?, a.tenant_id, a.id, ?, ?, ?, ?, 'UNREAD', ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)
       FROM ca_meta_assets a WHERE a.tenant_id = ? AND a.id = ?`,
      [input.id, input.kind, input.messageRef ?? null, input.providerTargetRef ?? null,
        digest(input.sourceEventRef), SAFE_KIND_SUMMARY[input.kind], scope.tenantId, input.assetId],
    );
  }

  private async portalScope(session: VerifiedPortalSession, contextRef: string) {
    if (!isVerifiedPortalSession(session)) throw new IdentityDeniedError();
    return this.contexts.resolveCurrent(session, contextRef);
  }
}
