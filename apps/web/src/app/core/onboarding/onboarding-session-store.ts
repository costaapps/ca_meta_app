import { DOCUMENT } from '@angular/common';
import { Inject, Injectable } from '@angular/core';
import type { OnboardingFlowVariant } from './onboarding-flow-catalog';

export interface StoredOnboardingReference {
  readonly id: string;
  readonly expiresAt: string;
}

export interface StoredPendingOnboardingCreate {
  readonly flowVariant: OnboardingFlowVariant;
  readonly idempotencyKey: string;
  readonly requestedCapabilities: readonly string[];
  readonly expiresAt: string;
}

interface StoredOnboardingPartition {
  readonly tenantContextRef: string;
  readonly references: readonly StoredOnboardingReference[];
  readonly pendingCreate?: StoredPendingOnboardingCreate;
}

const STORAGE_KEY = 'ca.meta.portal.onboarding-refs.v1';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CONTEXT_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/;
const MAX_REFERENCES = 16;
const MAX_FUTURE_MS = 15 * 60_000;
const MAX_CREATE_REPLAY_MS = 10 * 60_000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Fa-f0-9-]{36}$/;
const FLOW_VARIANTS = new Set<string>([
  'FACEBOOK_LOGIN', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN', 'WHATSAPP_CLOUD_API', 'WHATSAPP_COEXISTENCE',
]);
const REQUEST_CAPABILITIES = new Set<string>(['READ_STATUS']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReference(value: unknown, now: number): value is StoredOnboardingReference {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'id' && key !== 'expiresAt') ||
      typeof value['id'] !== 'string' || !ID_PATTERN.test(value['id']) ||
      typeof value['expiresAt'] !== 'string') return false;
  const expiry = Date.parse(value['expiresAt']);
  return Number.isFinite(expiry) && expiry > now && expiry <= now + MAX_FUTURE_MS;
}

function isPendingCreate(value: unknown, now: number): value is StoredPendingOnboardingCreate {
  if (!isRecord(value) || Object.keys(value).some((key) =>
      !['flowVariant', 'idempotencyKey', 'requestedCapabilities', 'expiresAt'].includes(key)) ||
      typeof value['flowVariant'] !== 'string' || !FLOW_VARIANTS.has(value['flowVariant']) ||
      typeof value['idempotencyKey'] !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value['idempotencyKey']) ||
      typeof value['expiresAt'] !== 'string' || !Array.isArray(value['requestedCapabilities']) ||
      value['requestedCapabilities'].length > REQUEST_CAPABILITIES.size ||
      !value['requestedCapabilities'].every((item) => typeof item === 'string' && REQUEST_CAPABILITIES.has(item))) return false;
  const expiry = Date.parse(value['expiresAt']);
  return Number.isFinite(expiry) && expiry > now && expiry <= now + MAX_CREATE_REPLAY_MS;
}

/** Stores opaque server IDs and one short-lived, context-bound create replay key; status is always re-read. */
@Injectable({ providedIn: 'root' })
export class OnboardingSessionStore {
  constructor(@Inject(DOCUMENT) private readonly documentRef: Document) {}

  ensureAvailable(tenantContextRef?: string): boolean {
    try {
      const storage = this.documentRef.defaultView?.sessionStorage;
      if (!storage) return false;
      if (tenantContextRef !== undefined) {
        const raw = storage.getItem(STORAGE_KEY);
        return raw === null ? this.useContext(tenantContextRef) : this.parse(raw)?.tenantContextRef === tenantContextRef;
      }
      storage.getItem(STORAGE_KEY);
      return true;
    } catch {
      return false;
    }
  }

  /** Partitions the tab's opaque refs by the server-returned context; this is never authorization. */
  useContext(tenantContextRef: string): boolean {
    if (!CONTEXT_PATTERN.test(tenantContextRef)) return false;
    try {
      const storage = this.documentRef.defaultView?.sessionStorage;
      if (!storage) return false;
      const partition = this.parse(storage.getItem(STORAGE_KEY));
      if (partition?.tenantContextRef === tenantContextRef) {
        this.write(tenantContextRef, partition.references, partition.pendingCreate);
        return true;
      }
      return this.write(tenantContextRef, [], undefined);
    } catch {
      return false;
    }
  }

