import { createHash } from 'node:crypto';
import type { LegacyProjectionRecord, LegacyProjectionTargetKey } from './legacy-projection.types.js';

const SAFE_ENVIRONMENTS = new Set(['development', 'test', 'staging', 'production']);
const SAFE_CAPABILITY = /^[A-Z][A-Z0-9:_-]{0,63}$/;

function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

export function validateProjectionTarget(value: LegacyProjectionTargetKey): LegacyProjectionTargetKey {
  if (!bounded(value.legacyDatabaseId, 128) || !/^[\x20-\x7e]+$/.test(value.legacyDatabaseId) ||
      !bounded(value.legacyCompanyId, 191) || !SAFE_ENVIRONMENTS.has(value.environment)) {
    throw new Error('Legacy projection destination mapping is invalid.');
  }
  return value;
}

/** Hashing the full tuple prevents same-database companies and environments from sharing checkpoints. */
export function destinationKeyHash(value: LegacyProjectionTargetKey): string {
  const target = validateProjectionTarget(value);
  return createHash('sha256')
    .update(JSON.stringify([target.legacyDatabaseId, target.legacyCompanyId, target.environment]), 'utf8')
    .digest('hex');
}

/** Rebuild a bounded DTO to reject accidental message/token/DSN fields from a source adapter. */
export function validateProjectionRecord(value: LegacyProjectionRecord): LegacyProjectionRecord {
  const expected = ['kind', 'centralRef', 'legacyAssetRef', 'sourceVersion', 'status', 'externalId', 'displayName',
    'assetKind', 'parentLegacyAssetRef', 'capabilities', 'configVersion', 'tombstone'];
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) {
    throw new Error('Legacy projection record contains an unsupported field.');
  }
  if (!['PAGE', 'WHATSAPP_NUMBER', 'AUTOMATION_CONFIG'].includes(value.kind) ||
      !bounded(value.centralRef, 128) || !bounded(value.legacyAssetRef, 512) ||
      !Number.isSafeInteger(value.sourceVersion) || value.sourceVersion < 1 ||
      !['ACTIVE', 'UNKNOWN', 'REMOVED'].includes(value.status) || typeof value.tombstone !== 'boolean' ||
      (value.externalId !== null && !bounded(value.externalId, 512)) ||
      (value.displayName !== null && !bounded(value.displayName, 255)) ||
      (value.assetKind !== null && !bounded(value.assetKind, 32)) ||
      (value.parentLegacyAssetRef !== null && !bounded(value.parentLegacyAssetRef, 512)) ||
      !Array.isArray(value.capabilities) || value.capabilities.length > 64 ||
      !value.capabilities.every((capability) => typeof capability === 'string' && SAFE_CAPABILITY.test(capability)) ||
      (value.configVersion !== null && (!Number.isSafeInteger(value.configVersion) || value.configVersion < 0)) ||
      value.tombstone !== (value.status === 'REMOVED')) {
    throw new Error('Legacy projection record is invalid.');
  }
  if (value.kind === 'AUTOMATION_CONFIG' && value.configVersion === null) {
    throw new Error('Automation projection requires a configuration version.');
  }
  return Object.freeze({ ...value, capabilities: Object.freeze([...value.capabilities]) });
}

export function projectionContentHash(record: LegacyProjectionRecord): string {
  const checked = validateProjectionRecord(record);
  // Ordering is stored separately. Excluding the upstream counter keeps retries stable when the
  // destination's monotonic projection revision differs from an independent source counter.
  const { sourceVersion: _sourceVersion, ...content } = checked;
  return createHash('sha256').update(JSON.stringify(content), 'utf8').digest('hex');
}

export type ProjectionVersionDecision = 'APPLY' | 'DUPLICATE' | 'STALE';

export function compareProjectionVersion(
  current: { readonly sourceVersion: number; readonly contentHash: string },
  next: { readonly sourceVersion: number; readonly contentHash: string },
): ProjectionVersionDecision {
  if (next.sourceVersion < current.sourceVersion) return 'STALE';
  if (next.sourceVersion === current.sourceVersion) {
    if (next.contentHash !== current.contentHash) throw new Error('Projection version conflicts with different content.');
    return 'DUPLICATE';
  }
  return 'APPLY';
}
