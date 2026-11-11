import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import type { components } from '@ca-meta/contracts';
import { PortalContextStore } from '../../core/portal/portal-context.store';
import { PortalSessionService } from '../../core/portal/portal-session.service';
import { NotificationsService } from '../../core/portal/notifications.service';
import { NotificationsComponent } from './notifications.component';

type Notification = components['schemas']['Notification'];

const notice: Notification = {
  id: '00000000-0000-4000-8000-000000000061',
  kind: 'MESSAGE_RECEIVED',
  assetRef: '00000000-0000-4000-8000-000000000062',
  messageRef: null,
  status: 'UNREAD',
  safeSummary: 'A new WhatsApp message is available.',
  createdAt: '2026-11-11T12:00:00.000Z',
  actions: ['MARK_READ', 'DISMISS'],
};

describe('NotificationsComponent', () => {
  it('shows tenant scoped safe notices and records READ only after a successful local action', async () => {
    const contextChanged$ = new Subject<void>();
    const sessionExpired$ = new Subject<void>();
    const service = {
      list: vi.fn().mockResolvedValue({ items: [notice], nextCursor: null, requestId: 'req-notifications-ui' }),
      act: vi.fn().mockResolvedValue({ notificationId: notice.id, action: 'MARK_READ', status: 'READ', requestId: 'req-notifications-action' }),
    };
    await TestBed.configureTestingModule({
      imports: [NotificationsComponent],
      providers: [
        { provide: NotificationsService, useValue: service },
        { provide: PortalSessionService, useValue: { ensureCurrentSession: vi.fn().mockResolvedValue(true) } },
        { provide: PortalContextStore, useValue: { contextChanged$, sessionExpired$ } },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(NotificationsComponent);
    fixture.detectChanges();
    await fixture.componentInstance.load();
    fixture.componentRef.changeDetectorRef.detectChanges();
    let view = fixture.nativeElement as HTMLElement;
    expect(view.textContent).toContain('A new WhatsApp message is available.');
    expect(view.textContent).toContain('Marcar como lida');
    expect(view.textContent).toContain('Dispensar');
    expect(view.textContent).not.toContain('Enviar mensagem');

    const readButton = Array.from(view.querySelectorAll('button')).find((button) => button.textContent?.includes('Marcar como lida'));
    expect(readButton).toBeTruthy();
    readButton?.click();
    await fixture.whenStable();
    fixture.componentRef.changeDetectorRef.detectChanges();
    expect(service.act).toHaveBeenCalledWith(notice.id, { action: 'MARK_READ' }, expect.stringMatching(/^[0-9a-f-]{36}$/i));
    expect(fixture.componentInstance.items[0]?.status).toBe('READ');
    expect(fixture.componentInstance.message).toBe('Notificação marcada como lida.');

    service.act.mockRejectedValueOnce({ status: 503, error: { requestId: 'req-action-unavailable' } });
    await fixture.componentInstance.apply({ ...notice, status: 'UNREAD' }, 'DISMISS');
    expect(fixture.componentInstance.error).toContain('Não foi possível confirmar a ação');
    expect(fixture.componentInstance.message).toBe('');
    fixture.destroy();
  });

  it('clears the displayed tenant context before loading after a session context change', async () => {
    const contextChanged$ = new Subject<void>();
    const sessions = { ensureCurrentSession: vi.fn().mockResolvedValue(true) };
    const service = {
      list: vi.fn().mockResolvedValueOnce({ items: [notice], nextCursor: null, requestId: 'req-notifications-old' })
        .mockResolvedValueOnce({ items: [], nextCursor: null, requestId: 'req-notifications-new' }),
      act: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [NotificationsComponent],
      providers: [
        { provide: NotificationsService, useValue: service },
        { provide: PortalSessionService, useValue: sessions },
        { provide: PortalContextStore, useValue: { contextChanged$, sessionExpired$: new Subject<void>() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(NotificationsComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentRef.changeDetectorRef.detectChanges();
    expect(fixture.componentInstance.items.length).toBe(1);
    contextChanged$.next();
    expect(sessions.ensureCurrentSession).toHaveBeenCalledWith(true);
    expect(fixture.componentInstance.items).toEqual([]);
    fixture.destroy();
  });
});
