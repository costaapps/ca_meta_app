import { CommonModule } from '@angular/common';
import { Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';
import { PortalContextStore } from '../../core/portal/portal-context.store';
import { PortalEntryReturnStore } from '../../core/portal/portal-entry-return.store';
import { PortalSession, PortalSessionService } from '../../core/portal/portal-session.service';
import { safeRequestId } from '../../core/portal/safe-api-error';
import { EmbedBridgeService, type EmbedBridgeSnapshot } from '../../core/embed/embed-bridge.service';
import { embedRoutePath, type EmbedNavigationRequest } from '../../core/embed/embed-contract';

@Component({
  selector: 'app-portal-shell',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './portal-shell.component.html',
  styleUrl: './portal-shell.component.scss',
})
export class PortalShellComponent implements OnInit, OnDestroy {
  @ViewChild('portalMain', { static: true }) private portalMain!: ElementRef<HTMLElement>;

  session: PortalSession | null = null;
  embedSnapshot: EmbedBridgeSnapshot;
  notice = '';
  noticeRequestId: string | null = null;
  isSigningOut = false;
  private readonly destroy$ = new Subject<void>();
  private stopEmbedState?: () => void;
  private stopEmbedNavigation?: () => void;
  private resizeObserver?: ResizeObserver;

  constructor(
    private readonly sessions: PortalSessionService,
    private readonly context: PortalContextStore,
    private readonly returnTargets: PortalEntryReturnStore,
    private readonly router: Router,
    private readonly bridge: EmbedBridgeService,
  ) {
    this.embedSnapshot = bridge.getSnapshot();
  }

  ngOnInit(): void {
    this.session = this.sessions.current;
    this.sessions.session$.pipe(takeUntil(this.destroy$)).subscribe((session) => { this.session = session; });
    const returnUrl = this.returnTargets.takeForAuthenticatedSession();
    if (returnUrl && returnUrl !== this.router.url) void this.router.navigateByUrl(returnUrl);
    this.context.contextChanged$.pipe(takeUntil(this.destroy$)).subscribe(() => {
      this.notice = 'A empresa ativa mudou em outra aba. Atualizamos o contexto; confira a seleção antes de continuar.';
      this.noticeRequestId = null;
      void this.refreshAfterContextChange();
    });
    this.context.sessionExpired$.pipe(takeUntil(this.destroy$)).subscribe(() => {
      this.returnTargets.remember(this.router.url);
      void this.router.navigate(['/access']);
    });
    if (typeof window !== 'undefined' && window.parent !== window && this.embedSnapshot.state === 'ready') {
      this.stopEmbedState = this.bridge.subscribe((snapshot) => { this.embedSnapshot = snapshot; });
      this.stopEmbedNavigation = this.bridge.subscribeNavigation((request) => this.navigateFromSuite4(request));
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver((entries) => {
          const height = entries[0]?.contentRect.height;
          if (typeof height === 'number') this.bridge.sendResize(height);
        });
        this.resizeObserver.observe(this.portalMain.nativeElement);
      }
    }
  }

  get roleLabel(): string {
    return this.session?.roles.join(' · ') ?? '';
  }

  get contextLabel(): string {
    return this.session ? 'Contexto da sessão ativo' : '';
  }

  async signOut(): Promise<void> {
    if (this.isSigningOut) return;
    this.isSigningOut = true;
    try {
      await this.sessions.logout();
      await this.router.navigate(['/access']);
    } catch (error: unknown) {
      this.notice = 'Não foi possível encerrar a sessão agora. Tente novamente.';
      this.noticeRequestId = safeRequestId(error);
    } finally {
      this.isSigningOut = false;
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.stopEmbedState?.();
    this.stopEmbedNavigation?.();
    this.resizeObserver?.disconnect();
  }

  private async refreshAfterContextChange(): Promise<void> {
    const refreshed = await this.sessions.refreshAfterContextChange();
    if (!refreshed) {
      this.returnTargets.remember(this.router.url);
      await this.router.navigate(['/access']);
    }
  }

  private navigateFromSuite4(request: EmbedNavigationRequest): void {
    if (request.route === 'top-level') return;
    void this.router.navigateByUrl(embedRoutePath(request.route));
  }
}
