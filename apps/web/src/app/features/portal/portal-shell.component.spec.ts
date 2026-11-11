import { EmbedBridgeService } from '../../core/embed/embed-bridge.service';
import { PortalContextStore } from '../../core/portal/portal-context.store';
import { PortalEntryReturnStore } from '../../core/portal/portal-entry-return.store';
import { PortalSession, PortalSessionService } from '../../core/portal/portal-session.service';
import { Router } from '@angular/router';
import { PortalShellComponent } from './portal-shell.component';

describe('PortalShellComponent', () => {
  it('uses neutral session-context copy without presenting the tenant reference as a company name', () => {
    const session: PortalSession = {
      sessionRef: 'synthetic-session-ref-01',
      principalRef: 'synthetic-principal-ref-01',
      tenantRef: 'synthetic-tenant-ref-01',
      roles: ['operator'],
      tenantContextRef: 'synthetic-current-context-reference-01',
      contextVersion: 1,
      requestId: 'req-synthetic-session-01',
    };
    const bridge = {
      getSnapshot: () => ({ state: 'idle', message: 'Aguardando o portal.', theme: 'system' }),
    } as unknown as EmbedBridgeService;
    const component = new PortalShellComponent(
      { current: session } as PortalSessionService,
      {} as PortalContextStore,
      {} as PortalEntryReturnStore,
      {} as Router,
      bridge,
    );
    component.session = session;

    expect(component.contextLabel).toBe('Contexto da sessão ativo');
    expect(component.contextLabel).not.toContain(session.tenantRef);
  });
});
