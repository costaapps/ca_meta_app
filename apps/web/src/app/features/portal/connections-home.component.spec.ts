import { Subject } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { ChangeDetectorRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ConnectionCatalogFilters, ConnectionListPage } from '../../core/portal/connection-catalog.service';
import { ConnectionCatalogService, connectionStatusCopy } from '../../core/portal/connection-catalog.service';
import { PortalContextStore } from '../../core/portal/portal-context.store';
import { PortalSessionService } from '../../core/portal/portal-session.service';
import { MetaFlowCatalogService } from '../../core/portal/meta-flow-catalog.service';
import { ConnectionRecord } from '../../core/portal/connection-catalog.service';
import { connectionFixtures } from './fixtures/connection-catalog.fixtures';
import { ConnectionsHomeComponent } from './connections-home.component';

function listPage(items: readonly ConnectionRecord[], nextCursor: string | null, requestId: string): ConnectionListPage {
  return { items, nextCursor, requestId };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createComponent(list: (filters: ConnectionCatalogFilters, cursor?: string) => Promise<ConnectionListPage>, ensureCurrentSession = vi.fn().mockResolvedValue({})) {
  const changes = new Subject<void>();
  const sessionExpired = new Subject<void>();
  const catalog = { list: vi.fn(list) } as unknown as ConnectionCatalogService;
  const flowCatalog = { load: vi.fn().mockResolvedValue({}), cards: vi.fn().mockReturnValue([]) } as unknown as MetaFlowCatalogService;
  const sessions = { ensureCurrentSession } as unknown as PortalSessionService;
  const context = { contextChanged$: changes.asObservable(), sessionExpired$: sessionExpired.asObservable() } as unknown as PortalContextStore;
  const component = new ConnectionsHomeComponent(flowCatalog, catalog, sessions, context, { markForCheck: vi.fn() } as unknown as ChangeDetectorRef);
  return { component, list: catalog.list as unknown as ReturnType<typeof vi.fn>, changes };
}

describe('ConnectionsHomeComponent', () => {
  it('renders the list request ID alongside a list error for support', async () => {
    await TestBed.configureTestingModule({
      imports: [ConnectionsHomeComponent],
      providers: [
        provideRouter([]),
        { provide: MetaFlowCatalogService, useValue: { load: vi.fn().mockResolvedValue({}), cards: vi.fn().mockReturnValue([]) } },
        { provide: ConnectionCatalogService, useValue: { list: vi.fn().mockRejectedValue(new HttpErrorResponse({ status: 503, error: { requestId: 'req-list-error-01' } })) } },
        { provide: PortalSessionService, useValue: { ensureCurrentSession: vi.fn() } },
        { provide: PortalContextStore, useValue: { contextChanged$: new Subject<void>(), sessionExpired$: new Subject<void>() } },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(ConnectionsHomeComponent);
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();

    const view = fixture.nativeElement as HTMLElement;
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('Não foi possível carregar as conexões.');
    expect(view.textContent).toContain('Referência da solicitação: req-list-error-01');
    fixture.destroy();
  });

  it('applies product, modality, status and number filters to the server, then follows its opaque cursor', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce(listPage([connectionFixtures[0]!], 'opaque-server-cursor-0001', 'req-page-01'))
      .mockResolvedValueOnce(listPage([connectionFixtures[1]!], 'opaque-server-cursor-0002', 'req-page-02'))
      .mockResolvedValueOnce(listPage([connectionFixtures[4]!], null, 'req-page-03'));
    const { component } = createComponent(list);
    component.ngOnInit();
    await settle();

    component.filters = { channel: 'WHATSAPP', flowVariant: 'WHATSAPP_COEXISTENCE', number: '+15555550123', status: 'PARTIAL' };
    await component.applyFilters();
    expect(list).toHaveBeenNthCalledWith(2, {
      channel: 'WHATSAPP', flowVariant: 'WHATSAPP_COEXISTENCE', number: '+15555550123', status: 'PARTIAL',
    }, undefined);
    expect(component.connections).toEqual([connectionFixtures[1]]);
    expect(component.pageIndex).toBe(0);

    await component.nextPage();
    expect(list).toHaveBeenNthCalledWith(3, {
      channel: 'WHATSAPP', flowVariant: 'WHATSAPP_COEXISTENCE', number: '+15555550123', status: 'PARTIAL',
    }, 'opaque-server-cursor-0002');
    expect(component.pageIndex).toBe(1);
  });

  it('clears the prior tenant page before resolving a changed server session', async () => {
    let releaseStaleRead: ((page: ConnectionListPage) => void) | undefined;
    const staleRead = new Promise<ConnectionListPage>((resolve) => { releaseStaleRead = resolve; });
    const ensureCurrentSession = vi.fn().mockResolvedValue({});
    const list = vi.fn()
      .mockResolvedValueOnce(listPage([connectionFixtures[0]!], 'tenant-a-cursor-0001', 'req-tenant-a'))
      .mockReturnValueOnce(staleRead)
      .mockResolvedValueOnce(listPage([connectionFixtures[4]!], null, 'req-tenant-b'));
    const { component, changes } = createComponent(list, ensureCurrentSession);
    component.ngOnInit();
    await settle();
    expect(component.connections).toEqual([connectionFixtures[0]]);

    component.filters = { channel: 'WHATSAPP', flowVariant: 'WHATSAPP_COEXISTENCE', number: '', status: '' };
    const oldTenantRead = component.applyFilters();
    changes.next();
    expect(component.connections).toEqual([]);
    expect(component.listRequestId).toBeNull();
    expect(component.nextCursor).toBeNull();
    await settle();
    expect(component.connections).toEqual([connectionFixtures[4]]);
    expect(component.pageIndex).toBe(0);

    releaseStaleRead?.(listPage([connectionFixtures[0]!], null, 'req-stale-tenant-a'));
    await oldTenantRead;
    expect(component.connections).toEqual([connectionFixtures[4]]);
  });

  it('uses text cues for READY, PARTIAL, UNKNOWN and stale without calling stale data a lost number', () => {
    expect(connectionStatusCopy(connectionFixtures[0]!)).toContain('Conectado');
    expect(connectionStatusCopy(connectionFixtures[1]!)).toContain('Conexão parcial');
    expect(connectionStatusCopy(connectionFixtures[3]!)).toContain('o status pode ter mudado');
    expect(connectionStatusCopy({ ...connectionFixtures[3]!, stale: false })).toContain('não foi possível confirmar');
  });
});
