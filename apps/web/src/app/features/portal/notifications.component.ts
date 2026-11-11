import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subject, takeUntil } from 'rxjs';
import { PortalContextStore } from '../../core/portal/portal-context.store';
import { PortalSessionService } from '../../core/portal/portal-session.service';
import { safeRequestId } from '../../core/portal/safe-api-error';
import { NotificationsService, PortalNotification } from '../../core/portal/notifications.service';

@Component({
  selector: 'app-notifications',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './notifications.component.html',
  styleUrl: './notifications.component.scss',
})
export class NotificationsComponent implements OnInit, OnDestroy {
  items: readonly PortalNotification[] = [];
  nextCursor: string | null = null;
  isLoading = false;
  error = '';
  message = '';
  requestId: string | null = null;
  private readonly destroy$ = new Subject<void>();
  private generation = 0;
  private readonly acting = new Set<string>();

  constructor(
    private readonly service: NotificationsService,
    private readonly sessions: PortalSessionService,
    private readonly context: PortalContextStore,
  ) {}

  ngOnInit(): void {
    void this.load();
    this.context.contextChanged$.pipe(takeUntil(this.destroy$)).subscribe(() => void this.reloadForContext());
    this.context.sessionExpired$.pipe(takeUntil(this.destroy$)).subscribe(() => this.clearForExpiredSession());
  }

  ngOnDestroy(): void { this.destroy$.next(); this.destroy$.complete(); }

  async load(cursor?: string): Promise<void> {
    const generation = ++this.generation;
    this.isLoading = true;
    this.error = '';
    this.message = '';
    this.requestId = null;
    try {
      const page = await this.service.list(cursor);
      if (generation !== this.generation) return;
      this.items = page.items;
      this.nextCursor = page.nextCursor;
      this.requestId = page.requestId;
    } catch (error: unknown) {
      if (generation !== this.generation) return;
      this.items = [];
      this.nextCursor = null;
      this.error = 'Não foi possível carregar as notificações desta empresa.';
      this.requestId = safeRequestId(error);
    } finally {
      if (generation === this.generation) this.isLoading = false;
    }
  }

  async apply(item: PortalNotification, action: 'MARK_READ' | 'DISMISS'): Promise<void> {
    if (this.acting.has(item.id) || !item.actions.includes(action)) return;
    this.acting.add(item.id);
    this.error = '';
    this.message = '';
    try {
      const key = globalThis.crypto?.randomUUID?.();
      if (!key) throw new Error('A secure idempotency key is unavailable.');
      const result = await this.service.act(item.id, { action }, key);
      this.message = result.status === 'DISMISSED' ? 'Notificação dispensada.' : 'Notificação marcada como lida.';
      this.requestId = result.requestId;
      if (action === 'DISMISS') this.items = this.items.filter((entry) => entry.id !== item.id);
      else this.items = this.items.map((entry) => entry.id === item.id ? { ...entry, status: result.status,
        actions: entry.actions.filter((available) => available !== 'MARK_READ') } : entry);
    } catch (error: unknown) {
      this.error = 'Não foi possível confirmar a ação. Atualize as notificações antes de repetir.';
      this.requestId = safeRequestId(error);
    } finally {
      this.acting.delete(item.id);
    }
  }

  isActing(notificationId: string): boolean { return this.acting.has(notificationId); }
  async nextPage(): Promise<void> { if (this.nextCursor) await this.load(this.nextCursor); }
  trackById(_index: number, item: PortalNotification): string { return item.id; }

  private async reloadForContext(): Promise<void> {
    this.generation += 1;
    this.items = [];
    this.nextCursor = null;
    this.requestId = null;
    this.message = '';
    this.error = '';
    if (!await this.sessions.ensureCurrentSession(true)) {
      this.error = 'A sessão não está disponível para este contexto. Entre novamente.';
      return;
    }
    await this.load();
  }

  private clearForExpiredSession(): void {
    this.generation += 1;
    this.items = [];
    this.nextCursor = null;
    this.isLoading = false;
    this.requestId = null;
    this.message = '';
    this.error = 'Sua sessão terminou. Entre novamente para consultar as notificações.';
  }
}