  read(tenantContextRef: string): readonly StoredOnboardingReference[] {
    if (!CONTEXT_PATTERN.test(tenantContextRef)) return Object.freeze([]);
    try {
      const raw = this.documentRef.defaultView?.sessionStorage.getItem(STORAGE_KEY);
      const partition = this.parse(raw ?? null);
      if (!partition || partition.tenantContextRef !== tenantContextRef) return Object.freeze([]);
      const references = this.validReferences(partition.references);
      this.write(tenantContextRef, references, partition.pendingCreate);
      return references;
    } catch {
      return Object.freeze([]);
    }
  }

  remember(id: string, expiresAt: string, tenantContextRef: string): boolean {
    if (!isReference({ id, expiresAt }, Date.now())) return false;
    if (!this.ensureAvailable(tenantContextRef)) return false;
    const partition = this.readPartition(tenantContextRef);
    const references = this.validReferences(partition?.references ?? []).filter((reference) => reference.id !== id);
    references.push(Object.freeze({ id, expiresAt }));
    return references.length <= MAX_REFERENCES && this.write(tenantContextRef, references, partition?.pendingCreate);
  }

  pendingCreate(tenantContextRef: string): StoredPendingOnboardingCreate | undefined {
    if (!CONTEXT_PATTERN.test(tenantContextRef)) return undefined;
    try {
      const partition = this.readPartition(tenantContextRef);
      if (!partition) return undefined;
      const references = this.validReferences(partition.references);
      this.write(tenantContextRef, references, partition.pendingCreate);
      return partition.pendingCreate;
    } catch {
      return undefined;
    }
  }

