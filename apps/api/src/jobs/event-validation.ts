import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createRequire } from 'node:module';
import type { MetaAuthVariant, MetaFlowVariant } from '../credentials/credential-resolver.types.js';

export interface InboxEventEnvelope {
  readonly eventId: string;
  readonly schemaVersion: 1;
  readonly eventType: string;
  readonly appConfigRef: string;
  readonly tenantRef: string | null;
  readonly actor: { readonly kind: 'PROVIDER' | 'SYSTEM' | 'SERVICE'; readonly ref: string };
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly aggregateRef?: string | null;
  readonly aggregateVersion: number;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly protectedPayloadRef: string;
  readonly safeMetadata: Readonly<Record<string, unknown>>;
  readonly routingState: 'PENDING' | 'ROUTED' | 'QUARANTINED' | 'REJECTED';
}

export interface OutboxEventEnvelope {
  readonly eventId: string;
  readonly tenantRef: string;
  readonly schemaVersion: 1;
  readonly eventType: string;
  readonly aggregateRef: string;
  readonly aggregateVersion: number;
  readonly actor: { readonly kind: 'USER' | 'SERVICE' | 'SYSTEM'; readonly ref: string };
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly createdAt: string;
  readonly enqueuedAt: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export type JobType = 'INBOX_PROCESS' | 'OUTBOX_DELIVER' | 'ONBOARDING_STEP' | 'PROJECTION_RECONCILE' | 'HISTORY_SYNC' | 'CREDENTIAL_INSPECTION' | 'ASSET_REFRESH';

export type JobPayload =
  | { readonly kind: 'INBOX_PROCESS'; readonly inboxEventRef: string }
  | { readonly kind: 'OUTBOX_DELIVER'; readonly outboxEventRef: string }
  | { readonly kind: 'ONBOARDING_STEP'; readonly onboardingRef: string; readonly stepRef: string; readonly codeRef?: string; readonly operation?: 'RECONCILE' }
  | { readonly kind: 'PROJECTION_RECONCILE'; readonly projectionRef: string; readonly sourceVersion: number }
  | { readonly kind: 'HISTORY_SYNC'; readonly checkpointRef: string }
  | {
    readonly kind: 'CREDENTIAL_INSPECTION'; readonly credentialId: string; readonly authorizationId: string;
    readonly appConfigurationId: string; readonly provider: 'META'; readonly environment: 'development' | 'test' | 'staging' | 'production';
    readonly flowVariant: MetaFlowVariant; readonly authVariant: MetaAuthVariant;
    readonly family: string; readonly credentialVersion: number; readonly secretVersion: number;
    readonly authorizationVersion: number; readonly lifecycleVersion: number; readonly generation: number;
    readonly leaseOwner: string; readonly leaseToken: string;
  }
  | {
    readonly kind: 'ASSET_REFRESH'; readonly assetId: string; readonly appConfigurationId: string;
    readonly environment: 'development' | 'test' | 'staging' | 'production';
  };

export type JobLane = 'WEBHOOK_URGENT' | 'ONBOARDING' | 'HISTORICAL_PROJECTION';
export type EffectMode = 'SAFE_RETRY' | 'IDEMPOTENT' | 'AMBIGUOUS';

interface JobPolicy {
  readonly lane: JobLane;
  readonly effectMode: EffectMode;
  readonly maxAttempts: number;
  readonly maxElapsedMs: number;
  readonly maxHandlerMs: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
}

export const JOB_POLICIES: Readonly<Record<JobType, JobPolicy>> = Object.freeze({
  INBOX_PROCESS: {
    lane: 'WEBHOOK_URGENT', effectMode: 'SAFE_RETRY', maxAttempts: 5,
    maxElapsedMs: 60_000, maxHandlerMs: 15_000, retryBaseMs: 500, retryMaxMs: 15_000,
  },
  OUTBOX_DELIVER: {
    // Provider side effects cannot be called idempotent until a specific adapter proves it.
    lane: 'ONBOARDING', effectMode: 'AMBIGUOUS', maxAttempts: 5,
    maxElapsedMs: 15 * 60_000, maxHandlerMs: 15_000, retryBaseMs: 1_000, retryMaxMs: 60_000,
  },
  ONBOARDING_STEP: {
    // The authorization exchange is one-use and never retries. Later stages may
    // use one bounded retry only when the adapter proves that no effect occurred.
    lane: 'ONBOARDING', effectMode: 'AMBIGUOUS', maxAttempts: 2,
    maxElapsedMs: 15 * 60_000, maxHandlerMs: 60_000, retryBaseMs: 2_000, retryMaxMs: 60_000,
  },
  PROJECTION_RECONCILE: {
    lane: 'HISTORICAL_PROJECTION', effectMode: 'SAFE_RETRY', maxAttempts: 5,
    maxElapsedMs: 60 * 60_000, maxHandlerMs: 30_000, retryBaseMs: 1_000, retryMaxMs: 60_000,
  },
  HISTORY_SYNC: {
    lane: 'HISTORICAL_PROJECTION', effectMode: 'AMBIGUOUS', maxAttempts: 3,
    maxElapsedMs: 15 * 60_000, maxHandlerMs: 60_000, retryBaseMs: 2_000, retryMaxMs: 60_000,
  },
  CREDENTIAL_INSPECTION: {
    lane: 'HISTORICAL_PROJECTION', effectMode: 'IDEMPOTENT', maxAttempts: 1,
    maxElapsedMs: 5 * 60_000, maxHandlerMs: 30_000, retryBaseMs: 1_000, retryMaxMs: 1_000,
  },
  ASSET_REFRESH: {
    lane: 'HISTORICAL_PROJECTION', effectMode: 'SAFE_RETRY', maxAttempts: 3,
    maxElapsedMs: 15 * 60_000, maxHandlerMs: 60_000, retryBaseMs: 2_000, retryMaxMs: 60_000,
  },
});

export const MAX_WAITING_JOBS_PER_TENANT = 1_000;
export const MAX_ACTIVE_JOBS_PER_TENANT = 4;

const loadSchema = createRequire(__filename);
const inboxSchema = loadSchema('@ca-meta/contracts/events/inbox-event.schema.json') as object;
const outboxSchema = loadSchema('@ca-meta/contracts/events/outbox-event.schema.json') as object;
const ajv = new Ajv2020({ allErrors: true, strict: false });
// npm workspaces can resolve the same pinned AJV version from separate package paths.
const registerFormats = addFormats as unknown as (instance: object) => void;
registerFormats(ajv);
const validateInbox = ajv.compile<InboxEventEnvelope>(inboxSchema);
const validateOutbox = ajv.compile<OutboxEventEnvelope>(outboxSchema);

const jobPayloadSchemas: Readonly<Record<JobType, object>> = {
  INBOX_PROCESS: {
    type: 'object', additionalProperties: false, required: ['kind', 'inboxEventRef'],
    properties: { kind: { const: 'INBOX_PROCESS' }, inboxEventRef: { type: 'string', format: 'uuid' } },
  },
  OUTBOX_DELIVER: {
    type: 'object', additionalProperties: false, required: ['kind', 'outboxEventRef'],
    properties: { kind: { const: 'OUTBOX_DELIVER' }, outboxEventRef: { type: 'string', format: 'uuid' } },
  },
  ONBOARDING_STEP: {
    type: 'object', additionalProperties: false, required: ['kind', 'onboardingRef', 'stepRef'],
    properties: {
      kind: { const: 'ONBOARDING_STEP' },
      onboardingRef: { type: 'string', minLength: 1, maxLength: 128 },
      stepRef: { type: 'string', minLength: 1, maxLength: 128 },
      codeRef: { type: 'string', format: 'uuid' },
      operation: { enum: ['RECONCILE'] },
    },
  },
  PROJECTION_RECONCILE: {
    type: 'object', additionalProperties: false, required: ['kind', 'projectionRef', 'sourceVersion'],
    properties: {
      kind: { const: 'PROJECTION_RECONCILE' },
      projectionRef: { type: 'string', minLength: 1, maxLength: 128 },
      sourceVersion: { type: 'integer', minimum: 1 },
    },
  },
  HISTORY_SYNC: {
    type: 'object', additionalProperties: false, required: ['kind', 'checkpointRef'],
    properties: { kind: { const: 'HISTORY_SYNC' }, checkpointRef: { type: 'string', minLength: 1, maxLength: 128 } },
  },
  CREDENTIAL_INSPECTION: {
    type: 'object', additionalProperties: false,
    required: ['kind', 'credentialId', 'authorizationId', 'appConfigurationId', 'provider', 'environment', 'flowVariant', 'authVariant', 'family',
      'credentialVersion', 'secretVersion', 'authorizationVersion', 'lifecycleVersion', 'generation', 'leaseOwner', 'leaseToken'],
    properties: {
      kind: { const: 'CREDENTIAL_INSPECTION' }, credentialId: { type: 'string', format: 'uuid' },
      authorizationId: { type: 'string', format: 'uuid' }, appConfigurationId: { type: 'string', format: 'uuid' },
      provider: { const: 'META' }, environment: { enum: ['development', 'test', 'staging', 'production'] },
      flowVariant: { enum: ['FACEBOOK', 'INSTAGRAM', 'WHATSAPP_EXCLUSIVE', 'WHATSAPP_COEXISTENCE'] },
      authVariant: { enum: ['FACEBOOK_LOGIN_FOR_BUSINESS', 'INSTAGRAM_LOGIN', 'WHATSAPP_EMBEDDED_SIGNUP', 'WHATSAPP_BUSINESS_APP_ONBOARDING'] },
      family: { type: 'string', pattern: '^[A-Z][A-Z0-9_-]{0,31}$' },
      credentialVersion: { type: 'integer', minimum: 1 }, secretVersion: { type: 'integer', minimum: 1 },
      authorizationVersion: { type: 'integer', minimum: 1 }, lifecycleVersion: { type: 'integer', minimum: 1 },
      generation: { type: 'integer', minimum: 1 }, leaseOwner: { type: 'string', pattern: '^[A-Za-z0-9:_-]{1,128}$' },
      leaseToken: { type: 'string', format: 'uuid' },
    },
  },
  ASSET_REFRESH: {
    type: 'object', additionalProperties: false, required: ['kind', 'assetId', 'appConfigurationId', 'environment'],
    properties: {
      kind: { const: 'ASSET_REFRESH' }, assetId: { type: 'string', format: 'uuid' },
      appConfigurationId: { type: 'string', format: 'uuid' }, environment: { enum: ['development', 'test', 'staging', 'production'] },
    },
  },
};

const jobValidators = new Map<JobType, ReturnType<typeof ajv.compile>>(
  Object.entries(jobPayloadSchemas).map(([type, schema]) => [type as JobType, ajv.compile(schema)]),
);

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function parseInboxEvent(value: unknown): InboxEventEnvelope {
  if (!validateInbox(value)) throw new Error('Invalid M1.07 inbox event envelope.');
  return value;
}

export function parseOutboxEvent(value: unknown): OutboxEventEnvelope {
  if (!validateOutbox(value)) throw new Error('Invalid M1.07 outbox event envelope.');
  return value;
}

export function parseJobPayload(type: JobType, value: unknown): JobPayload {
  const validator = jobValidators.get(type);
  if (!validator || !validator(value)) throw new Error('Invalid durable job payload.');
  return value as JobPayload;
}

export function isJobType(value: string): value is JobType {
  return Object.hasOwn(JOB_POLICIES, value);
}

export function retryDelayMs(policy: JobPolicy, attempt: number, random: () => number = Math.random): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new RangeError('attempt must be a positive integer.');
  const cap = Math.min(policy.retryMaxMs, policy.retryBaseMs * (2 ** (attempt - 1)));
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new RangeError('random must return a value in [0, 1).');
  return Math.floor(sample * cap);
}

export function canonicalJson(value: unknown): string {
  const normalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(normalize);
    if (current === null || typeof current !== 'object') return current;
    const entries = Object.entries(current).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return Object.fromEntries(entries.map(([key, child]) => [key, normalize(child)]));
  };
  const serialized = JSON.stringify(normalize(value));
  if (serialized === undefined) throw new TypeError('Value cannot be represented as canonical JSON.');
  return serialized;
}
