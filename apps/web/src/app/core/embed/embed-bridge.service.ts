import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { META_API_BASE_URL, PROVIDER_AUTHORIZATION_ORIGINS, SUITE4_EMBED_ORIGINS } from '../config/public-runtime-config';
import {
  EMBED_HANDSHAKE_TTL_MS,
  EMBED_PROTOCOL_VERSION,
  embedRoutePath,
  isAuthoritativeReadyStatus,
  isOpaqueOnboardingRef,
  validateOAuthReturnEvent,
  validateParentMessageEvent,
  type EmbedCorrelation,
  type EmbedNavigationRequest,
  type EmbedTheme,
  type ParentEmbedMessage,
} from './embed-contract';

export type EmbedBridgeState =
  | 'idle'
  | 'requesting_challenge'
  | 'waiting_for_parent'
  | 'exchanging_ticket'
  | 'ready'
  | 'top_level_required'
  | 'popup_blocked'
  | 'awaiting_server_confirmation'
  | 'confirmed';

export interface EmbedBridgeSnapshot {
  readonly state: EmbedBridgeState;
  readonly message: string;
  readonly theme: EmbedTheme;
}

interface PreAuthResponse {
  readonly challengeRef: string;
  readonly expiresAt: string;
  readonly requestId: string;
}

interface PortalSessionResponse {
  readonly sessionRef: string;
  readonly principalRef: string;
  readonly tenantRef: string;
  readonly roles: readonly string[];
  readonly tenantContextRef: string;
  readonly contextVersion: number;
  readonly requestId: string;
}

interface OpenPopup {
  readonly window: Window;
  readonly onboardingRef: string;
  timer: ReturnType<typeof setInterval>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPreAuthResponse(value: unknown): value is PreAuthResponse {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'challengeRef,expiresAt,requestId') return false;
  const expiresAt = typeof value['expiresAt'] === 'string' ? Date.parse(value['expiresAt']) : Number.NaN;
  return typeof value['challengeRef'] === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value['challengeRef']) &&
    Number.isFinite(expiresAt) && expiresAt > Date.now() && expiresAt <= Date.now() + 60_000 &&
    typeof value['requestId'] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value['requestId']);
}

function isPortalSessionResponse(value: unknown): value is PortalSessionResponse {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !==
      'contextVersion,principalRef,requestId,roles,sessionRef,tenantContextRef,tenantRef') return false;
  return typeof value['sessionRef'] === 'string' && value['sessionRef'].length <= 128 &&
    typeof value['principalRef'] === 'string' && value['principalRef'].length <= 128 &&
    typeof value['tenantRef'] === 'string' && value['tenantRef'].length <= 128 &&
    Array.isArray(value['roles']) && value['roles'].length > 0 && value['roles'].length <= 8 &&
    value['roles'].every((role) => ['owner', 'admin', 'operator', 'viewer'].includes(String(role))) &&
    typeof value['tenantContextRef'] === 'string' && /^[A-Za-z0-9_-]{16,512}$/.test(value['tenantContextRef']) &&
    Number.isSafeInteger(value['contextVersion']) && Number(value['contextVersion']) >= 1 &&
    typeof value['requestId'] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value['requestId']);
}

