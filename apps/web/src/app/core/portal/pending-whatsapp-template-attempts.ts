import type { TemplateCreateRequest } from './whatsapp-templates.service';

export const PENDING_WHATSAPP_TEMPLATE_ATTEMPTS_STORAGE_KEY = 'ca.meta.portal.whatsapp-template-attempts.v1';
const MAX_PENDING_ATTEMPTS = 100;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._~-]{16,128}$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface PendingWhatsAppTemplateAttempt {
  readonly idempotencyKey: string;
  readonly jobId?: string;
  readonly succeeded?: boolean;
}

/** Persists only hashes, idempotency keys and opaque job IDs; request text/examples never reach storage. */
export class PendingWhatsAppTemplateAttempts {
  constructor(private readonly storage: () => Storage = () => globalThis.sessionStorage) {}

  async scope(contextRef: string, assetId: string, request: TemplateCreateRequest): Promise<string> {
    if (!contextRef || !assetId) throw new Error('A verified portal context and internal asset are required.');
    const material = JSON.stringify([contextRef, assetId, request]);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
  }

  reserve(scope: string, makeIdempotencyKey: () => string): PendingWhatsAppTemplateAttempt {
    if (!SHA256.test(scope)) throw new Error('Invalid pending template attempt scope.');
    const attempts = this.read();
    const existing = attempts.get(scope);
    if (existing) return existing;
    // A newly submitted fingerprint is an explicit new request; keep only unresolved attempts plus the latest success marker.
    for (const [priorScope, prior] of attempts) {
      if (prior.succeeded) attempts.delete(priorScope);
    }
    if (attempts.size >= MAX_PENDING_ATTEMPTS) throw new Error('Pending template attempt capacity reached.');
    const idempotencyKey = makeIdempotencyKey();
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new Error('Invalid pending template idempotency key.');
    const attempt = Object.freeze({ idempotencyKey });
    attempts.set(scope, attempt);
    this.write(attempts);
    return attempt;
  }

  find(scope: string): PendingWhatsAppTemplateAttempt | undefined {
    if (!SHA256.test(scope)) throw new Error('Invalid pending template attempt scope.');
    return this.read().get(scope);
  }

  recordJob(scope: string, jobId: string): void {
    if (!SHA256.test(scope) || !JOB_ID.test(jobId)) throw new Error('Invalid pending template job reference.');
    const attempts = this.read();
    const current = attempts.get(scope);
    if (!current) return;
    attempts.set(scope, Object.freeze({ idempotencyKey: current.idempotencyKey, jobId,
      ...(current.succeeded ? { succeeded: true } : {}) }));
    this.write(attempts);
  }

  markSucceeded(scope: string): void {
    if (!SHA256.test(scope)) return;
    const attempts = this.read();
    const current = attempts.get(scope);
    if (!current) return;
    for (const [priorScope, prior] of attempts) {
      if (priorScope !== scope && prior.succeeded) attempts.delete(priorScope);
    }
    attempts.set(scope, Object.freeze({
      idempotencyKey: current.idempotencyKey,
      ...(current.jobId ? { jobId: current.jobId } : {}),
      succeeded: true,
    }));
    this.write(attempts);
  }

  resolve(scope: string): void {
    if (!SHA256.test(scope)) return;
    const attempts = this.read();
    if (!attempts.delete(scope)) return;
    this.write(attempts);
  }

  clear(): void {
    this.storage().removeItem(PENDING_WHATSAPP_TEMPLATE_ATTEMPTS_STORAGE_KEY);
  }

  private read(): Map<string, PendingWhatsAppTemplateAttempt> {
    const raw = this.storage().getItem(PENDING_WHATSAPP_TEMPLATE_ATTEMPTS_STORAGE_KEY);
    if (raw === null) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (!record(parsed) || Object.keys(parsed).length > MAX_PENDING_ATTEMPTS) {
      throw new Error('Pending template attempt storage is invalid.');
    }
    const attempts = new Map<string, PendingWhatsAppTemplateAttempt>();
    for (const [scope, value] of Object.entries(parsed)) {
      if (!SHA256.test(scope) || !record(value) || Object.keys(value).some((key) =>
          !['idempotencyKey', 'jobId', 'succeeded'].includes(key)) || typeof value['idempotencyKey'] !== 'string' ||
          !IDEMPOTENCY_KEY.test(value['idempotencyKey'])) {
        throw new Error('Pending template attempt storage is invalid.');
      }
      const jobId = value['jobId'];
      const succeeded = value['succeeded'];
      if ((jobId !== undefined && (typeof jobId !== 'string' || !JOB_ID.test(jobId))) ||
          (succeeded !== undefined && typeof succeeded !== 'boolean')) {
        throw new Error('Pending template attempt storage is invalid.');
      }
      attempts.set(scope, Object.freeze({ idempotencyKey: value['idempotencyKey'],
        ...(typeof jobId === 'string' ? { jobId } : {}),
        ...(succeeded === true ? { succeeded: true } : {}) }));
    }
    return attempts;
  }

  private write(attempts: ReadonlyMap<string, PendingWhatsAppTemplateAttempt>): void {
    if (attempts.size === 0) {
      this.clear();
      return;
    }
    this.storage().setItem(PENDING_WHATSAPP_TEMPLATE_ATTEMPTS_STORAGE_KEY, JSON.stringify(Object.fromEntries(attempts)));
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
