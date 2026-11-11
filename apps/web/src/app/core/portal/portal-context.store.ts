import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

const CONTEXT_STORAGE_KEY = 'ca.meta.portal.context-ref.v1';
const CONTEXT_REF = /^[A-Za-z0-9_-]{16,512}$/;

/** Holds only the server-issued, non-authoritative context selector for the current browser tab. */
@Injectable({ providedIn: 'root' })
export class PortalContextStore {
  private contextRefValue: string | null = this.readStoredContext();
  private readonly contextChangedSubject = new Subject<void>();
  private readonly sessionExpiredSubject = new Subject<void>();

  readonly contextChanged$ = this.contextChangedSubject.asObservable();
  readonly sessionExpired$ = this.sessionExpiredSubject.asObservable();

  get contextRef(): string | null {
    return this.contextRefValue;
  }

  setContextRef(value: string): void {
    if (!CONTEXT_REF.test(value)) {
      this.clearContextRef();
      return;
    }
    this.contextRefValue = value;
    try {
      sessionStorage.setItem(CONTEXT_STORAGE_KEY, value);
    } catch {
      // Storage is an optimization for refresh recovery; the session cookie remains authoritative.
    }
  }

  clearContextRef(): void {
    this.contextRefValue = null;
    try {
      sessionStorage.removeItem(CONTEXT_STORAGE_KEY);
    } catch {
      // In-memory state is still cleared when storage is disabled.
    }
  }

  contextChanged(): void {
    this.clearContextRef();
    this.contextChangedSubject.next();
  }

  sessionExpired(): void {
    this.clearContextRef();
    this.sessionExpiredSubject.next();
  }

  private readStoredContext(): string | null {
    try {
      const value = sessionStorage.getItem(CONTEXT_STORAGE_KEY);
      return value && CONTEXT_REF.test(value) ? value : null;
    } catch {
      return null;
    }
  }
}

export function readCsrfCookie(cookie: string): string | null {
  const prefix = '__Host-ca_meta_csrf=';
  const entry = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  if (!entry) return null;
  const value = entry.slice(prefix.length);
  return /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : null;
}
