import { PortalEntryReturnStore } from './portal-entry-return.store';

describe('PortalEntryReturnStore', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('preserves one sanitized deep link across tabs only after the matching request is accepted', () => {
    const firstTab = new PortalEntryReturnStore();
    const attemptRef = firstTab.stage('/assets/asset_ref_123?filter=active&cUUID=old-tenant&ticket=synthetic');

    expect(attemptRef).toBeTruthy();
    expect(firstTab.hasAccepted()).toBe(false);
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

    localStorage.setItem('ca.meta.portal.pending-return.v1', '{malformed');
    expect(store.takeForAuthenticatedSession()).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(attemptRef).toBeTruthy();
  });
});
