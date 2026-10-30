// @vitest-environment jsdom
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '@angular/common/http';
import { EmbedBridgeService } from './embed-bridge.service';

const parentOrigin = 'https://suite4.synthetic.invalid';
const onboardingRef = 'onboarding-opaque-reference-123';
const challengeRef = 'synthetic-challenge-reference-1234567890';
const tenantContextRef = 'synthetic-tenant-context-reference-123';

function fakeHttp(status: 'READY' | 'AWAITING_PROVIDER' = 'READY') {
  const apiStatus = {
    id: onboardingRef,
    flowVariant: 'WHATSAPP_CLOUD_API',
    status,
    readiness: status === 'READY' ? 'READY' : 'UNKNOWN',
    steps: [{ name: 'authorization', status: status === 'READY' ? 'SUCCEEDED' : 'RUNNING' }],
    nextAction: status === 'READY' ? 'NONE' : 'WAIT',
    lastUpdatedAt: '2026-10-30T12:00:00Z',
    requestId: 'server-status-request-123456',
  };
  return {
    post: vi.fn((url: string) => of(url.endsWith('/auth/preauth')
      ? {
          challengeRef,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          requestId: 'server-preauth-request-123456',
        }
      : {
          sessionRef: 'session-ref-12345678901234567890',
          principalRef: 'principal-ref-1234567890',
          tenantRef: 'tenant-a-from-server',
          roles: ['owner'],
          tenantContextRef,
          contextVersion: 1,
          requestId: 'server-exchange-request-123456',
        })),
    get: vi.fn((url: string) => of(url.endsWith('/session')
      ? { sessionRef: 'session-ref-12345678901234567890', tenantContextRef }
      : apiStatus)),
  };
}

describe('EmbedBridgeService', () => {
  const parentMessages: { data: unknown; targetOrigin: string }[] = [];
  const parentWindow = { postMessage: (data: unknown, targetOrigin: string) => parentMessages.push({ data, targetOrigin }) };
  let originalParent: PropertyDescriptor | undefined;
  let service: EmbedBridgeService | undefined;

  beforeEach(() => {
    parentMessages.length = 0;
    originalParent = Object.getOwnPropertyDescriptor(window, 'parent');
    Object.defineProperty(window, 'parent', { configurable: true, value: parentWindow });
  });

  afterEach(() => {
    service?.dispose();
    service = undefined;
    vi.restoreAllMocks();
    if (originalParent) Object.defineProperty(window, 'parent', originalParent);
    else Reflect.deleteProperty(window, 'parent');
  });

  async function openHandshake(http = fakeHttp()): Promise<{ http: ReturnType<typeof fakeHttp>; ready: Record<string, unknown> }> {
    service = new EmbedBridgeService(
      http as unknown as HttpClient,
      '/api',
      [parentOrigin],
      ['https://provider.synthetic.invalid'],
    );
    await service.start();
    const entry = parentMessages.find((item) => (item.data as Record<string, unknown>)['type'] === 'EMBED_READY');
    expect(entry?.targetOrigin).toBe(parentOrigin);
    const ready = entry?.data as Record<string, unknown>;
    window.dispatchEvent(new MessageEvent('message', {
      source: parentWindow as unknown as MessageEventSource,
      origin: parentOrigin,
      data: {
        type: 'EMBED_BOOTSTRAP',
        version: ready['version'],
        nonce: ready['nonce'],
        correlationId: ready['correlationId'],
        requestId: ready['requestId'],
        ticket: 'synthetic.short-lived.signed-ticket',
      },
    }));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.getSnapshot().state).toBe('ready');
    return { http, ready };
  }

  it('falls back when a user-initiated OAuth popup is blocked', async () => {
    await openHandshake();
    vi.spyOn(window, 'open').mockReturnValue(null);
    const opened = await service!.openOAuthPopup('https://provider.synthetic.invalid/authorize?state=synthetic', onboardingRef);
    expect(opened).toBe(false);
    expect(service!.getSnapshot().state).toBe('popup_blocked');
    expect(parentMessages.some((item) => (item.data as Record<string, unknown>)['type'] === 'EMBED_ACK' &&
      (item.data as Record<string, unknown>)['status'] === 'top_level_required')).toBe(true);
  });

  it('treats popup return as a signal and confirms only by querying authoritative server state', async () => {
    const http = fakeHttp('READY');
    await openHandshake(http);
    let popupClosed = false;
    const replaceLocation = vi.fn();
    const popup = {
      get closed() { return popupClosed; },
      location: { replace: replaceLocation },
      close: vi.fn(() => { popupClosed = true; }),
    } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(popup);
    expect(await service!.openOAuthPopup('https://provider.synthetic.invalid/authorize?state=synthetic', onboardingRef)).toBe(true);
    expect(replaceLocation).toHaveBeenCalledWith('https://provider.synthetic.invalid/authorize?state=synthetic');

    window.dispatchEvent(new MessageEvent('message', {
      source: popup,
      origin: window.location.origin,
      data: { type: 'OAUTH_RETURN_SIGNAL', onboardingRef, auth_success: true },
    }));
    expect(service!.getSnapshot().state).toBe('awaiting_server_confirmation');
    window.dispatchEvent(new MessageEvent('message', {
      source: popup,
      origin: window.location.origin,
      data: { type: 'OAUTH_RETURN_SIGNAL', onboardingRef },
    }));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(http.get).toHaveBeenCalledWith(
      `/api/v1/onboarding-sessions/${onboardingRef}`,
      expect.objectContaining({ withCredentials: true }),
    );
    expect(service!.getSnapshot().state).toBe('confirmed');
    expect(service!.getSnapshot().message).toContain('servidor confirmou');
  });

  it('does not confirm a popup close when the server status is pending', async () => {
    const http = fakeHttp('AWAITING_PROVIDER');
    await openHandshake(http);
    let popupClosed = false;
    const popup = {
      get closed() { return popupClosed; },
      location: { replace: vi.fn() },
      close: vi.fn(() => { popupClosed = true; }),
    } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(popup);
    expect(await service!.openOAuthPopup('https://provider.synthetic.invalid/authorize?state=synthetic', onboardingRef)).toBe(true);
    window.dispatchEvent(new MessageEvent('message', {
      source: popup,
      origin: window.location.origin,
      data: { type: 'OAUTH_RETURN_SIGNAL', onboardingRef },
    }));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service!.getSnapshot().state).toBe('awaiting_server_confirmation');
  });

  it('checks server state when the popup closes without a return message', async () => {
    const http = fakeHttp('AWAITING_PROVIDER');
    await openHandshake(http);
    let popupClosed = false;
    const popup = {
      get closed() { return popupClosed; },
      location: { replace: vi.fn() },
      close: vi.fn(() => { popupClosed = true; }),
    } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(popup);
    expect(await service!.openOAuthPopup('https://provider.synthetic.invalid/authorize?state=synthetic', onboardingRef)).toBe(true);
    popupClosed = true;
    await new Promise((resolve) => setTimeout(resolve, 550));
    await Promise.resolve();
    expect(http.get).toHaveBeenCalledWith(
      `/api/v1/onboarding-sessions/${onboardingRef}`,
      expect.objectContaining({ withCredentials: true }),
    );
    expect(service!.getSnapshot().state).toBe('awaiting_server_confirmation');
  });
});
