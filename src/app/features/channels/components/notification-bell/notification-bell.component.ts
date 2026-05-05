import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Component, ElementRef, HostListener, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';
import { finalize, takeUntil } from 'rxjs/operators';
import { environment } from '../../../../../environments/environment';
import { WhatsAppTemplate } from '../../../../core/models/channel.model';

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
  TemplateName?: string;
  TemplateLanguage?: string;
  TemplateParams?: string[];
}

interface NotificationActionResponse {
  success: boolean;
  meta_response?: unknown;
}

@Component({
  selector: 'app-notification-bell',
  standalone: true,
  imports: [CommonModule, FormsModule],
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
  templatePickerNotificationId: number | null = null;
  templatesByNotification: Record<number, WhatsAppTemplate[]> = {};
  templateLoadingByNotification: Record<number, boolean> = {};
  templateErrorByNotification: Record<number, string> = {};
  selectedTemplateByNotification: Record<number, string> = {};
  templateParamsByNotification: Record<number, string[]> = {};

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
    actionType: NotificationActionPayload['ActionType'],
    extraPayload: Partial<NotificationActionPayload> = {}
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
      CompanyUUID: companyUUID,
      ...extraPayload
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
          if (this.templatePickerNotificationId === notification.Id) {
            this.templatePickerNotificationId = null;
          }
        },
        error: (error: unknown) => {
          console.error('Error while sending notification action:', error);
        }
      });
  }

  toggleTemplatePicker(notification: AppNotification): void {
    if (this.templatePickerNotificationId === notification.Id) {
      this.templatePickerNotificationId = null;
      return;
    }

    this.templatePickerNotificationId = notification.Id;
    this.templateErrorByNotification[notification.Id] = '';

    if (!this.templatesByNotification[notification.Id]?.length) {
      this.loadTemplates(notification);
    }
  }

  loadTemplates(notification: AppNotification): void {
    const companyUUID = this.getCompanyUUID();
    if (!companyUUID) {
      this.templateErrorByNotification[notification.Id] = 'Company UUID not found.';
      return;
    }

    this.templateLoadingByNotification[notification.Id] = true;
    this.templateErrorByNotification[notification.Id] = '';

    this.http
      .get<{ data: WhatsAppTemplate[] }>(
        `${this.API_BASE_URL}/whatsapp/templates?company_uuid=${encodeURIComponent(companyUUID)}&phone_number_id=${encodeURIComponent(notification.DestinationId)}`
      )
      .pipe(
        takeUntil(this.destroy$),
        finalize(() => {
          this.templateLoadingByNotification[notification.Id] = false;
        })
      )
      .subscribe({
        next: (response) => {
          this.templatesByNotification[notification.Id] = response.data || [];
          if (!this.selectedTemplateByNotification[notification.Id] && response.data?.length) {
            this.selectedTemplateByNotification[notification.Id] = response.data[0].name;
          }
          this.syncTemplateParams(notification.Id);
        },
        error: (error: unknown) => {
          console.error('Error while loading templates:', error);
          this.templateErrorByNotification[notification.Id] = 'Failed to load templates.';
        }
      });
  }

  sendTemplate(notification: AppNotification): void {
    const templateName = this.selectedTemplateByNotification[notification.Id];
    if (!templateName) {
      this.templateErrorByNotification[notification.Id] = 'Select a template first.';
      return;
    }

    const selectedTemplate = this.getSelectedTemplate(notification.Id);
    const templateLanguage = selectedTemplate?.language || 'en';
    const maxIndex = this.getTemplatePlaceholderMaxIndex(selectedTemplate);
    const params = (this.templateParamsByNotification[notification.Id] || []).slice(0, maxIndex);

    if (maxIndex > 0 && params.length < maxIndex) {
      while (params.length < maxIndex) {
        params.push('');
      }
    }

    if (maxIndex > 0 && params.some((value) => !value.trim())) {
      this.templateErrorByNotification[notification.Id] = 'Fill all placeholder values.';
      return;
    }

    this.handleAction(notification, 'SEND_TEMPLATE', {
      TemplateName: templateName,
      TemplateLanguage: templateLanguage,
      TemplateParams: params
    });
  }

  onTemplateSelectionChange(notification: AppNotification): void {
    this.templateErrorByNotification[notification.Id] = '';
    this.syncTemplateParams(notification.Id);
  }

  getTemplateBody(template: WhatsAppTemplate | undefined): string {
    if (!template?.components?.length) {
      return '';
    }

    const bodyComponent = template.components.find((component) => component.type === 'BODY');
    return bodyComponent?.text || '';
  }

  getTemplatePlaceholders(template: WhatsAppTemplate | undefined): string[] {
    const maxIndex = this.getTemplatePlaceholderMaxIndex(template);
    if (maxIndex === 0) {
      return [];
    }

    return Array.from({ length: maxIndex }, (_, index) => `{{${index + 1}}}`);
  }

  getSelectedTemplate(notificationId: number): WhatsAppTemplate | undefined {
    const selectedName = this.selectedTemplateByNotification[notificationId];
    return this.templatesByNotification[notificationId]?.find((template) => template.name === selectedName);
  }

  getSelectedTemplatePlaceholders(notificationId: number): string[] {
    return this.getTemplatePlaceholders(this.getSelectedTemplate(notificationId));
  }

  getTemplateParamValue(notificationId: number, index: number): string {
    return this.templateParamsByNotification[notificationId]?.[index] || '';
  }

  setTemplateParamValue(notificationId: number, index: number, value: string): void {
    if (!this.templateParamsByNotification[notificationId]) {
      this.templateParamsByNotification[notificationId] = [];
    }
    this.templateParamsByNotification[notificationId][index] = value;
  }

  private syncTemplateParams(notificationId: number): void {
    const template = this.getSelectedTemplate(notificationId);
    const maxIndex = this.getTemplatePlaceholderMaxIndex(template);
    const current = this.templateParamsByNotification[notificationId] || [];
    this.templateParamsByNotification[notificationId] = Array.from(
      { length: maxIndex },
      (_, index) => current[index] || ''
    );
  }

  private getTemplatePlaceholderMaxIndex(template: WhatsAppTemplate | undefined): number {
    const bodyText = this.getTemplateBody(template);
    const indices = this.getPlaceholderIndicesFromText(bodyText);
    return indices.length > 0 ? Math.max(...indices) : 0;
  }

  private getPlaceholderIndicesFromText(text: string): number[] {
    if (!text) {
      return [];
    }

    const matches = text.match(/\{\{\d+\}\}/g) || [];
    const indices = matches
      .map((match) => parseInt(match.replace(/\D/g, ''), 10))
      .filter((value) => !Number.isNaN(value));
    return Array.from(new Set(indices)).sort((a, b) => a - b);
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

  isTemplateLoading(notificationId: number): boolean {
    return this.templateLoadingByNotification[notificationId] === true;
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