function opaqueRandom(windowRef: Window): string {
  const bytes = new Uint8Array(24);
  windowRef.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return windowRef.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function exactLaunchUrl(value: string, allowedOrigins: readonly string[]): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !allowedOrigins.includes(url.origin)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

@Injectable({ providedIn: 'root' })
export class EmbedBridgeService {
  private readonly baseUrl: string;
  private readonly stateListeners = new Set<(snapshot: EmbedBridgeSnapshot) => void>();
  private readonly navigationListeners = new Set<(request: EmbedNavigationRequest) => void>();
  private readonly openPopups = new Map<Window, OpenPopup>();
  private state: EmbedBridgeSnapshot = Object.freeze({ state: 'idle', message: 'Aguardando o portal.', theme: 'system' });
  private correlation?: EmbedCorrelation;
  private challengeRef?: string;
  private tenantContextRef?: string;
  private parentOrigin?: string;
  private bootstrapConsumed = false;
  private started = false;
  private readonly messageListener = (event: MessageEvent<unknown>): void => this.onMessage(event);

  constructor(
    private readonly http: HttpClient,
    @Inject(META_API_BASE_URL) baseUrl: string,
    @Inject(SUITE4_EMBED_ORIGINS) private readonly embedOrigins: readonly string[],
    @Inject(PROVIDER_AUTHORIZATION_ORIGINS) private readonly providerOrigins: readonly string[],
  ) {
    const configuredBase = baseUrl.replace(/\/+$/, '');
    this.baseUrl = configuredBase.endsWith('/v1') ? configuredBase : `${configuredBase || '/api'}/v1`;
  }

  getSnapshot(): EmbedBridgeSnapshot { return this.state; }

  subscribe(listener: (snapshot: EmbedBridgeSnapshot) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  subscribeNavigation(listener: (request: EmbedNavigationRequest) => void): () => void {
    this.navigationListeners.add(listener);
    return () => this.navigationListeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (typeof window === 'undefined' || window.parent === window || this.embedOrigins.length === 0) {
      this.update('top_level_required', 'Abra este portal pelo Suite4 para continuar.');
      return;
    }
    this.update('requesting_challenge', 'Validando a sessão de entrada…');
    try {
      const challenge = await firstValueFrom(this.http.post<unknown>(`${this.baseUrl}/auth/preauth`, {
        entryMode: 'SUITE4_EMBED',
        returnRoute: 'connections',
      }, { withCredentials: true }));
      if (!isPreAuthResponse(challenge)) throw new Error('Invalid pre-auth response.');
      this.challengeRef = challenge.challengeRef;
      this.correlation = Object.freeze({
        version: EMBED_PROTOCOL_VERSION,
        nonce: opaqueRandom(window),
        correlationId: opaqueRandom(window),
        requestId: challenge.requestId,
      });
      window.addEventListener('message', this.messageListener);
      this.update('waiting_for_parent', 'Aguardando a confirmação segura do Suite4…');
      const ready = Object.freeze({ type: 'EMBED_READY', ...this.correlation });
      for (const origin of this.embedOrigins) window.parent.postMessage(ready, origin);
      setTimeout(() => {
        if (!this.bootstrapConsumed && this.state.state === 'waiting_for_parent') {
          this.update('top_level_required', 'A confirmação expirou. Reabra o portal pelo Suite4.');
          this.sendAck('top_level_required');
        }
      }, EMBED_HANDSHAKE_TTL_MS);
    } catch {
      this.update('top_level_required', 'O navegador não permitiu validar a sessão incorporada. Abra o portal em uma janela do Suite4.');
      this.sendAck('top_level_required');
    }
  }

  dispose(): void {
    if (typeof window !== 'undefined') window.removeEventListener('message', this.messageListener);
    for (const popup of this.openPopups.values()) clearInterval(popup.timer);
    this.openPopups.clear();
    this.stateListeners.clear();
    this.navigationListeners.clear();
  }

  sendResize(height: number): void {
    if (!this.correlation || !this.parentOrigin || this.state.state !== 'ready') return;
    const safeHeight = Math.max(240, Math.min(4096, Math.round(height)));
    this.postToParent({ type: 'RESIZE', ...this.correlation, height: safeHeight });
  }

  requestNavigation(route: 'setup' | 'channels' | 'templates' | 'top-level'): void {
    if (!this.correlation || !this.parentOrigin) return;
    this.postToParent({ type: 'NAVIGATION_REQUEST', ...this.correlation, route });
  }

  async openOAuthPopup(launchUrl: string, onboardingRef: string): Promise<boolean> {
    if (!this.correlation || this.state.state !== 'ready' || !isOpaqueOnboardingRef(onboardingRef)) return false;
    const url = exactLaunchUrl(launchUrl, this.providerOrigins);
    if (!url) {
      this.update('top_level_required', 'O fluxo de autorização não está configurado para esta janela.');
      this.sendAck('top_level_required');
      return false;
    }
    const popup = window.open('about:blank', `ca-meta-${this.correlation.requestId}`, 'popup,width=720,height=800,resizable=yes,scrollbars=yes');
    if (!popup) {
      this.update('popup_blocked', 'O navegador bloqueou a janela de autorização. Permita a abertura e tente novamente.');
      this.sendAck('top_level_required');
      return false;
    }
    popup.location.replace(url.href);
    const handle: OpenPopup = {
      window: popup,
      onboardingRef,
      timer: setInterval(() => {
        if (popup.closed) {
          this.closePopup(popup);
          void this.confirmOnboardingStatus(onboardingRef);
        }
      }, 500),
    };
    this.openPopups.set(popup, handle);
    this.update('awaiting_server_confirmation', 'Aguardando a confirmação do servidor…');
    return true;
  }

  private onMessage(event: MessageEvent<unknown>): void {
    if (this.handleOAuthReturn(event)) return;
    if (!this.correlation || typeof window === 'undefined') return;
    const message = validateParentMessageEvent(event, {
      parentWindow: window.parent,
      allowedOrigins: this.embedOrigins,
      correlation: this.correlation,
    });
    if (!message) return;
    if (!this.parentOrigin) this.parentOrigin = event.origin;
    if (this.parentOrigin !== event.origin) return;
    this.handleParentMessage(message, event.origin);
  }

  private handleParentMessage(message: ParentEmbedMessage, eventOrigin: string): void {
    if (message.type === 'EMBED_BOOTSTRAP') {
      if (this.bootstrapConsumed || this.state.state !== 'waiting_for_parent' || !this.challengeRef) return;
      this.bootstrapConsumed = true;
      this.parentOrigin = eventOrigin;
      void this.exchangeTicket(message.ticket);
      return;
    }
    if (message.type === 'NAVIGATION_REQUEST') {
      for (const listener of this.navigationListeners) listener(message);
      return;
    }
    this.update(this.state.state, this.state.message, message.theme);
  }

  private async exchangeTicket(ticket: string): Promise<void> {
    this.update('exchanging_ticket', 'Confirmando a sessão com o servidor…');
    try {
      const exchange = await firstValueFrom(this.http.post<unknown>(`${this.baseUrl}/auth/exchanges`, {
        ticket,
        challengeRef: this.challengeRef,
      }, { withCredentials: true }));
      if (!isPortalSessionResponse(exchange)) throw new Error('Invalid portal session response.');
      this.tenantContextRef = exchange.tenantContextRef;
      const current = await firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/session`, {
        withCredentials: true,
        headers: new HttpHeaders({ 'X-Tenant-Context': exchange.tenantContextRef }),
      }));
      if (!isRecord(current) || current['tenantContextRef'] !== exchange.tenantContextRef ||
          current['sessionRef'] !== exchange.sessionRef) throw new Error('Session cookie could not be confirmed.');
      this.update('ready', 'Sessão confirmada.');
      this.sendAck('ready');
    } catch {
      this.update('top_level_required', 'O navegador bloqueou os cookies da sessão incorporada. Continue em uma janela do Suite4.');
      this.sendAck('top_level_required');
    }
  }

  private handleOAuthReturn(event: MessageEvent<unknown>): boolean {
    for (const popup of this.openPopups.values()) {
      const signal = validateOAuthReturnEvent(event, {
        popupWindow: popup.window,
        portalOrigin: window.location.origin,
        onboardingRef: popup.onboardingRef,
      });
      if (!signal) continue;
      this.closePopup(popup.window);
      void this.confirmOnboardingStatus(signal.onboardingRef);
      return true;
    }
    return false;
  }

  private async confirmOnboardingStatus(onboardingRef: string): Promise<void> {
    if (!isOpaqueOnboardingRef(onboardingRef) || !this.tenantContextRef) {
      this.update('awaiting_server_confirmation', 'O servidor ainda não confirmou o resultado.');
      return;
    }
    this.update('awaiting_server_confirmation', 'Consultando o estado atualizado no servidor…');
    try {
      const status = await firstValueFrom(this.http.get<unknown>(
        `${this.baseUrl}/onboarding-sessions/${encodeURIComponent(onboardingRef)}`,
        { withCredentials: true, headers: new HttpHeaders({ 'X-Tenant-Context': this.tenantContextRef }) },
      ));
      if (isAuthoritativeReadyStatus(status, onboardingRef)) {
        this.update('confirmed', 'O servidor confirmou a conexão.');
        return;
      }
    } catch (error) {
      if (error instanceof HttpErrorResponse && (error.status === 401 || error.status === 403)) {
        this.update('top_level_required', 'A sessão expirou. Reabra o portal pelo Suite4.');
        this.sendAck('top_level_required');
        return;
      }
      // A callback signal and a popup close are navigation hints only.
    }
    this.update('awaiting_server_confirmation', 'A conexão ainda não foi confirmada pelo servidor.');
  }

  private closePopup(popup: Window): void {
    const handle = this.openPopups.get(popup);
    if (handle) clearInterval(handle.timer);
    this.openPopups.delete(popup);
    try { if (!popup.closed) popup.close(); } catch { /* The browser may already have closed it. */ }
  }

  private sendAck(status: 'ready' | 'top_level_required' | 'rejected'): void {
    if (!this.correlation || !this.parentOrigin) return;
    this.postToParent({ type: 'EMBED_ACK', ...this.correlation, status });
  }

  private postToParent(message: Readonly<Record<string, unknown>>): void {
    if (!this.parentOrigin || typeof window === 'undefined' || window.parent === window) return;
    window.parent.postMessage(message, this.parentOrigin);
  }

  private update(state: EmbedBridgeState, message: string, theme = this.state.theme): void {
    this.state = Object.freeze({ state, message, theme });
    for (const listener of this.stateListeners) listener(this.state);
  }
}
