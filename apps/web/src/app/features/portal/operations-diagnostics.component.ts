import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';
import { OperationsDiagnosticsService, type OperationsDiagnostics, type OperationsDiagnosticSection } from '../../core/portal/operations-diagnostics.service';
import { PortalContextStore } from '../../core/portal/portal-context.store';
import { safeRequestId } from '../../core/portal/safe-api-error';

@Component({
  selector: 'app-operations-diagnostics',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './operations-diagnostics.component.html',
  styleUrl: './operations-diagnostics.component.scss',
})
export class OperationsDiagnosticsComponent implements OnInit, OnDestroy {
  diagnostics: OperationsDiagnostics | null = null;
  loading = true;
  isRefreshing = false;
  errorMessage = '';
  errorRequestId: string | null = null;
  private readonly destroy$ = new Subject<void>();
  private readGeneration = 0;

  constructor(private readonly operations: OperationsDiagnosticsService, private readonly context: PortalContextStore) {}

  ngOnInit(): void {
    void this.refresh();
    this.context.contextChanged$.pipe(takeUntil(this.destroy$)).subscribe(() => { void this.refresh(); });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  async refresh(): Promise<void> {
    const generation = ++this.readGeneration;
    this.isRefreshing = this.diagnostics !== null;
    this.loading = this.diagnostics === null;
    this.errorMessage = '';
    this.errorRequestId = null;
    try {
      const result = await this.operations.read();
      if (generation !== this.readGeneration) return;
      this.diagnostics = result;
    } catch (error: unknown) {
      if (generation !== this.readGeneration) return;
      this.errorMessage = 'Não foi possível confirmar o status agora. Tente atualizar novamente.';
      this.errorRequestId = safeRequestId(error);
    } finally {
      if (generation === this.readGeneration) {
        this.loading = false;
        this.isRefreshing = false;
      }
    }
  }

  stateCopy(section: OperationsDiagnosticSection | undefined): string {
    switch (section?.state) {
      case 'HEALTHY': return 'Confirmado';
      case 'ACTION_REQUIRED': return 'Precisa de atenção';
      case 'PENDING': return 'Em andamento';
      case 'FAILED': return 'Não foi concluído';
      default: return 'Ainda não confirmado';
    }
  }

  nextActionCopy(action: OperationsDiagnostics['nextAction']): string {
    switch (action) {
      case 'REQUEST_REAUTHORIZATION': return 'A autorização pode precisar ser atualizada. Confirme a identidade da empresa antes de solicitar uma nova autorização.';
      case 'WAIT_FOR_PROCESSING': return 'Há uma tarefa em andamento. Aguarde e atualize o status depois.';
      case 'CONTACT_SUPPORT': return 'Peça ao suporte para revisar a tarefa. Não tente repeti-la enquanto o resultado estiver sendo confirmado.';
      case 'REVIEW_SYNC': return 'Peça ao suporte para revisar a sincronização antes de tentar novamente.';
      case 'CHECK_CONNECTION': return 'O status de uma ou mais etapas não foi confirmado. Atualize a página ou peça ajuda ao suporte.';
      case 'NO_ACTION': return 'Nenhuma ação é necessária agora.';
      default: return 'A próxima ação ainda não foi confirmada.';
    }
  }

  statusLabel(value: OperationsDiagnostics['onboarding']['nextAction']): string {
    switch (value) {
      case 'REQUEST_REAUTHORIZATION': return 'Atualizar autorização';
      case 'WAIT_FOR_PROCESSING': return 'Aguardar conclusão';
      case 'REVIEW_STATUS': return 'Verificar status';
      case 'RESUME_SETUP': return 'Retomar configuração';
      case 'CONTACT_SUPPORT': return 'Falar com o suporte';
      case 'NO_ACTION': return 'Nenhuma ação necessária';
      default: return 'Ação não confirmada';
    }
  }

  jobCount(report: OperationsDiagnostics, ...statuses: readonly string[]): number {
    return statuses.reduce((total, status) => total + (report.jobs.counts[status] ?? 0), 0);
  }
}
