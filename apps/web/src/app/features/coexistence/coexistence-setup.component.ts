import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  CoexistenceOnboardingService,
  type CoexistenceAttemptSnapshot,
  type CoexistenceOnboardingSnapshot,
  type CoexistenceRecoveryOption,
} from '../../core/coexistence/coexistence-onboarding.service';

@Component({
  selector: 'app-coexistence-setup',
  standalone: true,
  imports: [CommonModule, RouterLink],
  providers: [CoexistenceOnboardingService],
  templateUrl: './coexistence-setup.component.html',
  styleUrl: './coexistence-setup.component.scss',
})
export class CoexistenceSetupComponent implements OnInit, OnDestroy {
  snapshot: CoexistenceOnboardingSnapshot;
  private unsubscribe?: () => void;

  constructor(private readonly onboarding: CoexistenceOnboardingService) {
    this.snapshot = onboarding.getSnapshot();
  }

  ngOnInit(): void {
    this.unsubscribe = this.onboarding.subscribe((snapshot) => { this.snapshot = snapshot; });
    void this.onboarding.refreshAvailability();
  }

  addNumber(): void {
    void this.onboarding.start();
  }

  closeStep(attempt: CoexistenceAttemptSnapshot): void {
    this.onboarding.cancel(attempt.onboardingRef);
  }

  checkStatus(attempt: CoexistenceAttemptSnapshot): void {
    void this.onboarding.refreshAttemptStatus(attempt.onboardingRef);
  }

  recover(attempt: CoexistenceAttemptSnapshot, option: CoexistenceRecoveryOption): void {
    void this.onboarding.recover(attempt.onboardingRef, option);
  }

  hasServerAction(attempt: CoexistenceAttemptSnapshot): boolean {
    if (['ready', 'cancelled', 'expired', 'failed'].includes(attempt.state)) return false;
    if (attempt.replacementOnboardingRef) return false;
    return attempt.state === 'partial' || !!attempt.pendingRecovery ||
      ['REAUTHORIZE', 'RECONCILE', 'RESUME', 'RESOLVE_CONFLICT'].includes(attempt.nextAction ?? '');
  }

  isRecoveryDisabled(attempt: CoexistenceAttemptSnapshot): boolean {
    return attempt.recoveryInFlight || !!attempt.pendingRecovery;
  }

  isInProgress(attempt: CoexistenceAttemptSnapshot): boolean {
    return !['ready', 'partial', 'cancelled', 'expired', 'failed'].includes(attempt.state);
  }

  stateLabel(attempt: CoexistenceAttemptSnapshot): string {
    switch (attempt.state) {
      case 'awaiting_provider': return 'Aguardando provedor';
      case 'awaiting_server_confirmation': return 'Aguardando servidor';
      case 'ready': return 'Confirmado pelo servidor';
      case 'partial': return 'Parcial';
      case 'cancelled': return 'Cancelado pelo servidor';
      case 'expired': return 'Expirado';
      case 'failed': return 'Falhou';
      case 'recoverable_error': return 'Verificação necessária';
    }
  }

  nextActionLabel(attempt: CoexistenceAttemptSnapshot): string {
    switch (attempt.nextAction) {
      case 'WAIT': return 'aguardar processamento';
      case 'CHECK_STATUS': return 'consultar status';
      case 'REAUTHORIZE': return 'refazer autorização';
      case 'RECONCILE': return 'reconciliar resultado incerto';
      case 'RESUME': return 'retomar etapa segura';
      case 'RESOLVE_CONFLICT': return 'resolver conflito';
      case 'NONE': return 'nenhuma ação';
      default: return 'indisponível';
    }
  }

  recoveryLabel(option: CoexistenceRecoveryOption): string {
    if (option.action === 'REAUTHORIZE') return 'Iniciar nova sessão de autorização';
    const action = option.action === 'RESUME' ? 'Retomar' : 'Consultar resultado';
    const stage = option.stage === 'authorization' ? 'autorização'
      : option.stage === 'asset-verification' ? 'verificação de ativos'
      : option.stage === 'subscription' ? 'inscrição'
      : 'projeção';
    return `${action}: ${stage}`;
  }

  ngOnDestroy(): void {
    this.unsubscribe?.();
    this.onboarding.dispose();
  }
}
