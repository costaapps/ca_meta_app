import { describe, expect, it } from 'vitest';
import { OnboardingSessionStore } from './onboarding-session-store';

class MemorySessionStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

function makeDocument(storage = new MemorySessionStorage()): { documentRef: Document; storage: MemorySessionStorage } {
  return {
    documentRef: { defaultView: { sessionStorage: storage } } as unknown as Document,
    storage,
  };
}

describe('OnboardingSessionStore', () => {
  it('persists only opaque onboarding IDs and their expiry for same-tab reload', () => {
    const { documentRef, storage } = makeDocument();
    const store = new OnboardingSessionStore(documentRef);
    const id = '11111111-1111-4111-8111-111111111111';
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();

    expect(store.ensureAvailable()).toBe(true);
    expect(store.remember(id, expiresAt)).toBe(true);
    expect(store.read()).toEqual([{ id, expiresAt }]);
    expect(JSON.stringify([...storage.values.values()])).not.toMatch(/token|code|stateRef|launchUrl|tenantRef/i);
    expect(Object.keys(JSON.parse([...storage.values.values()][0])[0]).sort()).toEqual(['expiresAt', 'id']);
  });

  it('drops expired, malformed, and extra-field values without retaining credential-like fields', () => {
    const { documentRef, storage } = makeDocument();
    storage.setItem('ca.meta.portal.onboarding-refs.v1', JSON.stringify([
      { id: '22222222-2222-4222-8222-222222222222', expiresAt: new Date(Date.now() - 1000).toISOString() },
      { id: 'short space', expiresAt: new Date(Date.now() + 60_000).toISOString() },
      { id: '33333333-3333-4333-8333-333333333333', expiresAt: new Date(Date.now() + 60_000).toISOString(), token: 'synthetic-token' },
    ]));
    const store = new OnboardingSessionStore(documentRef);

    expect(store.read()).toEqual([]);
    expect(storage.getItem('ca.meta.portal.onboarding-refs.v1')).toBe('[]');
  });

  it('fails closed when sessionStorage is unavailable', () => {
    const documentRef = { get defaultView() { throw new Error('storage blocked'); } } as unknown as Document;
    const store = new OnboardingSessionStore(documentRef);
    expect(store.ensureAvailable()).toBe(false);
    expect(store.remember('44444444-4444-4444-8444-444444444444', new Date(Date.now() + 60_000).toISOString())).toBe(false);
  });
});
