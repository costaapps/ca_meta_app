import { DOCUMENT } from '@angular/common';
import { Inject, Injectable } from '@angular/core';

export interface StoredOnboardingReference {
  readonly id: string;
  readonly expiresAt: string;
}

const STORAGE_KEY = 'ca.meta.portal.onboarding-refs.v1';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
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

  ensureAvailable(): boolean {
    try {
      const storage = this.documentRef.defaultView?.sessionStorage;
      if (!storage) return false;
      const existing = storage.getItem(STORAGE_KEY);
      if (existing === null) storage.setItem(STORAGE_KEY, '[]');
      return true;
    } catch {
      return false;
    }
  }

  read(): readonly StoredOnboardingReference[] {
    try {
      const raw = this.documentRef.defaultView?.sessionStorage.getItem(STORAGE_KEY);
      if (raw === null || raw === undefined) return Object.freeze([]);
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value) || value.length > MAX_REFERENCES) return Object.freeze([]);
      const now = Date.now();
      const byId = new Map<string, StoredOnboardingReference>();
      for (const item of value) {
        if (isReference(item, now)) byId.set(item.id, Object.freeze({ id: item.id, expiresAt: item.expiresAt }));
      }
      const references = Object.freeze([...byId.values()]);
      this.write(references);
      return references;
    } catch {
      return Object.freeze([]);
    }
  }

  remember(id: string, expiresAt: string): boolean {
    if (!isReference({ id, expiresAt }, Date.now())) return false;
    const references = this.read().filter((reference) => reference.id !== id);
    references.push(Object.freeze({ id, expiresAt }));
    return references.length <= MAX_REFERENCES && this.write(references);
  }

  forget(id: string): void {
    this.write(this.read().filter((reference) => reference.id !== id));
  }

  clear(): void {
    try {
      this.documentRef.defaultView?.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Browser storage can be disabled; the service will keep the failure visible to the user.
    }
  }

  private write(references: readonly StoredOnboardingReference[]): boolean {
    try {
      const storage = this.documentRef.defaultView?.sessionStorage;
      if (!storage) return false;
      const safeReferences = references
        .filter((reference) => isReference(reference, Date.now()))
        .slice(-MAX_REFERENCES)
        .map(({ id, expiresAt }) => ({ id, expiresAt }));
      storage.setItem(STORAGE_KEY, JSON.stringify(safeReferences));
      return true;
    } catch {
      return false;
    }
  }
}
