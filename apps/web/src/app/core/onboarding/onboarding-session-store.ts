import { DOCUMENT } from '@angular/common';
import { Inject, Injectable } from '@angular/core';

export interface StoredOnboardingReference {
  readonly id: string;
  readonly expiresAt: string;
}

interface StoredOnboardingPartition {
  readonly tenantContextRef: string;
  readonly references: readonly StoredOnboardingReference[];
}

const STORAGE_KEY = 'ca.meta.portal.onboarding-refs.v1';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CONTEXT_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/;
const MAX_REFERENCES = 16;
const MAX_FUTURE_MS = 15 * 60_000;

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

/** Persists only opaque server IDs and their expiry; all status is re-read from the server. */
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
        this.write(tenantContextRef, partition.references);
        return true;
      }
      return this.write(tenantContextRef, []);
    } catch {
      return false;
    }
  }

  read(tenantContextRef: string): readonly StoredOnboardingReference[] {
    if (!CONTEXT_PATTERN.test(tenantContextRef)) return Object.freeze([]);
    try {
      const raw = this.documentRef.defaultView?.sessionStorage.getItem(STORAGE_KEY);
      const partition = this.parse(raw);
      if (!partition || partition.tenantContextRef !== tenantContextRef) return Object.freeze([]);
      const value = partition.references;
      const now = Date.now();
      const byId = new Map<string, StoredOnboardingReference>();
      for (const item of value) {
        if (isReference(item, now)) byId.set(item.id, Object.freeze({ id: item.id, expiresAt: item.expiresAt }));
      }
      const references = Object.freeze([...byId.values()]);
      this.write(tenantContextRef, references);
      return references;
    } catch {
      return Object.freeze([]);
    }
  }

  remember(id: string, expiresAt: string, tenantContextRef: string): boolean {
    if (!isReference({ id, expiresAt }, Date.now())) return false;
    if (!this.ensureAvailable(tenantContextRef)) return false;
    const references = this.read(tenantContextRef).filter((reference) => reference.id !== id);
    references.push(Object.freeze({ id, expiresAt }));
    return references.length <= MAX_REFERENCES && this.write(tenantContextRef, references);
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
    this.write(tenantContextRef, references.filter((reference) => reference.id !== id));
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
    if (!isRecord(value) || Object.keys(value).some((key) => key !== 'tenantContextRef' && key !== 'references') ||
        typeof value['tenantContextRef'] !== 'string' || !CONTEXT_PATTERN.test(value['tenantContextRef']) ||
        !Array.isArray(value['references']) || value['references'].length > MAX_REFERENCES) return undefined;
    const now = Date.now();
    const byId = new Map<string, StoredOnboardingReference>();
    for (const item of value['references']) {
      if (isReference(item, now)) byId.set(item.id, Object.freeze({ id: item.id, expiresAt: item.expiresAt }));
    }
    return Object.freeze({ tenantContextRef: value['tenantContextRef'], references: Object.freeze([...byId.values()]) });
  }

  private write(tenantContextRef: string, references: readonly StoredOnboardingReference[]): boolean {
    try {
      const storage = this.documentRef.defaultView?.sessionStorage;
      if (!storage || !CONTEXT_PATTERN.test(tenantContextRef)) return false;
      const safeReferences = references
        .filter((reference) => isReference(reference, Date.now()))
        .slice(-MAX_REFERENCES)
        .map(({ id, expiresAt }) => ({ id, expiresAt }));
      storage.setItem(STORAGE_KEY, JSON.stringify({ tenantContextRef, references: safeReferences }));
      return true;
    } catch {
      return false;
    }
  }
}
