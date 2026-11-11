import { Injectable } from '@angular/core';
import { safeReturnUrl } from './safe-return-url';

const STORAGE_KEY = 'ca.meta.portal.pending-return.v1';
const RETURN_LIFETIME_MS = 30 * 60 * 1000;

interface PendingReturn {
  readonly attemptRef: string | null;
  readonly returnUrl: string;
  readonly createdAt: number;
  readonly accepted: boolean;
}

@Injectable({ providedIn: 'root' })
export class PortalEntryReturnStore {
  remember(returnUrl: string): void {
    this.writePending({
      attemptRef: null,
      returnUrl: safeReturnUrl(returnUrl),
      createdAt: Date.now(),
      accepted: false,
    });
  }

  currentReturnUrl(): string | null {
    const pending = this.readPending();
    if (!pending) this.clear();
    return pending?.returnUrl ?? null;
  }

  stage(returnUrl: string): string | null {
    const pending: PendingReturn = {
      attemptRef: this.newAttemptRef(),
      returnUrl: safeReturnUrl(returnUrl),
      createdAt: Date.now(),
      accepted: false,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
      return pending.attemptRef;
    } catch {
      return null;
    }
  }

  markAccepted(attemptRef: string | null): void {
    if (!attemptRef) return;
    const pending = this.readPending();
    if (!pending || pending.attemptRef !== attemptRef) return;
    this.writePending({ ...pending, accepted: true });
  }

  hasAccepted(): boolean {
    const pending = this.readPending();
    if (!pending) this.clear();
    return pending?.accepted === true;
  }

  discard(attemptRef: string | null): void {
    if (!attemptRef) return;
    const pending = this.readPending();
    if (pending?.attemptRef !== attemptRef) return;
    this.clear();
  }

  takeForAuthenticatedSession(): string | null {
    const pending = this.readPending();
    this.clear();
    if (!pending || Date.now() - pending.createdAt > RETURN_LIFETIME_MS) return null;
    return safeReturnUrl(pending.returnUrl);
  }

  clear(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // No navigation authority is stored here; failure only loses the preferred return destination.
    }
  }

  private readPending(): PendingReturn | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const value: unknown = JSON.parse(raw);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
      const record = value as Record<string, unknown>;
      if (!(record['attemptRef'] === null || (typeof record['attemptRef'] === 'string' && /^[a-z0-9-]{16,128}$/.test(record['attemptRef']))) ||
          typeof record['returnUrl'] !== 'string' || typeof record['createdAt'] !== 'number' ||
          !Number.isFinite(record['createdAt']) || typeof record['accepted'] !== 'boolean' ||
          Date.now() - record['createdAt'] > RETURN_LIFETIME_MS || Date.now() < record['createdAt']) return null;
      return {
        attemptRef: record['attemptRef'] as string | null,
        returnUrl: safeReturnUrl(record['returnUrl']),
        createdAt: record['createdAt'],
        accepted: record['accepted'],
      };
    } catch {
      return null;
    }
  }

  private writePending(pending: PendingReturn): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
    } catch {
      // Keep browser session continuity best-effort when storage is disabled.
    }
  }

  private newAttemptRef(): string {
    const randomPart = globalThis.crypto?.randomUUID?.().replaceAll('-', '') ?? Math.random().toString(36).slice(2);
    return `${Date.now().toString(36)}-${randomPart}`;
  }
}
