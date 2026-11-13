import { provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { OperationsDiagnosticsService, type OperationsDiagnostics } from '../../core/portal/operations-diagnostics.service';
import { PortalContextStore } from '../../core/portal/portal-context.store';
import { OperationsDiagnosticsComponent } from './operations-diagnostics.component';

const report: OperationsDiagnostics = {
  requestId: '10000000-0000-4000-8000-000000000001',
  generatedAt: '2026-11-12T12:00:00.000Z',
  versions: { contract: '1.0.0-proposed', readModel: 1 },
  onboarding: { state: 'UNKNOWN', reasonCode: null, observedAt: null, nextAction: null },
  credentialHealth: { state: 'UNKNOWN', reasonCode: null, observedAt: null },
  grants: { state: 'UNKNOWN', reasonCode: null, observedAt: null, grantedCount: null, revokedCount: null },
  subscription: { state: 'UNKNOWN', reasonCode: null, observedAt: null },
  webhook: { state: 'UNKNOWN', reasonCode: null, observedAt: null },
  jobs: {
    state: 'FAILED', reasonCode: null, observedAt: null,
    counts: { QUEUED: 2, RUNNING: 1, FAILED: 1, DEAD_LETTER: 2, UNKNOWN: 4 },
  },
  projection: { state: 'UNKNOWN', reasonCode: 'PROJECTION_RUNTIME_NOT_CONFIGURED', observedAt: null,
    pendingCount: null, failedCount: null, lagSeconds: null },
  nextAction: 'CONTACT_SUPPORT',
};

describe('OperationsDiagnosticsComponent', () => {
  it('includes UNKNOWN jobs in the count that needs review', async () => {
    await TestBed.configureTestingModule({
      imports: [OperationsDiagnosticsComponent],
      providers: [
        provideRouter([]),
        { provide: OperationsDiagnosticsService, useValue: {
          read: vi.fn(() => new Promise<OperationsDiagnostics>(() => {})),
        } },
        { provide: PortalContextStore, useValue: { contextChanged$: new Subject<void>(), sessionExpired$: new Subject<void>() } },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(OperationsDiagnosticsComponent);
    fixture.componentInstance.diagnostics = report;
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('3 em andamento · 7 precisam de revisão.');
    fixture.destroy();
  });

  it('clears the previous report on context change and ignores old results after the new read fails', async () => {
    let resolveStale!: (value: OperationsDiagnostics) => void;
    const staleResponse = new Promise<OperationsDiagnostics>((resolve) => { resolveStale = resolve; });
    let rejectNewContext!: (error: Error) => void;
    const failedNewContext = new Promise<OperationsDiagnostics>((_resolve, reject) => { rejectNewContext = reject; });
    const read = vi.fn<OperationsDiagnosticsService['read']>()
      .mockResolvedValueOnce(report)
      .mockReturnValueOnce(staleResponse)
      .mockReturnValueOnce(failedNewContext);
    const contextChanged = new Subject<void>();
    const sessionExpired = new Subject<void>();
    const component = new OperationsDiagnosticsComponent(
      { read } as unknown as OperationsDiagnosticsService,
      { contextChanged$: contextChanged.asObservable(), sessionExpired$: sessionExpired.asObservable() } as unknown as PortalContextStore,
    );

    component.ngOnInit();
    await Promise.resolve();
    await Promise.resolve();
    expect(component.diagnostics).toBe(report);

    const staleRefresh = component.refresh();
    contextChanged.next();
    expect(component.diagnostics).toBeNull();
    expect(component.errorMessage).toBe('');
    expect(component.errorRequestId).toBeNull();
    expect(component.loading).toBe(true);
    expect(component.isRefreshing).toBe(false);

    rejectNewContext(new Error('synthetic new-context failure'));
    await Promise.resolve();
    await Promise.resolve();
    expect(component.diagnostics).toBeNull();
    expect(component.errorMessage).toBe('Não foi possível confirmar o status agora. Tente atualizar novamente.');
    expect(component.loading).toBe(false);

    resolveStale(report);
    await staleRefresh;
    expect(component.diagnostics).toBeNull();
    expect(component.errorMessage).toBe('Não foi possível confirmar o status agora. Tente atualizar novamente.');
    expect(read).toHaveBeenCalledTimes(3);
    component.ngOnDestroy();
  });

  it('clears the report and ignores pending reads after session expiration without refetching', async () => {
    let resolvePending!: (value: OperationsDiagnostics) => void;
    const pendingResponse = new Promise<OperationsDiagnostics>((resolve) => { resolvePending = resolve; });
    const read = vi.fn<OperationsDiagnosticsService['read']>()
      .mockResolvedValueOnce(report)
      .mockReturnValueOnce(pendingResponse);
    const contextChanged = new Subject<void>();
    const sessionExpired = new Subject<void>();
    const component = new OperationsDiagnosticsComponent(
      { read } as unknown as OperationsDiagnosticsService,
      { contextChanged$: contextChanged.asObservable(), sessionExpired$: sessionExpired.asObservable() } as unknown as PortalContextStore,
    );

    component.ngOnInit();
    await Promise.resolve();
    await Promise.resolve();
    expect(component.diagnostics).toBe(report);
    const pendingRefresh = component.refresh();

    sessionExpired.next();
    expect(component.diagnostics).toBeNull();
    expect(component.loading).toBe(false);
    expect(component.errorMessage).toBe('Sua sessão terminou. Entre novamente para consultar o status.');
    expect(read).toHaveBeenCalledTimes(2);

    resolvePending(report);
    await pendingRefresh;
    expect(component.diagnostics).toBeNull();
    expect(component.errorMessage).toBe('Sua sessão terminou. Entre novamente para consultar o status.');
    expect(read).toHaveBeenCalledTimes(2);
    component.ngOnDestroy();
  });
});
