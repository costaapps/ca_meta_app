import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { PortalSessionService } from '../../core/portal/portal-session.service';
import { safeReturnUrl } from '../../core/portal/portal-auth.guard';
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
  errorMessage = '';
  errorRequestId: string | null = null;
  noticeMessage = '';

  constructor(
    private readonly sessions: PortalSessionService,
    private readonly route: ActivatedRoute,
    private readonly router: Router,
  ) {}

  async ngOnInit(): Promise<void> {
    this.returnUrl = safeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl') ?? '/connections');
    const notice = this.route.snapshot.queryParamMap.get('notice');
    this.noticeMessage = notice === 'membership'
      ? 'Esta sessão não tem uma empresa ativa autorizada. Use um convite válido ou abra o portal pelo Suite4.'
      : '';
    const session = await this.sessions.ensureCurrentSession(true);
    this.isChecking = false;
    if (session) await this.router.navigateByUrl(this.returnUrl);
    else if (!this.noticeMessage && this.sessions.entryNotice === 'membership') {
      this.noticeMessage = 'Esta sessão não tem uma empresa ativa autorizada. Use um convite válido ou abra o portal pelo Suite4.';
    }
  }

  async requestLink(): Promise<void> {
    if (this.isRequesting || !this.email.trim()) return;
    this.isRequesting = true;
    this.errorMessage = '';
    this.errorRequestId = null;
    this.requestAccepted = false;
    try {
      await this.sessions.requestDirectEntry(this.email.trim());
      this.requestAccepted = true;
      this.email = '';
    } catch (error: unknown) {
      this.errorMessage = 'Não foi possível solicitar o link agora. Tente novamente em alguns minutos.';
      this.errorRequestId = safeRequestId(error);
    } finally {
      this.isRequesting = false;
    }
  }
}
