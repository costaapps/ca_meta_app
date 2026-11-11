import { Injectable } from '@angular/core';
import { safeReturnUrl } from './safe-return-url';

const RETURN_PATH_STORAGE_KEY = 'ca.meta.portal.pending-return.v1';
const ENTRY_ATTEMPT_STORAGE_KEY = 'ca.meta.portal.entry-attempt.v1';
const RETURN_LIFETIME_MS = 30 * 60 * 1000;

interface PendingReturnPath {
  readonly returnUrl: string;
  readonly createdAt: number;
}

interface EntryAttempt {
  readonly attemptRef: string;
  readonly createdAt: number;
  readonly accepted: boolean;
}

@Injectable({ providedIn: 'root' })
export class PortalEntryReturnStore {
  remember(returnUrl: string): void {
    this.write(RETURN_PATH_STORAGE_KEY, {
      returnUrl: safeReturnUrl(returnUrl),
      createdAt: Date.now(),
    } satisfies PendingReturnPath);
  }

  currentReturnUrl(): string | null {
    const pending = this.readReturnPath();
    if (!pending) this.remove(RETURN_PATH_STORAGE_KEY);
    return pending?.returnUrl ?? null;
  }

  stage(returnUrl: string): string | null {
    this.remember(returnUrl);
    const attempt: EntryAttempt = {
      attemptRef: this.newAttemptRef(),
      createdAt: Date.now(),
      accepted: false,
    };
    return this.write(ENTRY_ATTEMPT_STORAGE_KEY, attempt) ? attempt.attemptRef : null;
  }

  markAccepted(attemptRef: string | null): void {
    if (!attemptRef) return;
    const attempt = this.readAttempt();
    if (!attempt || attempt.attemptRef !== attemptRef) return;
    this.write(ENTRY_ATTEMPT_STORAGE_KEY, { ...attempt, accepted: true });
  }

  hasAccepted(): boolean {
    const attempt = this.readAttempt();
    if (!attempt) this.remove(ENTRY_ATTEMPT_STORAGE_KEY);
    return attempt?.accepted === true;
  }

  hasUnacceptedAttempt(): boolean {
    const attempt = this.readAttempt();
    if (!attempt) this.remove(ENTRY_ATTEMPT_STORAGE_KEY);
    return attempt !== null && !attempt.accepted;
  }

  discard(attemptRef: string | null): void {
    if (!attemptRef) return;
    const attempt = this.readAttempt();
    if (attempt?.attemptRef === attemptRef) this.remove(ENTRY_ATTEMPT_STORAGE_KEY);
  }

  /** Returns a local navigation preference after session validation; concurrent tabs may replay it harmlessly. */
  takeForAuthenticatedSession(): string | null {
    const attempt = this.readAttempt();
    if (attempt && !attempt.accepted) return null;

    const pending = this.readReturnPath();
    this.remove(ENTRY_ATTEMPT_STORAGE_KEY);
    this.remove(RETURN_PATH_STORAGE_KEY);
    return pending?.returnUrl ?? null;
  }

  private readReturnPath(): PendingReturnPath | null {
    const value = this.read(RETURN_PATH_STORAGE_KEY);
    if (!this.isRecord(value) || typeof value['returnUrl'] !== 'string' || typeof value['createdAt'] !== 'number' ||
        !this.isFresh(value['createdAt'])) return null;
    return { returnUrl: safeReturnUrl(value['returnUrl']), createdAt: value['createdAt'] };
  }

  private readAttempt(): EntryAttempt | null {
    const value = this.read(ENTRY_ATTEMPT_STORAGE_KEY);
    if (!this.isRecord(value) || typeof value['attemptRef'] !== 'string' ||
        !/^[a-z0-9-]{16,128}$/.test(value['attemptRef']) || typeof value['createdAt'] !== 'number' ||
        !this.isFresh(value['createdAt']) || typeof value['accepted'] !== 'boolean') return null;
    return {
      attemptRef: value['attemptRef'],
      createdAt: value['createdAt'],
      accepted: value['accepted'],
    };
  }

  private read(key: string): unknown {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) as unknown : null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: unknown): boolean {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      // The route is a navigation preference only; disabled storage falls back to the connections page.
      return false;
    }
  }

  private remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // The stored path is not an identity or authorization credential.
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private isFresh(createdAt: number): boolean {
    return Number.isFinite(createdAt) && Date.now() >= createdAt && Date.now() - createdAt <= RETURN_LIFETIME_MS;
  }

  private newAttemptRef(): string {
    const randomPart = globalThis.crypto?.randomUUID?.().replaceAll('-', '') ?? Math.random().toString(36).slice(2);
    return `${Date.now().toString(36)}-${randomPart}`;
  }
}