  rememberPendingCreate(
    idempotencyKey: string,
    flowVariant: OnboardingFlowVariant,
    requestedCapabilities: readonly string[],
    tenantContextRef: string,
  ): boolean {
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey) || !FLOW_VARIANTS.has(flowVariant) ||
        requestedCapabilities.length > REQUEST_CAPABILITIES.size ||
        !requestedCapabilities.every((item) => REQUEST_CAPABILITIES.has(item)) ||
        !this.ensureAvailable(tenantContextRef)) return false;
    const partition = this.readPartition(tenantContextRef);
    const pending = partition?.pendingCreate;
    if (pending) {
      return pending.idempotencyKey === idempotencyKey && pending.flowVariant === flowVariant &&
        JSON.stringify(pending.requestedCapabilities) === JSON.stringify(requestedCapabilities);
    }
    const next: StoredPendingOnboardingCreate = Object.freeze({
      flowVariant,
      idempotencyKey,
      requestedCapabilities: Object.freeze([...requestedCapabilities]),
      expiresAt: new Date(Date.now() + MAX_CREATE_REPLAY_MS).toISOString(),
    });
    return this.write(tenantContextRef, this.validReferences(partition?.references ?? []), next);
  }

  completePendingCreate(id: string, expiresAt: string, tenantContextRef: string, idempotencyKey: string): boolean {
    if (!isReference({ id, expiresAt }, Date.now()) || !this.ensureAvailable(tenantContextRef)) return false;
    const partition = this.readPartition(tenantContextRef);
    if (partition?.pendingCreate?.idempotencyKey !== idempotencyKey) return false;
    const references = this.validReferences(partition.references).filter((reference) => reference.id !== id);
    references.push(Object.freeze({ id, expiresAt }));
    return references.length <= MAX_REFERENCES && this.write(tenantContextRef, references, undefined);
  }

  forgetPendingCreate(tenantContextRef: string, idempotencyKey: string): void {
    if (!CONTEXT_PATTERN.test(tenantContextRef)) return;
    try {
      const partition = this.readPartition(tenantContextRef);
      if (partition?.pendingCreate?.idempotencyKey !== idempotencyKey) return;
      this.write(tenantContextRef, this.validReferences(partition.references), undefined);
    } catch {
      // Keeping an unresolved replay key is safer than clearing it after an uncertain storage error.
    }
  }

  forget(id: string, tenantContextRef: string): void {
    if (!CONTEXT_PATTERN.test(tenantContextRef)) return;
    try {
      const raw = this.documentRef.defaultView?.sessionStorage.getItem(STORAGE_KEY);
      if (this.parse(raw ?? null)?.tenantContextRef !== tenantContextRef) return;
    } catch {
      return;
    }
    const references = this.read(tenantContextRef);
    const partition = this.readPartition(tenantContextRef);
    this.write(tenantContextRef, references.filter((reference) => reference.id !== id), partition?.pendingCreate);
  }

  clear(): void {
    try {
      this.documentRef.defaultView?.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Browser storage can be disabled; the service will keep the failure visible to the user.
    }
  }

  private parse(raw: string | null): StoredOnboardingPartition | undefined {
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || Object.keys(value).some((key) =>
        !['tenantContextRef', 'references', 'pendingCreate'].includes(key)) ||
        typeof value['tenantContextRef'] !== 'string' || !CONTEXT_PATTERN.test(value['tenantContextRef']) ||
        !Array.isArray(value['references']) || value['references'].length > MAX_REFERENCES) return undefined;
    const now = Date.now();
    const byId = new Map<string, StoredOnboardingReference>();
    for (const item of value['references']) {
      if (isReference(item, now)) byId.set(item.id, Object.freeze({ id: item.id, expiresAt: item.expiresAt }));
    }
    const pendingCreate = isPendingCreate(value['pendingCreate'], now) ? Object.freeze({
      ...value['pendingCreate'],
      requestedCapabilities: Object.freeze([...value['pendingCreate'].requestedCapabilities]),
    }) : undefined;
    return Object.freeze({
      tenantContextRef: value['tenantContextRef'],
      references: Object.freeze([...byId.values()]),
      ...(pendingCreate ? { pendingCreate } : {}),
    });
  }

  private readPartition(tenantContextRef: string): StoredOnboardingPartition | undefined {
    if (!CONTEXT_PATTERN.test(tenantContextRef)) return undefined;
    const raw = this.documentRef.defaultView?.sessionStorage.getItem(STORAGE_KEY);
    const partition = this.parse(raw ?? null);
    return partition?.tenantContextRef === tenantContextRef ? partition : undefined;
  }

  private validReferences(references: readonly StoredOnboardingReference[]): StoredOnboardingReference[] {
    const now = Date.now();
    const byId = new Map<string, StoredOnboardingReference>();
    for (const item of references) {
      if (isReference(item, now)) byId.set(item.id, Object.freeze({ id: item.id, expiresAt: item.expiresAt }));
    }
    return [...byId.values()];
  }

  private write(
    tenantContextRef: string,
    references: readonly StoredOnboardingReference[],
    pendingCreate: StoredPendingOnboardingCreate | undefined,
  ): boolean {
    try {
      const storage = this.documentRef.defaultView?.sessionStorage;
      if (!storage || !CONTEXT_PATTERN.test(tenantContextRef)) return false;
      const safeReferences = references
        .filter((reference) => isReference(reference, Date.now()))
        .slice(-MAX_REFERENCES)
        .map(({ id, expiresAt }) => ({ id, expiresAt }));
      const safePendingCreate = pendingCreate && isPendingCreate(pendingCreate, Date.now())
        ? {
          flowVariant: pendingCreate.flowVariant,
          idempotencyKey: pendingCreate.idempotencyKey,
          requestedCapabilities: [...pendingCreate.requestedCapabilities],
          expiresAt: pendingCreate.expiresAt,
        }
        : undefined;
      storage.setItem(STORAGE_KEY, JSON.stringify({
        tenantContextRef,
        references: safeReferences,
        ...(safePendingCreate ? { pendingCreate: safePendingCreate } : {}),
      }));
      return true;
    } catch {
      return false;
    }
  }
}
