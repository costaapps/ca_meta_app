import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { components } from '@ca-meta/contracts';
import { META_API_BASE_URL } from '../config/public-runtime-config';
import { normalizeApiV1BaseUrl } from './portal-session.service';

export type PortalNotification = components['schemas']['Notification'];
export type NotificationPage = components['schemas']['NotificationListPage'];
export type NotificationAction = components['schemas']['NotificationActionRequest'];
export type NotificationActionResult = components['schemas']['NotificationActionResult'];
export type NotificationOperation = components['schemas']['OperationStatus'];

@Injectable({ providedIn: 'root' })
export class NotificationsService {
  private readonly baseUrl: string;

  constructor(private readonly http: HttpClient, @Inject(META_API_BASE_URL) baseUrl: string) {
    this.baseUrl = normalizeApiV1BaseUrl(baseUrl);
  }

  list(cursor?: string): Promise<NotificationPage> {
    let params = new HttpParams().set('limit', '50');
    if (cursor) params = params.set('cursor', cursor);
    return firstValueFrom(this.http.get<NotificationPage>(`${this.baseUrl}/notifications`, { params }));
  }

  act(notificationId: string, action: NotificationAction, idempotencyKey: string): Promise<NotificationActionResult> {
    if (!/^[A-Za-z0-9._~-]{16,128}$/.test(idempotencyKey)) throw new Error('A valid idempotency key is required.');
    return firstValueFrom(this.http.post<NotificationActionResult>(
      `${this.baseUrl}/notifications/${encodeURIComponent(notificationId)}/actions`, action,
      { headers: new HttpHeaders({ 'Idempotency-Key': idempotencyKey }) },
    ));
  }

  operation(operationId: string): Promise<NotificationOperation> {
    return firstValueFrom(this.http.get<NotificationOperation>(`${this.baseUrl}/operations/${encodeURIComponent(operationId)}`));
  }
}
