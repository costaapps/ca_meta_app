import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Inject, Injectable } from '@angular/core';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { META_API_BASE_URL } from '../config/public-runtime-config';
import { PortalContextStore } from './portal-context.store';

export type PortalRole = 'owner' | 'admin' | 'operator' | 'viewer';

export interface PortalSession {
  readonly sessionRef?: string;
  readonly principalRef: string;
  readonly tenantRef: string;
  readonly roles: readonly PortalRole[];
  readonly tenantContextRef: string;
  readonly contextVersion: number;
  readonly requestId: string;
}

export type PortalEntryNotice = 'membership' | 'unavailable' | null;

function apiV1BaseUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.endsWith('/v1')) return base;
  return `${base || '/api'}/v1`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPortalSession(value: unknown): value is PortalSession {
  if (!isRecord(value)) return false;
  const allowed = ['sessionRef', 'principalRef', 'tenantRef', 'roles', 'tenantContextRef', 'contextVersion', 'requestId'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
  return (value['sessionRef'] === undefined || (typeof value['sessionRef'] === 'string' && value['sessionRef'].length <= 128)) &&
    typeof value['principalRef'] === 'string' && value['principalRef'].length > 0 && value['principalRef'].length <= 128 &&
    typeof value['tenantRef'] === 'string' && value['tenantRef'].length > 0 && value['tenantRef'].length <= 128 &&
    Array.isArray(value['roles']) && value['roles'].length > 0 && value['roles'].length <= 8 &&
    value['roles'].every((role) => ['owner', 'admin', 'operator', 'viewer'].includes(String(role))) &&
    typeof value['tenantContextRef'] === 'string' && /^[A-Za-z0-9_-]{16,512}$/.test(value['tenantContextRef']) &&
    Number.isSafeInteger(value['contextVersion']) && Number(value['contextVersion']) >= 1 &&
    typeof value['requestId'] === 'string' && value['requestId'].length > 0 && value['requestId'].length <= 128;
}

@Injectable({ providedIn: 'root' })
export class PortalSessionService {
  private readonly baseUrl: string;
  private readonly sessionSubject = new BehaviorSubject<PortalSession | null>(null);
  private readonly entryNoticeSubject = new BehaviorSubject<PortalEntryNotice>(null);
  private pendingLoad?: Promise<PortalSession | null>;

  readonly session$ = this.sessionSubject.asObservable();
  readonly entryNotice$ = this.entryNoticeSubject.asObservable();

  constructor(
    private readonly http: HttpClient,
    private readonly context: PortalContextStore,
    @Inject(META_API_BASE_URL) baseUrl: string,
  ) {
    this.baseUrl = apiV1BaseUrl(baseUrl);
  }

  get current(): PortalSession | null {
    return this.sessionSubject.value;
  }

  get entryNotice(): PortalEntryNotice {
    return this.entryNoticeSubject.value;
  }

  ensureCurrentSession(forceRefresh = false): Promise<PortalSession | null> {
    if (!forceRefresh && this.current) return Promise.resolve(this.current);
    if (this.pendingLoad) return this.pendingLoad;
    this.pendingLoad = this.loadCurrentSession(true).finally(() => { this.pendingLoad = undefined; });
    return this.pendingLoad;
  }

  async refreshAfterContextChange(): Promise<PortalSession | null> {
    this.context.clearContextRef();
    this.sessionSubject.next(null);
    return this.ensureCurrentSession(true);
  }

  async logout(): Promise<void> {
    await firstValueFrom(this.http.post<void>(`${this.baseUrl}/session/logout`, null));
    this.context.clearContextRef();
    this.sessionSubject.next(null);
    this.entryNoticeSubject.next(null);
  }

  async requestDirectEntry(email: string): Promise<void> {
    await firstValueFrom(this.http.post<unknown>(`${this.baseUrl}/auth/magic-links`, { email }));
  }

  clearLocalSession(): void {
    this.context.clearContextRef();
    this.sessionSubject.next(null);
  }

  private async loadCurrentSession(allowContextRecovery: boolean): Promise<PortalSession | null> {
    try {
      const result: unknown = await firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/session`));
      if (!isPortalSession(result)) {
        this.clearLocalSession();
        this.entryNoticeSubject.next('unavailable');
        return null;
      }
      this.context.setContextRef(result.tenantContextRef);
      this.sessionSubject.next(result);
      this.entryNoticeSubject.next(null);
      return result;
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 409 && allowContextRecovery) {
        this.context.clearContextRef();
        return this.loadCurrentSession(false);
      }
      this.clearLocalSession();
      this.entryNoticeSubject.next(error instanceof HttpErrorResponse && error.status === 403 ? 'membership' : 'unavailable');
      return null;
    }
  }
}

export function normalizeApiV1BaseUrl(baseUrl: string): string {
  return apiV1BaseUrl(baseUrl);
}
