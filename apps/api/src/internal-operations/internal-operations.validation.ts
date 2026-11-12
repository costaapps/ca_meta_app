import { createHash } from 'node:crypto';
import { canonicalJson } from '../jobs/event-validation.js';
import type { InternalAssetOperation, InternalAssetOperationPayload } from './internal-operations.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InternalAssetOperationInputError extends Error {
  constructor() { super('Internal asset operation request is invalid.'); this.name = 'InternalAssetOperationInputError'; }
}

export class InternalAssetOperationIdempotencyConflictError extends Error {
  constructor() { super('The operation key was already used for a different request.'); this.name = 'InternalAssetOperationIdempotencyConflictError'; }
}

export class InternalAssetOperationUnavailableError extends Error {
  constructor() { super('The operation is not available.'); this.name = 'InternalAssetOperationUnavailableError'; }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function plainText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLength && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function reference(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }

export function parseInternalAssetOperation(value: unknown): InternalAssetOperationPayload {
  if (!record(value) || typeof value['operation'] !== 'string') throw new InternalAssetOperationInputError();
  const operation = value['operation'] as InternalAssetOperation;
  switch (operation) {
    case 'SEND_MESSAGE':
      if (!exactKeys(value, ['operation', 'recipientRef', 'message']) || !reference(value['recipientRef']) || !record(value['message'])) {
        throw new InternalAssetOperationInputError();
      }
      if (value['message']['kind'] === 'TEXT' && exactKeys(value['message'], ['kind', 'text']) && plainText(value['message']['text'], 4096)) {
        return Object.freeze({ operation, recipientRef: value['recipientRef'], message: Object.freeze({ kind: 'TEXT', text: value['message']['text'] }) });
      }
      if (value['message']['kind'] === 'TEMPLATE' && exactKeys(value['message'], ['kind', 'name', 'language', 'parameters']) &&
          typeof value['message']['name'] === 'string' && /^[a-z0-9_]{1,128}$/.test(value['message']['name']) &&
          typeof value['message']['language'] === 'string' && /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?$/.test(value['message']['language']) &&
          Array.isArray(value['message']['parameters']) && value['message']['parameters'].length <= 20 &&
          value['message']['parameters'].every((item) => plainText(item, 1024))) {
        return Object.freeze({ operation, recipientRef: value['recipientRef'], message: Object.freeze({
          kind: 'TEMPLATE', name: value['message']['name'], language: value['message']['language'],
          parameters: Object.freeze([...(value['message']['parameters'] as string[])]),
        }) });
      }
      throw new InternalAssetOperationInputError();
    case 'MANAGE_TEMPLATES':
      if (value['action'] === 'LIST' && exactKeys(value, ['operation', 'action'])) {
        return Object.freeze({ operation, action: 'LIST' });
      }
      if (value['action'] !== 'CREATE' || !exactKeys(value, ['operation', 'action', 'name', 'language', 'category', 'bodyText', 'exampleValues']) ||
          typeof value['name'] !== 'string' || !/^[a-z0-9_]{1,128}$/.test(value['name']) ||
          typeof value['language'] !== 'string' || !/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?$/.test(value['language']) ||
          !['AUTHENTICATION', 'MARKETING', 'UTILITY'].includes(String(value['category'])) || !plainText(value['bodyText'], 1024) ||
          (value['exampleValues'] !== undefined && (!Array.isArray(value['exampleValues']) || value['exampleValues'].length > 20 ||
            !value['exampleValues'].every((item) => plainText(item, 1024))))) {
        throw new InternalAssetOperationInputError();
      }
      return Object.freeze({ operation, action: 'CREATE', name: value['name'], language: value['language'],
        category: value['category'] as 'AUTHENTICATION' | 'MARKETING' | 'UTILITY', bodyText: value['bodyText'],
        ...(Array.isArray(value['exampleValues']) ? { exampleValues: Object.freeze([...(value['exampleValues'] as string[])]) } : {}) });
    case 'MANAGE_COMMENTS':
      if (value['action'] === 'LIST' && exactKeys(value, ['operation', 'action'])) {
        return Object.freeze({ operation, action: 'LIST' });
      }
      if (value['action'] !== 'REPLY' || !exactKeys(value, ['operation', 'action', 'commentRef', 'text']) ||
          !reference(value['commentRef']) || !plainText(value['text'], 4096)) throw new InternalAssetOperationInputError();
      return Object.freeze({ operation, action: 'REPLY', commentRef: value['commentRef'], text: value['text'] });
    case 'READ_STATUS':
      if (!exactKeys(value, ['operation'])) throw new InternalAssetOperationInputError();
      return Object.freeze({ operation });
    case 'SUBSCRIBE_WEBHOOKS':
      if (!exactKeys(value, ['operation', 'action']) || !['READ', 'RECONCILE'].includes(String(value['action']))) {
        throw new InternalAssetOperationInputError();
      }
      return Object.freeze({ operation, action: value['action'] as 'READ' | 'RECONCILE' });
    default:
      throw new InternalAssetOperationInputError();
  }
}

export function hashInternalAssetOperation(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function hashInternalServiceIdempotencyKey(value: string): string {
  if (!/^[A-Za-z0-9._~-]{16,128}$/.test(value)) throw new InternalAssetOperationInputError();
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function isUuid(value: string): boolean { return UUID.test(value); }
