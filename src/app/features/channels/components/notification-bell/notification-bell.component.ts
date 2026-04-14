import { CommonModule } from '@angular/common';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Component, ElementRef, HostListener, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';
import { finalize, takeUntil } from 'rxjs/operators';
import { environment } from '../../../../../environments/environment';

export interface AppNotification {
  Id: number;
  IdDatabase: number;
  PlatformType: 'WHATSAPP' | 'FACEBOOK';
  OriginId: string;
  DestinationId: string;
  OriginName: string;
  MessageText: string;
  IsRead: number;
  CreatedAt: string;
}

export interface GetNotificationsResponse {
  success: boolean;
  data: AppNotification[];
}

export interface NotificationActionPayload {
  NotificationId: number;
  ActionType: 'SEND_TEMPLATE' | 'SEND_MESSAGE' | 'REPLY_COMMENT';
  CompanyUUID: string;
}

interface NotificationActionResponse {
  success: boolean;
  meta_response?: unknown;
}

@Component({
  selector: 'app-notification-bell',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './notification-bell.component.html',
  styleUrls: ['./notification-bell.component.scss']
})
export class NotificationBellComponent implements OnDestroy {
  private readonly API_BASE_URL = environment.backEndUrl;
  private readonly COMPANY_UUID_STORAGE_KEY = 'cUUID';
  private readonly MIN_REFRESH_INTERVAL_MS = 3000;

  notifications: AppNotification[] = [];
  isDropdownOpen = false;
  isRefreshing = false;
  lastUpdatedAt: Date | null = null;
  refreshErrorMessage = '';
  loadingActionByNotification: Record<number, NotificationActionPayload['ActionType'] | null> = {};

  private readonly destroy$ = new Subject<void>();
  private lastRefreshRequestAt = 0;

  constructor(
    private http: HttpClient,
    private hostRef: ElementRef<HTMLElement>
  ) {}

  get unreadCount(): number {
    return this.notifications.filter((notification) => notification.IsRead === 0).length;
  }

  get hasNotifications(): boolean {
    return this.notifications.length > 0;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as Node;

    if (!this.hostRef.nativeElement.contains(target)) {
      this.isDropdownOpen = false;
    }
  }

  toggleDropdown(event?: MouseEvent): void {
    event?.stopPropagation();
    this.isDropdownOpen = !this.isDropdownOpen;
  }

  refreshNotifications(): void {
    if (this.isRefreshing) {
      return;
    }

    const now = Date.now();
    if (now - this.lastRefreshRequestAt < this.MIN_REFRESH_INTERVAL_MS) {
      return;
    }

    this.lastRefreshRequestAt = now;

    const companyUUID = this.getCompanyUUID();
    if (!companyUUID) {
      this.notifications = [];
      this.refreshErrorMessage = 'Company UUID not found.';
      return;
    }

    this.isRefreshing = true;
    this.refreshErrorMessage = '';

    this.http
      .get<GetNotificationsResponse>(
        `${this.API_BASE_URL}/notifications?company_uuid=${encodeURIComponent(companyUUID)}`
      )
      .pipe(
        takeUntil(this.destroy$),
        finalize(() => {
          this.isRefreshing = false;
        })
      )
      .subscribe({
        next: (response: GetNotificationsResponse) => {
          if (!response.success) {
            console.error('Notification fetch failed: success is false');
            this.refreshErrorMessage = 'Unable to refresh notifications.';
            return;
          }

          this.notifications = response.data;
          this.lastUpdatedAt = new Date();
        },
        error: (error: unknown) => {
          console.error('Error while loading notifications:', error);
          this.refreshErrorMessage = 'Error while loading notifications.';
        }
      });
  }

  handleAction(
    notification: AppNotification,
    actionType: NotificationActionPayload['ActionType']
  ): void {
    if (this.isNotificationLoading(notification.Id)) {
      return;
    }

    const companyUUID = this.getCompanyUUID();
    if (!companyUUID) {
      console.warn('Company UUID is missing. Skipping notification action.');
      return;
    }

    const payload: NotificationActionPayload = {
      NotificationId: notification.Id,
      ActionType: actionType,
      CompanyUUID: companyUUID
    };

    this.loadingActionByNotification[notification.Id] = actionType;

    this.http
      .post<NotificationActionResponse>(`${this.API_BASE_URL}/notifications/action`, payload, {
        headers: new HttpHeaders({ 'Content-Type': 'application/json' })
      })
      .pipe(
        takeUntil(this.destroy$),
        finalize(() => {
          delete this.loadingActionByNotification[notification.Id];
        })
      )
      .subscribe({
        next: (response) => {
          if (!response.success) {
            console.error('Notification action failed: success is false');
            return;
          }

          // Optimistic update after successful action response.
          this.notifications = this.notifications.filter((item) => item.Id !== notification.Id);
        },
        error: (error: unknown) => {
          console.error('Error while sending notification action:', error);
        }
      });
  }

  isNotificationLoading(notificationId: number): boolean {
    return this.loadingActionByNotification[notificationId] != null;
  }

  isActionLoading(
    notificationId: number,
    actionType: NotificationActionPayload['ActionType']
  ): boolean {
    return this.loadingActionByNotification[notificationId] === actionType;
  }

  trackByNotificationId(_: number, notification: AppNotification): number {
    return notification.Id;
  }

  private getCompanyUUID(): string {
    return localStorage.getItem(this.COMPANY_UUID_STORAGE_KEY) || '';
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
