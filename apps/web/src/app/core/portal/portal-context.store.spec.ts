import { PortalContextStore, readCsrfCookie } from './portal-context.store';

describe('PortalContextStore', () => {
  beforeEach(() => sessionStorage.clear());

  it('persists only the server-issued context selector and removes it on context change', () => {
    const store = new PortalContextStore();
    store.setContextRef('synthetic-context-reference-12345');
    expect(sessionStorage.getItem('ca.meta.portal.context-ref.v1')).toBe('synthetic-context-reference-12345');

    store.contextChanged();
    expect(store.contextRef).toBeNull();
    expect(sessionStorage.getItem('ca.meta.portal.context-ref.v1')).toBeNull();
  });

  it('ignores malformed stored context and accepts only the readable CSRF cookie', () => {
    sessionStorage.setItem('ca.meta.portal.context-ref.v1', 'short');
    expect(new PortalContextStore().contextRef).toBeNull();
    expect(readCsrfCookie('__Host-ca_meta_csrf=synthetic-csrf-token-value-1234567890')).toBe('synthetic-csrf-token-value-1234567890');
    expect(readCsrfCookie('__Host-ca_meta_csrf=bad.value')).toBeNull();
    expect(readCsrfCookie('__Host-meta_portal=synthetic-session-cookie-value')).toBeNull();
  });
});
