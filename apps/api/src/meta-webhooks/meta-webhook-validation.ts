import { createHash } from 'node:crypto';
import { canonicalJson } from '../jobs/event-validation.js';

export const META_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
export const META_WEBHOOK_MAX_ENTRIES = 100;
export const META_WEBHOOK_MAX_CHANGES_PER_ENTRY = 100;
export const META_WEBHOOK_MAX_ITEMS = 500;
export const META_WEBHOOK_SCHEMA_VERSION = 1 as const;
export const META_WEBHOOK_APP_CONFIG_REF_PATTERN = /^[A-Za-z0-9._-]{1,96}$/;
export const META_WEBHOOK_RAW_POST_PATH = /^\/api\/v1\/webhooks\/meta\/[A-Za-z0-9._-]{1,96}$/;

export class MetaWebhookPayloadValidationError extends Error {
  constructor() { super('Meta webhook payload failed validation.'); }
}

export type MetaWebhookResourceKind =
  | 'WHATSAPP_PHONE_NUMBER'
  | 'WHATSAPP_BUSINESS_ACCOUNT'
  | 'FACEBOOK_PAGE'
  | 'INSTAGRAM_BUSINESS_ACCOUNT'
  | 'INSTAGRAM_CREATOR_ACCOUNT';

export interface MetaWebhookItemLocator {
  readonly entryIndex: number;
  readonly changeIndex: number;
  readonly nestedKind: 'change' | 'messages' | 'statuses' | 'messaging';
  readonly nestedIndex: number;
}

export interface ParsedMetaWebhookItem {
  readonly schemaVersion: typeof META_WEBHOOK_SCHEMA_VERSION;
  readonly eventRef: string;
  readonly eventKey: string;
  readonly eventType: string;
  readonly object: string;
  readonly field: string;
  readonly providerTimestamp: string | null;
  readonly providerMessageId: string | null;
  readonly providerStatus: string | null;
  readonly providerStatusRank: number | null;
  readonly resourceKinds: readonly MetaWebhookResourceKind[];
  readonly resourceExternalId: string | null;
  readonly locator: MetaWebhookItemLocator;
}

