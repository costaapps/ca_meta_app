import { CommonModule } from '@angular/common';
import { Component, HostListener, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { PortalSessionService } from '../../core/portal/portal-session.service';
import { PortalEntryReturnStore } from '../../core/portal/portal-entry-return.store';
import { safeRequestId } from '../../core/portal/safe-api-error';

@Component({
  selector: 'app-portal-access',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './portal-access.component.html',
  styleUrl: './portal-access.component.scss',
})
export class PortalAccessComponent implements OnInit {
  email = '';
  returnUrl = '/connections';
  isChecking = true;
  isRequesting = false;
  requestAccepted = false;
  hasUnacceptedAttempt = false;
  errorMessage = '';
  errorRequestId: string | null = null;
  noticeMessage = '';
  private isCheckingReturn = false;

  constructor(
    private readonly sessions: PortalSessionService,
    private readonly returnTargets: PortalEntryReturnStore,
    private readonly route: ActivatedRoute,
    private readonly router: Router,
  ) {}

  async ngOnInit(): Promise<void> {
    this.returnUrl = this.returnTargets.currentReturnUrl() ?? '/connections';
    const notice = this.route.snapshot.queryParamMap.get('notice');
    this.noticeMessage = notice === 'membership'
      ? 'Esta sessão não tem uma empresa ativa autorizada. Use um convite válido ou abra o portal pelo Suite4.'
      : '';
    const session = await this.sessions.ensureCurrentSession(true);
    this.isChecking = false;
    if (session) {
      const returnUrl = this.returnTargets.takeForAuthenticatedSession();
      this.hasUnacceptedAttempt = this.returnTargets.hasUnacceptedAttempt();
      if (returnUrl) await this.router.navigateByUrl(returnUrl);
      else if (!this.hasUnacceptedAttempt) await this.router.navigateByUrl('/connections');
      else this.noticeMessage = 'A sessão está ativa, mas a solicitação de link ainda não foi confirmada. Você pode abrir as conexões diretamente.';
    }
    else if (!this.noticeMessage && this.sessions.entryNotice === 'membership') {
      this.noticeMessage = 'Esta sessão não tem uma empresa ativa autorizada. Use um convite válido ou abra o portal pelo Suite4.';
    }
  }

  @HostListener('window:focus')
  async checkSessionAfterReturningFromEmail(): Promise<void> {
    if ((!this.requestAccepted && !this.returnTargets.hasAccepted()) || this.isCheckingReturn) return;
    this.isCheckingReturn = true;
    try {
      const session = await this.sessions.ensureCurrentSession(true);
      if (session) {
        this.requestAccepted = false;
        await this.router.navigateByUrl(this.returnTargets.takeForAuthenticatedSession() ?? this.returnUrl);
      }
    } finally {
      this.isCheckingReturn = false;
    }
  }

  async requestLink(): Promise<void> {
    if (this.isRequesting || !this.email.trim()) return;
    this.isRequesting = true;
    this.errorMessage = '';
    this.errorRequestId = null;
    this.requestAccepted = false;
    const attemptRef = this.returnTargets.stage(this.returnUrl);
    try {
      await this.sessions.requestDirectEntry(this.email.trim());
      this.returnTargets.markAccepted(attemptRef);
      this.requestAccepted = true;
      this.email = '';
    } catch (error: unknown) {
      this.returnTargets.discard(attemptRef);
      this.errorMessage = 'Não foi possível solicitar o link agora. Tente novamente em alguns minutos.';
      this.errorRequestId = safeRequestId(error);
    } finally {
      this.isRequesting = false;
    }
  }
}
