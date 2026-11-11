import { ActivatedRoute, Router } from '@angular/router';
import { PortalEntryReturnStore } from '../../core/portal/portal-entry-return.store';
import { PortalSessionService } from '../../core/portal/portal-session.service';
import { safeReturnUrl } from '../../core/portal/safe-return-url';
import { PortalAccessComponent } from './portal-access.component';

describe('PortalAccessComponent return path', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('keeps an allowlisted deep link locally without adding it to the magic-link request', async () => {
    const safePath = '/connections/new/instagram?authVariant=INSTAGRAM_LOGIN';
    const sessions = {
      ensureCurrentSession: vi.fn().mockResolvedValue(null),
      entryNotice: null,
      requestDirectEntry: vi.fn().mockResolvedValue(undefined),
    } as unknown as PortalSessionService;
    const route = { snapshot: { queryParamMap: { get: () => null } } } as unknown as ActivatedRoute;
    const router = { navigateByUrl: vi.fn().mockResolvedValue(true) } as unknown as Router;
    const store = new PortalEntryReturnStore();
    store.remember(`${safePath}&cUUID=old-tenant&ticket=synthetic`);
    const component = new PortalAccessComponent(sessions, store, route, router);

    await component.ngOnInit();
    expect(component.returnUrl).toBe(safePath);
    component.email = 'operator@example.invalid';
    await component.requestLink();

    expect(sessions.requestDirectEntry).toHaveBeenCalledOnce();
    expect(sessions.requestDirectEntry).toHaveBeenCalledWith('operator@example.invalid');
    const savedState = localStorage.getItem('ca.meta.portal.pending-return.v1') ?? '';
    expect(savedState).not.toContain('cUUID');
    expect(savedState).not.toContain('ticket');
    expect(store.takeForAuthenticatedSession()).toBe(safeReturnUrl(safePath));
  });
});
