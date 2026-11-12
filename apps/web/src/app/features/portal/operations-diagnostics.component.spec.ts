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
        { provide: PortalContextStore, useValue: { contextChanged$: new Subject<void>() } },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(OperationsDiagnosticsComponent);
    fixture.componentInstance.diagnostics = report;
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('3 em andamento · 7 precisam de revisão.');
    fixture.destroy();
  });
});
