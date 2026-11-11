import { PortalEntryReturnStore } from './portal-entry-return.store';

describe('PortalEntryReturnStore', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('keeps an unaccepted attempt from consuming the intended return path', () => {
    const firstTab = new PortalEntryReturnStore();
    const attemptRef = firstTab.stage('/assets/asset_ref_123?filter=active&state=synthetic-state&cUUID=old-tenant&ticket=synthetic');

    expect(attemptRef).toBeTruthy();
    expect(firstTab.hasAccepted()).toBe(false);
    expect(firstTab.takeForAuthenticatedSession()).toBeNull();
    expect(firstTab.currentReturnUrl()).toBe('/assets/asset_ref_123?filter=active');
    firstTab.markAccepted(attemptRef);

    const confirmationTab = new PortalEntryReturnStore();
    expect(confirmationTab.takeForAuthenticatedSession()).toBe('/assets/asset_ref_123?filter=active');
    expect(confirmationTab.takeForAuthenticatedSession()).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('does not accept mismatched or malformed local state', () => {
    const store = new PortalEntryReturnStore();
    const attemptRef = store.stage('/connections/new/instagram?authVariant=INSTAGRAM_LOGIN');
    store.markAccepted('another-attempt-reference-123');
    expect(store.hasAccepted()).toBe(false);
    store.discard(attemptRef);

    localStorage.setItem('ca.meta.portal.pending-return.v1', '{malformed');
    expect(store.takeForAuthenticatedSession()).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(attemptRef).toBeTruthy();
  });
});
