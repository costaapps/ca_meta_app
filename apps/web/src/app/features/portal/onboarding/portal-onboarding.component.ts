import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subject, takeUntil } from 'rxjs';
import {
  ONBOARDING_FLOW_GROUPS,
  onboardingCapabilityLabel,
  onboardingFlowTitle,
  type OnboardingFlowGroup,
  type OnboardingFlowProfile,
} from '../../../core/onboarding/onboarding-flow-catalog';
import {
  PortalOnboardingService,
  type OnboardingAttemptView,
  type OnboardingRecoveryOption,
  type OnboardingStep,
  type PortalOnboardingSnapshot,
} from '../../../core/onboarding/portal-onboarding.service';

@Component({
  selector: 'app-portal-onboarding',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './portal-onboarding.component.html',
  styleUrl: './portal-onboarding.component.scss',
})
export class PortalOnboardingComponent implements OnInit, OnDestroy {
  readonly groups = ONBOARDING_FLOW_GROUPS;
  snapshot: PortalOnboardingSnapshot;
  private readonly destroy$ = new Subject<void>();

  constructor(private readonly onboarding: PortalOnboardingService) {
    this.snapshot = onboarding.getSnapshot();
  }

  ngOnInit(): void {
    this.onboarding.state$.pipe(takeUntil(this.destroy$)).subscribe((snapshot) => { this.snapshot = snapshot; });
    void this.onboarding.initialize();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  profilesFor(group: OnboardingFlowGroup): readonly OnboardingFlowProfile[] {
    return this.snapshot.profiles.filter((profile) => profile.product === group.id);
  }

  canStart(profile: OnboardingFlowProfile): boolean { return this.onboarding.canStart(profile); }

  async start(profile: OnboardingFlowProfile): Promise<void> { await this.onboarding.start(profile); }

  refresh(attempt: OnboardingAttemptView): void { void this.onboarding.refreshStatus(attempt.id); }

  recover(attempt: OnboardingAttemptView, option: OnboardingRecoveryOption): void {
    void this.onboarding.recover(attempt.id, option);
  }

  detach(attempt: OnboardingAttemptView): void { this.onboarding.detachPopup(attempt.id); }

  flowTitle(attempt: OnboardingAttemptView): string {
    return attempt.flowVariant ? onboardingFlowTitle(attempt.flowVariant) : 'Sessão de conexão';
  }

  profileTitle(profile: OnboardingFlowProfile): string {
    switch (profile.authVariant) {
      case 'FACEBOOK_LOGIN_FOR_BUSINESS': return 'Facebook Login para Empresas';
      case 'INSTAGRAM_VIA_FACEBOOK_LOGIN': return 'Instagram via Facebook Login';
      case 'INSTAGRAM_LOGIN': return 'Instagram Login';
      case 'WHATSAPP_EMBEDDED_SIGNUP': return 'WhatsApp Cloud API Embedded Signup';
      case 'WHATSAPP_BUSINESS_APP_ONBOARDING': return 'WhatsApp Business App Coexistence';
    }
  }

  startLabel(profile: OnboardingFlowProfile): string {
    if (this.snapshot.pendingCreateFlowVariant === profile.flowVariant) return 'Retomar tentativa';
    if (profile.flowVariant !== 'WHATSAPP_COEXISTENCE') return 'Iniciar autorização';
    const completed = this.snapshot.attempts.some((attempt) =>
      attempt.flowVariant === 'WHATSAPP_COEXISTENCE' && attempt.status?.status === 'READY');
    return completed ? 'Adicionar próximo número' : 'Conectar este número';
  }

  capabilityLabel(operation: string): string { return onboardingCapabilityLabel(operation); }

  profileReason(profile: OnboardingFlowProfile): string {
    if (profile.blockedReason) return profile.blockedReason;
    if (profile.enabled) return 'Disponível neste contexto. A conexão só será confirmada pelo status do servidor.';
    if (profile.reasonCode === 'APP_REVIEW_NOT_CONFIRMED') return 'A revisão do aplicativo Meta ainda não foi confirmada.';
    if (profile.reasonCode === 'SANDBOX_NOT_CONFIRMED') return 'A validação do fluxo em ambiente de teste ainda não foi confirmada.';
    if (profile.reasonCode === 'PERMISSION_MAPPING_NOT_CONFIRMED') return 'As permissões necessárias ainda não foram confirmadas.';
    if (profile.reasonCode === 'VERSION_EVIDENCE_REQUIRED') return 'As versões necessárias do fluxo ainda não foram confirmadas.';
    return 'O servidor não habilitou este fluxo.';
  }

  statusLabel(attempt: OnboardingAttemptView): string {
    const status = attempt.status;
    if (!status) return 'Aguardando leitura do servidor';
    if (status.status === 'READY' && status.readiness === 'READY' && status.nextAction === 'NONE') return 'Conexão confirmada';
    if (status.status === 'PARTIAL' || status.readiness === 'PARTIAL') return 'Conexão parcial';
    if (status.status === 'CANCELLED') return 'Autorização cancelada';
    if (status.status === 'EXPIRED') return 'Autorização expirada';
    if (status.status === 'FAILED') return 'Tentativa falhou';
    if (status.readiness === 'UNKNOWN') return 'Resultado ainda não confirmado';
    return 'Em andamento';
  }

  visibleSteps(attempt: OnboardingAttemptView): readonly OnboardingStep[] {
    return attempt.status?.steps.filter((step) => step.status !== 'SKIPPED') ?? [];
  }

  stepTitle(step: OnboardingStep): string {
    const labels: Readonly<Record<string, string>> = {
      authorization: 'Autorização',
      'asset-verification': 'Verificação dos recursos',
      subscription: 'Assinaturas',
      projection: 'Atualização da conexão',
    };
    return labels[step.name] ?? 'Etapa de conexão';
  }

  stepStatus(step: OnboardingStep): string {
    const labels: Readonly<Record<OnboardingStep['status'], string>> = {
      PENDING: 'Aguardando',
      RUNNING: 'Em andamento',
      SUCCEEDED: 'Concluída',
      RETRY_PENDING: 'Aguardando recuperação',
      FAILED: 'Falhou',
      UNKNOWN: 'Não confirmado',
      SKIPPED: 'Não aplicável',
    };
    return labels[step.status];
  }

  trackProfile(_index: number, profile: OnboardingFlowProfile): string {
    return `${profile.flowVariant}:${profile.authVariant}`;
  }

  trackAttempt(_index: number, attempt: OnboardingAttemptView): string { return attempt.id; }

  trackStep(_index: number, step: OnboardingStep): string { return step.name; }

  trackRecovery(_index: number, option: OnboardingRecoveryOption): string {
    return 'stage' in option ? `${option.action}:${option.stage}` : option.action;
  }
}
