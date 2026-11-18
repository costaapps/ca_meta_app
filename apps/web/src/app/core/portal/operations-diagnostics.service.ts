import { HttpClient } from '@angular/common/http';
import { Inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { META_API_BASE_URL } from '../config/public-runtime-config';

export type OperationsDiagnosticState = 'HEALTHY' | 'ACTION_REQUIRED' | 'PENDING' | 'FAILED' | 'UNKNOWN';
export interface OperationsDiagnosticSection {
  readonly state: OperationsDiagnosticState;
  readonly reasonCode: string | null;
  readonly observedAt: string | null;
}
export interface OperationsDiagnostics {
  readonly requestId: string;
  readonly generatedAt: string;
  readonly versions: { readonly contract: '1.0.0-proposed'; readonly readModel: 1 };
  readonly onboarding: OperationsDiagnosticSection & { readonly nextAction: string | null };
  readonly credentialHealth: OperationsDiagnosticSection;
  readonly grants: OperationsDiagnosticSection & { readonly grantedCount: number | null; readonly revokedCount: number | null };
  readonly subscription: OperationsDiagnosticSection;
  readonly webhook: OperationsDiagnosticSection;
  readonly jobs: OperationsDiagnosticSection & { readonly counts: Readonly<Record<string, number>> };
  readonly projection: OperationsDiagnosticSection & { readonly pendingCount: number | null; readonly failedCount: number | null; readonly lagSeconds: null };
  readonly nextAction: 'REQUEST_REAUTHORIZATION' | 'WAIT_FOR_PROCESSING' | 'CONTACT_SUPPORT' | 'REVIEW_SYNC' | 'CHECK_CONNECTION' | 'NO_ACTION' | 'UNKNOWN';
}

export type OperationsActionRequest =
  | { readonly action: 'REVALIDATE'; readonly resourceRef: string; readonly reasonCode: 'INCIDENT' | 'CUSTOMER_REQUEST' | 'SECURITY_REVIEW' }
  | { readonly action: 'RESUME_STAGE'; readonly resourceRef: string; readonly stage: 'authorization' | 'asset-verification' | 'subscription' | 'projection'; readonly reasonCode: 'INCIDENT' | 'CUSTOMER_REQUEST' | 'SECURITY_REVIEW' }
  | { readonly action: 'RECONCILE_SUBSCRIPTION' | 'REQUEST_REAUTH' | 'REPLAY_JOB'; readonly resourceRef: string; readonly reasonCode: 'INCIDENT' | 'CUSTOMER_REQUEST' | 'SECURITY_REVIEW' };
export interface OperationsActionResult {
  readonly action: OperationsActionRequest['action'];
  readonly outcome: 'ACCEPTED' | 'DUPLICATE' | 'UNAVAILABLE' | 'REJECTED';
  readonly reasonCode: string;
  readonly requestId: string;
  readonly operationRef: string | null;
}

function apiV1BaseUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/v1') ? base : `${base || '/api'}/v1`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).length === allowed.length && Object.keys(value).every((key) => allowed.includes(key));
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isSection(value: unknown, keys: readonly string[] = ['state', 'reasonCode', 'observedAt']): value is OperationsDiagnosticSection {
  if (!record(value) || !exactKeys(value, keys)) return false;
  return ['HEALTHY', 'ACTION_REQUIRED', 'PENDING', 'FAILED', 'UNKNOWN'].includes(String(value['state'])) &&
    (value['reasonCode'] === null || (typeof value['reasonCode'] === 'string' && /^[A-Z0-9_]{1,64}$/.test(value['reasonCode']))) &&
    (value['observedAt'] === null || (typeof value['observedAt'] === 'string' && Number.isFinite(Date.parse(value['observedAt']))));
}

function isOperationsDiagnostics(value: unknown): value is OperationsDiagnostics {
  if (!record(value) || !exactKeys(value, ['requestId', 'generatedAt', 'versions', 'onboarding', 'credentialHealth', 'grants',
      'subscription', 'webhook', 'jobs', 'projection', 'nextAction']) || !record(value['versions']) ||
      !exactKeys(value['versions'], ['contract', 'readModel']) || !record(value['onboarding']) ||
      !exactKeys(value['onboarding'], ['state', 'reasonCode', 'observedAt', 'nextAction']) || !record(value['grants']) ||
      !exactKeys(value['grants'], ['state', 'reasonCode', 'observedAt', 'grantedCount', 'revokedCount']) ||
      !record(value['jobs']) || !record(value['projection'])) return false;
  const onboarding = value['onboarding'];
  const grants = value['grants'];
  const jobs = value['jobs'];
  const projection = value['projection'];
  if (!exactKeys(jobs, ['state', 'reasonCode', 'observedAt', 'counts']) || !record(jobs['counts']) ||
      !Object.entries(jobs['counts']).every(([key, value]) => /^[A-Z_]{1,24}$/.test(key) && count(value)) ||
      !exactKeys(projection, ['state', 'reasonCode', 'observedAt', 'pendingCount', 'failedCount', 'lagSeconds'])) return false;
  return typeof value['requestId'] === 'string' && /^[0-9a-f-]{36}$/i.test(value['requestId']) &&
    typeof value['generatedAt'] === 'string' && Number.isFinite(Date.parse(value['generatedAt'])) &&
    value['versions']['contract'] === '1.0.0-proposed' && value['versions']['readModel'] === 1 &&
    isSection(onboarding, ['state', 'reasonCode', 'observedAt', 'nextAction']) &&
    (onboarding['nextAction'] === null || typeof onboarding['nextAction'] === 'string') &&
    isSection(value['credentialHealth']) && isSection(grants, ['state', 'reasonCode', 'observedAt', 'grantedCount', 'revokedCount']) &&
    (grants['grantedCount'] === null || count(grants['grantedCount'])) &&
    (grants['revokedCount'] === null || count(grants['revokedCount'])) &&
    isSection(value['subscription']) && isSection(value['webhook']) &&
    isSection(jobs, ['state', 'reasonCode', 'observedAt', 'counts']) &&
    isSection(projection, ['state', 'reasonCode', 'observedAt', 'pendingCount', 'failedCount', 'lagSeconds']) &&
    (projection['pendingCount'] === null || count(projection['pendingCount'])) &&
    (projection['failedCount'] === null || count(projection['failedCount'])) && projection['lagSeconds'] === null &&
    ['REQUEST_REAUTHORIZATION', 'WAIT_FOR_PROCESSING', 'CONTACT_SUPPORT', 'REVIEW_SYNC', 'CHECK_CONNECTION', 'NO_ACTION', 'UNKNOWN']
      .includes(String(value['nextAction']));
}

@Injectable({ providedIn: 'root' })
export class OperationsDiagnosticsService {
  private readonly baseUrl: string;

  constructor(private readonly http: HttpClient, @Inject(META_API_BASE_URL) baseUrl: string) {
    this.baseUrl = apiV1BaseUrl(baseUrl);
  }

  async read(): Promise<OperationsDiagnostics> {
    const result: unknown = await firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/operations/diagnostics`));
    if (!isOperationsDiagnostics(result)) throw new Error('DIAGNOSTICS_RESPONSE_INVALID');
    return result;
  }

  requestAction(action: OperationsActionRequest, idempotencyKey: string): Promise<OperationsActionResult> {
    return firstValueFrom(this.http.post<OperationsActionResult>(`${this.baseUrl}/operations/actions`, action, {
      headers: { 'Idempotency-Key': idempotencyKey },
    }));
  }
}
