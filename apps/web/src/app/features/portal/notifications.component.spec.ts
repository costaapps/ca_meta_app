import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import type { components } from '@ca-meta/contracts';
import { PortalContextStore } from '../../core/portal/portal-context.store';
import { PortalSessionService } from '../../core/portal/portal-session.service';
import { NotificationsService } from '../../core/portal/notifications.service';
import { PortalTenantIdentityService, type TenantMutationCapability } from '../../core/portal/portal-tenant-identity.service';
import { NotificationsComponent } from './notifications.component';

type Notification = components['schemas']['Notification'];

const unconfirmedIdentity: TenantMutationCapability = Object.freeze({
  confirmed: false,
  reason: 'TENANT_IDENTITY_UNCONFIRMED',
  message: 'Identidade da empresa não confirmada',
});

const confirmedIdentity: TenantMutationCapability = Object.freeze({
  confirmed: true,
  tenantDisplayName: 'Empresa sintética',
  source: 'server-session',
});

function tenantIdentity(capability: TenantMutationCapability): PortalTenantIdentityService {
  return { get current() { return capability; } } as PortalTenantIdentityService;
}

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
        { provide: PortalTenantIdentityService, useValue: tenantIdentity(confirmedIdentity) },
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

  it('disables notification writes and guards programmatic actions without confirmed identity', async () => {
    const service = {
      list: vi.fn().mockResolvedValue({ items: [notice], nextCursor: null, requestId: 'req-notifications-unconfirmed' }),
      act: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [NotificationsComponent],
      providers: [
        { provide: NotificationsService, useValue: service },
        { provide: PortalSessionService, useValue: { ensureCurrentSession: vi.fn().mockResolvedValue(true) } },
        { provide: PortalContextStore, useValue: { contextChanged$: new Subject<void>(), sessionExpired$: new Subject<void>() } },
        { provide: PortalTenantIdentityService, useValue: tenantIdentity(unconfirmedIdentity) },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(NotificationsComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentRef.changeDetectorRef.detectChanges();
    const view = fixture.nativeElement as HTMLElement;
    expect(view.textContent).toContain('Identidade da empresa não confirmada');
    expect(view.textContent).toContain('Ações de alteração indisponíveis');
    const actionButtons = Array.from(view.querySelectorAll<HTMLButtonElement>('.notification-actions button'));
    expect(actionButtons.length).toBe(2);
    expect(actionButtons.every((button) => button.disabled)).toBe(true);
    expect(actionButtons.every((button) => button.getAttribute('aria-describedby') === 'tenant-identity-unconfirmed')).toBe(true);

    await fixture.componentInstance.apply(notice, 'MARK_READ');
    await fixture.componentInstance.apply(notice, 'DISMISS');
    expect(service.act).not.toHaveBeenCalled();
    expect(fixture.componentInstance.error).toBe('');
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
        { provide: PortalTenantIdentityService, useValue: tenantIdentity(unconfirmedIdentity) },
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

  it('keeps earlier notices when loading the next page', async () => {
    const contextChanged$ = new Subject<void>();
    const nextNotice: Notification = { ...notice, id: '00000000-0000-4000-8000-000000000063',
      createdAt: '2026-11-11T12:01:00.000Z' };
    const service = {
      list: vi.fn()
        .mockResolvedValueOnce({ items: [notice], nextCursor: 'cursor-next-page', requestId: 'req-notifications-page-one' })
        .mockResolvedValueOnce({ items: [nextNotice], nextCursor: null, requestId: 'req-notifications-page-two' }),
      act: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [NotificationsComponent],
      providers: [
        { provide: NotificationsService, useValue: service },
        { provide: PortalSessionService, useValue: { ensureCurrentSession: vi.fn().mockResolvedValue(true) } },
        { provide: PortalContextStore, useValue: { contextChanged$, sessionExpired$: new Subject<void>() } },
        { provide: PortalTenantIdentityService, useValue: tenantIdentity(unconfirmedIdentity) },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(NotificationsComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentRef.changeDetectorRef.detectChanges();
    expect(fixture.componentInstance.items.map((item) => item.id)).toEqual([notice.id]);
    await fixture.componentInstance.nextPage();
    expect(service.list).toHaveBeenNthCalledWith(2, 'cursor-next-page');
    expect(fixture.componentInstance.items.map((item) => item.id)).toEqual([notice.id, nextNotice.id]);
    fixture.destroy();
  });
});
