import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { provideRouter } from '@angular/router';
import { ChangeDetectorRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EMPTY, NEVER, Subject, of } from 'rxjs';
import { ConnectionCatalogService, assetStatusCopy, authorizationStatusCopy, connectionStatusCopy, credentialHealthCopy } from '../../core/portal/connection-catalog.service';
import { PortalContextStore } from '../../core/portal/portal-context.store';
import { PortalSessionService } from '../../core/portal/portal-session.service';
import { coexistenceDetailFixture, fourWhatsAppNumbers, staleRevokedPageFixture } from './fixtures/connection-catalog.fixtures';
import { ConnectionRecordDetailComponent } from './connection-record-detail.component';

describe('ConnectionRecordDetailComponent', () => {
  it('clears visible detail and ignores a pending response after session expiration', async () => {
    let resolveDetail!: (detail: typeof coexistenceDetailFixture) => void;
    const pendingDetail = new Promise<typeof coexistenceDetailFixture>((resolve) => { resolveDetail = resolve; });
    const sessionExpired = new Subject<void>();
    const markForCheck = vi.fn();
    const component = new ConnectionRecordDetailComponent(
      { paramMap: of(convertToParamMap({ id: coexistenceDetailFixture.id })) } as unknown as ActivatedRoute,
      { detail: vi.fn().mockReturnValue(pendingDetail) } as unknown as ConnectionCatalogService,
      {} as PortalSessionService,
      { contextChanged$: NEVER, sessionExpired$: sessionExpired.asObservable() } as unknown as PortalContextStore,
      { markForCheck } as unknown as ChangeDetectorRef,
    );

    component.connection = coexistenceDetailFixture;
    component.errorRequestId = 'req-prior-connection';
    component.ngOnInit();
    sessionExpired.next();

    expect(component.connection).toBeNull();
    expect(component.isLoading).toBe(false);
    expect(component.errorMessage).toBe('Sua sessão terminou. Entre novamente para ver os detalhes desta conexão.');
    expect(component.errorRequestId).toBeNull();
    expect(markForCheck).toHaveBeenCalled();

    resolveDetail(coexistenceDetailFixture);
    await Promise.resolve();
    await Promise.resolve();
    expect(component.connection).toBeNull();
    expect(component.errorMessage).toBe('Sua sessão terminou. Entre novamente para ver os detalhes desta conexão.');
    component.ngOnDestroy();
  });

  it('keeps four WhatsApp numbers distinct by safe masked labels and per-row ordinals', () => {
    const component = new ConnectionRecordDetailComponent(
      {} as ActivatedRoute, {} as ConnectionCatalogService, {} as PortalSessionService, {} as PortalContextStore,
      { markForCheck: vi.fn() } as unknown as ChangeDetectorRef,
    );
    component.connection = coexistenceDetailFixture;

    expect(new Set(fourWhatsAppNumbers.map((asset) => asset.displayLabel)).size).toBe(4);
    expect(coexistenceDetailFixture.assets.map((asset, index) => component.assetTitle(asset, index))).toEqual([
      'Número do WhatsApp 1', 'Número do WhatsApp 2', 'Número do WhatsApp 3', 'Número do WhatsApp 4',
    ]);
    expect(coexistenceDetailFixture.assets.map((asset) => asset.id)).toHaveLength(4);
  });

  it('preserves stale and revoked dimensions without presenting a stale number as lost', () => {
    const revoked = staleRevokedPageFixture.assets[0]!;
    expect(assetStatusCopy(revoked)).toContain('não confirma perda');
    expect(authorizationStatusCopy(revoked.authorizationStatus)).toContain('revogada');
    expect(connectionStatusCopy(staleRevokedPageFixture)).toContain('status pode ter mudado');
    expect(credentialHealthCopy('ACTION_REQUIRED')).toContain('ação');
  });

  it('shows admin actions only when the server capability grants them and keeps writes disabled without a safe company label', () => {
    const component = new ConnectionRecordDetailComponent(
      {} as ActivatedRoute, {} as ConnectionCatalogService, {} as PortalSessionService, {} as PortalContextStore,
      { markForCheck: vi.fn() } as unknown as ChangeDetectorRef,
    );
    const adminAsset = staleRevokedPageFixture.assets[0]!;
    const viewerAsset = {
      ...adminAsset,
      capabilities: { canSend: false, canManageTemplates: false, canSubscribe: false, canReauthorize: false, canDisconnect: false },
    };

    expect(component.canShowReauthorization(adminAsset)).toBe(true);
    expect(component.canShowDisconnect(adminAsset)).toBe(true);
    expect(component.canShowReauthorization(viewerAsset)).toBe(false);
    expect(component.canShowDisconnect(viewerAsset)).toBe(false);
    expect(component.writesAllowed).toBe(false);
    expect(component.writesUnavailableCopy).toContain('Identidade da empresa não confirmada');
  });

  it('renders readable status text, secondary support details, and disabled role-scoped actions', async () => {
    await TestBed.configureTestingModule({
      imports: [ConnectionRecordDetailComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { paramMap: EMPTY } },
        { provide: ConnectionCatalogService, useValue: { detail: vi.fn() } },
        { provide: PortalSessionService, useValue: { current: null, ensureCurrentSession: vi.fn() } },
        { provide: PortalContextStore, useValue: { contextChanged$: NEVER, sessionExpired$: NEVER } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ConnectionRecordDetailComponent);
    fixture.componentInstance.connection = staleRevokedPageFixture;
    fixture.componentInstance.isLoading = false;
    fixture.detectChanges();
    const view = fixture.nativeElement as HTMLElement;

    expect(view.textContent).toContain('Identidade da empresa não confirmada');
    expect(view.textContent).toContain('Autorização revogada');
    expect(view.textContent).toContain('Webhook e configuração de eventos');
    expect(view.textContent).toContain('Sincronização empresarial');
    expect(view.querySelector('.status-cue')?.textContent).toContain('Status desatualizado');
    expect(view.querySelectorAll('button').length).toBe(2);
    expect(Array.from(view.querySelectorAll('button')).every((button) => button.disabled)).toBe(true);
    expect(view.querySelector('details summary')?.textContent).toContain('Detalhes técnicos para suporte');
    expect(view.textContent).toContain('req-synthetic-connection-02');
    fixture.destroy();
  });
});