export interface ParsedMetaWebhookDelivery {
  readonly schemaVersion: typeof META_WEBHOOK_SCHEMA_VERSION;
  readonly object: 'whatsapp_business_account' | 'page' | 'instagram';
  readonly items: readonly ParsedMetaWebhookItem[];
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function objectId(value: unknown): string | null {
  return boundedText(value, 512) && /^[A-Za-z0-9._:-]+$/.test(value) ? value : null;
}

/** Meta item timestamps are Unix seconds or milliseconds; unknown representations stay absent. */
function providerTimestamp(item: JsonRecord): string | null {
  const raw = item.timestamp;
  if (typeof raw !== 'string' || !/^\d{1,16}(?:\.\d{1,6})?$/.test(raw)) return null;
  const numeric = Number(raw);
  const milliseconds = numeric < 100_000_000_000 ? numeric * 1_000 : numeric;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Tie-breaking for known WhatsApp delivery progress; unknown terminal states are deliberately ambiguous. */
export function metaWebhookStatusRank(value: string): number | null {
  switch (value.toLowerCase()) {
    case 'sent': return 10;
    case 'delivered': return 20;
    case 'read': return 30;
    case 'played': return 40;
    default: return null;
  }
}

export type MetaWebhookStatusOrder = 'OLDER' | 'SAME' | 'NEWER' | 'AMBIGUOUS';

export function compareMetaWebhookStatusOrder(input: {
  readonly timestamp: string; readonly status: string; readonly rank: number | null;
}, current: {
  readonly timestamp: string; readonly status: string; readonly rank: number | null;
}): MetaWebhookStatusOrder {
  const incomingTime = Date.parse(input.timestamp);
  const currentTime = Date.parse(current.timestamp);
  if (!Number.isFinite(incomingTime) || !Number.isFinite(currentTime) || input.rank === null || current.rank === null) {
    return 'AMBIGUOUS';
  }
  if (incomingTime < currentTime) return 'OLDER';
  if (input.status === current.status) return 'SAME';
  if (input.rank < current.rank) return 'OLDER';
  if (incomingTime > currentTime && input.rank > current.rank) return 'NEWER';
  if (incomingTime > currentTime) return 'AMBIGUOUS';
  if (input.rank > current.rank) return 'NEWER';
  return 'AMBIGUOUS';
}

function safeEventType(object: string, field: string): string {
  const token = `${object}.${field}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '_').slice(0, 48);
  return `meta.webhook.${token}`;
}

function stableItemHash(parts: readonly unknown[]): string {
  return createHash('sha256').update(canonicalJson(parts), 'utf8').digest('hex');
}

const WHATSAPP_ACCOUNT_LEVEL_FIELDS = new Set(['account_update']);

function resourceFor(
  object: string,
  entryId: unknown,
  value: JsonRecord,
  item: JsonRecord,
  field: string,
  nestedKind: MetaWebhookItemLocator['nestedKind'],
): { readonly kinds: readonly MetaWebhookResourceKind[]; readonly externalId: string | null } {
  if (object === 'whatsapp_business_account') {
    if (nestedKind === 'change' && WHATSAPP_ACCOUNT_LEVEL_FIELDS.has(field)) {
      return { kinds: ['WHATSAPP_BUSINESS_ACCOUNT'], externalId: objectId(entryId) };
    }
    if (field === 'history' || field === 'smb_message_echoes') {
      if (nestedKind !== 'messages' && nestedKind !== 'statuses') return { kinds: [], externalId: null };
      const phoneId = objectId(item.phone_number_id);
      if (phoneId) return { kinds: ['WHATSAPP_PHONE_NUMBER'], externalId: phoneId };
      return { kinds: [], externalId: null };
    }
    if (field === 'smb_app_state_sync') return { kinds: [], externalId: null };
    const metadata = isRecord(value.metadata) ? value.metadata : undefined;
    const phoneId = objectId(metadata?.phone_number_id);
    if (phoneId) return { kinds: ['WHATSAPP_PHONE_NUMBER'], externalId: phoneId };
    return { kinds: [], externalId: null };
  }
  if (object === 'page') {
    return { kinds: ['FACEBOOK_PAGE'], externalId: objectId(entryId) };
  }
  if (object === 'instagram') {
    return { kinds: ['INSTAGRAM_BUSINESS_ACCOUNT', 'INSTAGRAM_CREATOR_ACCOUNT'], externalId: objectId(entryId) };
  }
  return { kinds: [], externalId: null };
}

function decodeRawBody(rawBody: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
  } catch {
    throw new MetaWebhookPayloadValidationError();
  }
}

function assertJsonComplexity(root: unknown): void {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: root, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    visited += 1;
    if (visited > 20_000 || current.depth > 32) throw new MetaWebhookPayloadValidationError();
    if (Array.isArray(current.value)) {
      for (const value of current.value) pending.push({ value, depth: current.depth + 1 });
    } else if (isRecord(current.value)) {
      for (const value of Object.values(current.value)) pending.push({ value, depth: current.depth + 1 });
    }
  }
}

export function parseMetaWebhookDelivery(rawBody: Buffer): ParsedMetaWebhookDelivery {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > META_WEBHOOK_MAX_BODY_BYTES) {
    throw new MetaWebhookPayloadValidationError();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeRawBody(rawBody)) as unknown;
  } catch {
    throw new MetaWebhookPayloadValidationError();
  }
  assertJsonComplexity(decoded);
  if (!isRecord(decoded) || !['whatsapp_business_account', 'page', 'instagram'].includes(String(decoded.object)) ||
      !Array.isArray(decoded.entry) || decoded.entry.length < 1 || decoded.entry.length > META_WEBHOOK_MAX_ENTRIES) {
    throw new MetaWebhookPayloadValidationError();
  }

  const object = decoded.object as ParsedMetaWebhookDelivery['object'];
  const items: ParsedMetaWebhookItem[] = [];
  for (let entryIndex = 0; entryIndex < decoded.entry.length; entryIndex += 1) {
    const entry = decoded.entry[entryIndex];
    if (!isRecord(entry) || !objectId(entry.id)) throw new MetaWebhookPayloadValidationError();
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];
    if (changes.length > META_WEBHOOK_MAX_CHANGES_PER_ENTRY || messaging.length > META_WEBHOOK_MAX_CHANGES_PER_ENTRY ||
        (changes.length === 0 && messaging.length === 0)) throw new MetaWebhookPayloadValidationError();

    const pushItem = (input: {
      readonly field: string;
      readonly value: JsonRecord;
      readonly item: JsonRecord;
      readonly locator: MetaWebhookItemLocator;
    }): void => {
      if (items.length >= META_WEBHOOK_MAX_ITEMS) throw new MetaWebhookPayloadValidationError();
      const resource = resourceFor(object, entry.id, input.value, input.item, input.field, input.locator.nestedKind);
      const itemHash = stableItemHash([object, entry.id, input.field, input.locator.nestedKind, input.item]);
      const eventRef = createHash('sha256')
        .update(`${object}\0${entry.id}\0${input.field}\0${itemHash}`, 'utf8')
        .digest('hex');
      items.push({
        schemaVersion: META_WEBHOOK_SCHEMA_VERSION,
        eventRef,
        eventKey: eventRef,
        eventType: safeEventType(object, input.locator.nestedKind === 'change' ? input.field : `${input.field}.${input.locator.nestedKind}`),
        object,
        field: input.field,
        providerTimestamp: providerTimestamp(input.item),
        providerMessageId: ['messages', 'statuses'].includes(input.locator.nestedKind) ? objectId(input.item.id) : null,
        providerStatus: input.locator.nestedKind === 'statuses' && boundedText(input.item.status, 32)
          ? input.item.status.toLowerCase() : null,
        providerStatusRank: input.locator.nestedKind === 'statuses' && boundedText(input.item.status, 32)
          ? metaWebhookStatusRank(input.item.status) : null,
        resourceKinds: resource.kinds,
        resourceExternalId: resource.externalId,
        locator: input.locator,
      });
    };

    for (let changeIndex = 0; changeIndex < changes.length; changeIndex += 1) {
      const change = changes[changeIndex];
      if (!isRecord(change) || !boundedText(change.field, 64) || !isRecord(change.value)) {
        throw new MetaWebhookPayloadValidationError();
      }
      const value = change.value;
      let itemCount = 0;
      for (const nestedKind of ['messages', 'statuses'] as const) {
        const nested = value[nestedKind];
        if (nested === undefined) continue;
        if (!Array.isArray(nested) || nested.length > META_WEBHOOK_MAX_ITEMS) throw new MetaWebhookPayloadValidationError();
        for (let nestedIndex = 0; nestedIndex < nested.length; nestedIndex += 1) {
          const item = nested[nestedIndex];
          if (!isRecord(item)) throw new MetaWebhookPayloadValidationError();
          pushItem({ field: change.field, value, item, locator: { entryIndex, changeIndex, nestedKind, nestedIndex } });
          itemCount += 1;
        }
      }
      if (itemCount === 0) pushItem({
        field: change.field, value, item: value,
        locator: { entryIndex, changeIndex, nestedKind: 'change', nestedIndex: 0 },
      });
    }

    for (let messagingIndex = 0; messagingIndex < messaging.length; messagingIndex += 1) {
      const item = messaging[messagingIndex];
      if (!isRecord(item)) throw new MetaWebhookPayloadValidationError();
      const field = 'messaging';
      pushItem({ field, value: entry, item, locator: { entryIndex, changeIndex: messagingIndex, nestedKind: 'messaging', nestedIndex: 0 } });
    }
  }
  if (items.length === 0) throw new MetaWebhookPayloadValidationError();
  return { schemaVersion: META_WEBHOOK_SCHEMA_VERSION, object, items };
}

export function itemFromProtectedDelivery(
  rawBody: Buffer,
  locator: MetaWebhookItemLocator,
): Readonly<Record<string, unknown>> {
  const delivery = JSON.parse(decodeRawBody(rawBody)) as JsonRecord;
  const entry = (delivery.entry as unknown[])[locator.entryIndex] as JsonRecord;
  if (locator.nestedKind === 'messaging') {
    const item = (entry.messaging as unknown[])[locator.changeIndex];
    if (!isRecord(item)) throw new Error('Stored webhook item locator is invalid.');
    return item;
  }
  const change = (entry.changes as unknown[])[locator.changeIndex] as JsonRecord;
  if (locator.nestedKind === 'change') {
    if (!isRecord(change.value)) throw new Error('Stored webhook item locator is invalid.');
    return change.value;
  }
  const value = change.value as JsonRecord;
  const nested = value[locator.nestedKind] as unknown[];
  const item = nested[locator.nestedIndex];
  if (!isRecord(item)) throw new Error('Stored webhook item locator is invalid.');
  return item;
}
