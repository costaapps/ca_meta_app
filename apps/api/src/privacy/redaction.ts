const MAX_DEPTH = 8;
const MAX_ITEMS = 64;
const MAX_STRING_LENGTH = 256;

const SENSITIVE_KEY = /(?:access.?token|refresh.?token|token|secret|password|authorization|cookie|credential|oauth.?(?:code|state)|app.?secret|private.?key|ciphertext|nonce|message|payload|body|header|trace|stack|phone|email|contact|raw.?data|recipient|api.?key|bearer|session.?secret|csrf)/i;
const MARKER_VALUE = /(?:synthetic|marker|bearer|secret|token|cookie|oauth|access.?key)/i;
const BEARER = /\bBearer\s+[^\s,;]+/gi;
const JWT = /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?<!\w)\+?\d[\d ()-]{7,}\d(?!\w)/g;
const OAUTH_QUERY_VALUE = /([?&](?:code|state)=)[^&#\s]*/gi;
const UUID_REFERENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_DIAGNOSTIC_KEYS = new Set(['credentialHealth']);

function matches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const matched = pattern.test(value);
  pattern.lastIndex = 0;
  return matched;
}

function safeString(value: string): string {
  if (value.length > MAX_STRING_LENGTH || MARKER_VALUE.test(value) ||
    (value.length >= 32 && /^[A-Za-z0-9_~-]+$/.test(value) && !/^[0-9a-f-]{36}$/i.test(value))) return '[REDACTED]';
  return value.replace(BEARER, '[REDACTED]').replace(JWT, '[REDACTED]')
    .replace(EMAIL, '[REDACTED]').replace(PHONE, '[REDACTED]')
    .replace(OAUTH_QUERY_VALUE, '$1[REDACTED]');
}

/** Recursively removes sensitive fields from diagnostic material before it can be displayed or exported. */
export function redactDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED]';
  if (typeof value === 'string') return safeString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[REDACTED]';
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => redactDiagnosticValue(item, depth + 1));
  if (typeof value !== 'object') return '[REDACTED]';
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return '[REDACTED]';

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_ITEMS)) {
    if ((SENSITIVE_KEY.test(key) && !SAFE_DIAGNOSTIC_KEYS.has(key)) || /^(?:code|state)$/i.test(key)) continue;
    result[key.slice(0, 80)] = redactDiagnosticValue(item, depth + 1);
  }
  return result;
}

const REFERENCE = /^[A-Za-z0-9:_-]{1,128}$/;

/** Accept internal opaque references while rejecting recognizable marker, credential and contact values. */
export function isSafeOpaqueReference(value: string): boolean {
  return REFERENCE.test(value) && !MARKER_VALUE.test(value) && !matches(BEARER, value) && !matches(JWT, value) &&
    !matches(EMAIL, value) && (UUID_REFERENCE.test(value) || !matches(PHONE, value));
}

const SAFE_LOG_FIELDS = new Set([
  'level', 'event', 'requestId', 'method', 'route', 'statusCode', 'durationMs', 'errorType',
]);

/** Structured logs use a closed field allowlist, even if callers pass extra properties at runtime. */
export function redactStructuredLogRecord(record: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const safe: Record<string, unknown> = {};
  for (const field of SAFE_LOG_FIELDS) {
    const value = record[field];
    if (typeof value === 'string') safe[field] = safeString(value);
    else if (typeof value === 'number' && Number.isFinite(value)) safe[field] = value;
  }
  return Object.freeze(safe);
}

const SAFE_DIFF_FIELDS = new Set(['before', 'after', 'status', 'policyVersion', 'version', 'reasonCode']);
const SAFE_SNAPSHOT_FIELDS = new Set(['status', 'policyVersion', 'version', 'reasonCode']);

function safeAuditScalar(value: unknown): string | number | boolean | null | undefined {
  if (typeof value === 'string') return safeString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean' || value === null) return value;
  return undefined;
}

function safeAuditSnapshot(value: unknown): unknown {
  const scalar = safeAuditScalar(value);
  if (scalar !== undefined) return scalar;
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return undefined;
  const snapshot: Record<string, string | number | boolean | null> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (!SAFE_SNAPSHOT_FIELDS.has(key)) continue;
    const nestedValue = safeAuditScalar(nested);
    if (nestedValue !== undefined) snapshot[key] = nestedValue;
  }
  return snapshot;
}

/** Audit diffs are allowlisted and recursively redacted; arbitrary payloads never enter the event table. */
export function sanitizeAuditDiff(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return Object.freeze({});
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!SAFE_DIFF_FIELDS.has(key)) continue;
    const safeValue = key === 'before' || key === 'after' ? safeAuditSnapshot(item) : safeAuditScalar(item);
    if (safeValue !== undefined) result[key] = safeValue;
  }
  return Object.freeze(result);
}
