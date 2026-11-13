import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';
import type { components } from '@ca-meta/contracts';
import { ConnectionCatalogService, type ConnectionJobStatus, type ConnectionRecordDetail, assetKindLabel, assetStatusCopy, authorizationStatusCopy, connectionFlowLabel, connectionStatusCopy, credentialHealthCopy, observationTimeCopy, projectionStatusCopy, subscriptionStatusCopy } from '../../core/portal/connection-catalog.service';
import { PortalContextStore } from '../../core/portal/portal-context.store';
import { PortalSessionService } from '../../core/portal/portal-session.service';
import { PortalTenantIdentityService } from '../../core/portal/portal-tenant-identity.service';
import { safeRequestId } from '../../core/portal/safe-api-error';

type ConnectionAsset = components['schemas']['ConnectionAsset'];
type RefreshStatus = ConnectionJobStatus['status'];

interface RefreshJobPresentation {
  busy: boolean;
  jobId: string | null;
  status: RefreshStatus | null;
  message: string;
  requestId: string | null;
  canCheck: boolean;
}

const REFRESH_POLL_INTERVAL_MS = 1_000;
const REFRESH_POLL_ATTEMPTS = 5;
const SAFE_REFERENCE = /^[A-Za-z0-9_-]{1,128}$/;

@Component({
  selector: 'app-connection-record-detail',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './connection-record-detail.component.html',
  styleUrl: './connection-record-detail.component.scss',
})
export class ConnectionRecordDetailComponent implements OnInit, OnDestroy {
  connection: ConnectionRecordDetail | null = null;
  isLoading = true;
  errorMessage = '';
  errorRequestId: string | null = null;
  readonly writesUnavailableCopy = 'Identidade da empresa não confirmada. Ações de alteração indisponíveis até que a empresa possa ser identificada com segurança.';
  readonly refreshStates = new Map<string, RefreshJobPresentation>();
  private readonly destroy$ = new Subject<void>();
  private currentConnectionId = '';
  private detailGeneration = 0;
  private refreshGeneration = 0;
  private destroyed = false;
  private readonly pollTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly pollWaiters = new Map<ReturnType<typeof setTimeout>, (continuePolling: boolean) => void>();

  constructor(
    private readonly route: ActivatedRoute,
    private readonly catalog: ConnectionCatalogService,
    private readonly sessions: PortalSessionService,
    private readonly context: PortalContextStore,
    private readonly tenantIdentity: PortalTenantIdentityService,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.route.paramMap.pipe(takeUntil(this.destroy$)).subscribe((params) => {
      const id = params.get('id') ?? '';
      if (id !== this.currentConnectionId) this.invalidateRefreshWork();
      this.currentConnectionId = id;
      void this.load(id);
    });
    this.context.contextChanged$.pipe(takeUntil(this.destroy$)).subscribe(() => {
      this.invalidateRefreshWork();
      void this.reloadAfterContextChange();
    });
    this.context.sessionExpired$.pipe(takeUntil(this.destroy$)).subscribe(() => { this.clearForExpiredSession(); });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.invalidateRefreshWork();
    this.destroy$.next();
    this.destroy$.complete();
  }

  flowLabel(connection: ConnectionRecordDetail): string { return connectionFlowLabel(connection.flowVariant); }
  statusCopy(connection: ConnectionRecordDetail): string { return connectionStatusCopy(connection); }
  assetKindLabel(asset: ConnectionAsset): string { return assetKindLabel(asset.kind); }
  assetStatusCopy(asset: ConnectionAsset): string { return assetStatusCopy(asset); }
  authorizationCopy(asset: ConnectionAsset): string { return authorizationStatusCopy(asset.authorizationStatus); }
  credentialCopy(asset: ConnectionAsset): string {
    return credentialHealthCopy(asset.diagnostics?.tokenHealth ?? this.connection?.diagnostics?.tokenHealth ?? 'UNKNOWN');
  }
  evidenceTime(asset: ConnectionAsset): string { return observationTimeCopy(asset); }

  subscriptionCopy(asset: ConnectionAsset): string {
    const state = asset.statusObservation?.subscriptionState ?? asset.diagnostics?.subscriptionState ??
      this.connection?.diagnostics?.subscriptionState ?? 'UNKNOWN';
    return subscriptionStatusCopy(state);
  }

  projectionCopy(asset: ConnectionAsset): string {
    const state = asset.statusObservation?.projectionState ?? asset.diagnostics?.projectionState ??
      this.connection?.diagnostics?.projectionState ?? 'UNKNOWN';
    return projectionStatusCopy(state);
  }

  assetTitle(asset: ConnectionAsset, index: number): string {
    if (asset.kind === 'PHONE_NUMBER') {
      const ordinal = this.connection?.assets.slice(0, index + 1).filter((candidate) => candidate.kind === 'PHONE_NUMBER').length ?? 1;
      return `Número do WhatsApp ${ordinal}`;
    }
    return this.assetKindLabel(asset);
  }

  canShowReauthorization(asset: ConnectionAsset): boolean { return asset.capabilities?.canReauthorize === true; }
  canShowDisconnect(asset: ConnectionAsset): boolean { return asset.capabilities?.canDisconnect === true; }
  canStartRefresh(asset: ConnectionAsset): boolean {
    const state = this.refreshStates.get(asset.id);
    const jobActive = !!state?.jobId && !this.isTerminalStatus(state.status ?? 'UNKNOWN');
    return this.writesAllowed && asset.capabilities?.canRefresh === true && state?.busy !== true && !jobActive;
  }
  refreshState(asset: ConnectionAsset): RefreshJobPresentation | null { return this.refreshStates.get(asset.id) ?? null; }
  refreshDisabledCopy(asset: ConnectionAsset): string {
    if (!this.writesAllowed) return this.writesUnavailableCopy;
    return asset.capabilities?.canRefresh === true
      ? 'Uma atualização já está em andamento para este recurso.'
      : 'O servidor não habilitou a atualização de status para este recurso neste ambiente.';
  }
  canShowAutomationConfig(asset: ConnectionAsset): boolean {
    return asset.kind === 'PHONE_NUMBER' || asset.kind === 'PAGE' || asset.kind === 'INSTAGRAM_ACCOUNT';
  }

  /** Every tenant write remains gated by confirmed server/host identity evidence. */
  get writesAllowed(): boolean { return this.tenantIdentity.current.confirmed; }

  async startRefresh(asset: ConnectionAsset): Promise<void> {
    if (!this.canStartRefresh(asset)) return;
    const generation = this.refreshGeneration;
    const state: RefreshJobPresentation = {
      busy: true, jobId: null, status: null, message: 'Solicitando atualização de status…', requestId: null, canCheck: false,
    };
    this.refreshStates.set(asset.id, state);
    this.cdr.markForCheck();
    try {
      // The asset ID is the server-owned internal reference. Never trust JobAccepted.location.
      const accepted = await this.catalog.refresh(asset.id);
      if (!this.isRefreshCurrent(generation)) return;
      if (typeof accepted.jobId !== 'string' || !accepted.jobId || accepted.jobId.length > 128) {
        state.busy = false;
        state.message = 'O servidor não confirmou uma referência de acompanhamento válida.';
        state.requestId = this.safeReference(accepted.requestId);
        this.cdr.markForCheck();
        return;
      }
      state.jobId = accepted.jobId;
      state.status = accepted.status;
      state.requestId = this.safeReference(accepted.requestId);
      state.message = 'Atualização recebida pelo servidor.';
      this.cdr.markForCheck();
      await this.pollJob(accepted.jobId, generation, 0, state);
    } catch (error: unknown) {
      if (!this.isRefreshCurrent(generation)) return;
      state.busy = false;
      state.message = this.refreshFailureCopy(error, 'start');
      state.requestId = safeRequestId(error);
      this.cdr.markForCheck();
    }
  }

  async checkRefreshJob(asset: ConnectionAsset): Promise<void> {
    const state = this.refreshStates.get(asset.id);
    if (!this.writesAllowed || !state?.jobId || !state.canCheck || state.busy) return;
    const generation = this.refreshGeneration;
    const jobId = state.jobId;
    state.busy = true;
    state.canCheck = false;
    state.message = 'Verificando atualização…';
    this.cdr.markForCheck();
    try {
      await this.readJob(jobId, generation, state);
    } catch (error: unknown) {
      if (!this.isRefreshCurrent(generation)) return;
      state.busy = false;
      state.canCheck = true;
      state.message = this.refreshFailureCopy(error, 'read');
      state.requestId = safeRequestId(error) ?? state.requestId;
      this.cdr.markForCheck();
    }
  }

  refreshStatusCopy(status: RefreshStatus | null): string {
    switch (status) {
      case 'PENDING': return 'A atualização está aguardando processamento.';
      case 'RUNNING': return 'O servidor está processando a atualização.';
      case 'RETRY_PENDING': return 'O servidor agendou uma nova tentativa.';
      case 'SUCCEEDED': return 'A atualização foi concluída.';
      case 'FAILED': return 'A atualização não foi concluída.';
      case 'CANCELLED': return 'A atualização foi cancelada.';
      case 'UNKNOWN': return 'O servidor ainda não confirmou o resultado.';
      case null: return 'O servidor ainda não retornou o status.';
    }
  }

  private async load(id: string): Promise<void> {
    const generation = ++this.detailGeneration;
    if (!id) {
      this.connection = null;
      this.isLoading = false;
      this.errorMessage = 'Esta conexão não foi encontrada.';
      this.errorRequestId = null;
      this.cdr.markForCheck();
      return;
    }
    this.connection = null;
    this.isLoading = true;
    this.errorMessage = '';
    this.errorRequestId = null;
    this.cdr.markForCheck();
    try {
      const connection = await this.catalog.detail(id);
      if (generation !== this.detailGeneration) return;
      this.connection = connection;
    } catch (error: unknown) {
      if (generation !== this.detailGeneration) return;
      this.errorMessage = 'Não foi possível carregar os detalhes desta conexão.';
      this.errorRequestId = safeRequestId(error);
    } finally {
      if (generation === this.detailGeneration) {
        this.isLoading = false;
        this.cdr.markForCheck();
      }
    }
  }

  private async reloadAfterContextChange(): Promise<void> {
    const generation = ++this.detailGeneration;
    this.connection = null;
    this.errorMessage = '';
    this.errorRequestId = null;
    this.isLoading = true;
    this.cdr.markForCheck();
    const session = await this.sessions.ensureCurrentSession(true);
    if (generation !== this.detailGeneration) return;
    if (!session) {
      this.isLoading = false;
      this.errorMessage = 'A sessão não está disponível para este contexto. Entre novamente.';
      this.cdr.markForCheck();
      return;
    }
    await this.load(this.currentConnectionId);
  }

  private clearForExpiredSession(): void {
    this.invalidateRefreshWork();
    this.detailGeneration += 1;
    this.currentConnectionId = '';
    this.connection = null;
    this.errorMessage = 'Sua sessão terminou. Entre novamente para ver os detalhes desta conexão.';
    this.errorRequestId = null;
    this.isLoading = false;
    this.cdr.markForCheck();
  }

  private async pollJob(jobId: string, generation: number, attempt: number,
    state: RefreshJobPresentation): Promise<void> {
    if (attempt >= REFRESH_POLL_ATTEMPTS || !this.isRefreshCurrent(generation)) {
      if (this.isRefreshCurrent(generation)) {
        state.busy = false;
        state.canCheck = true;
        state.message = 'O acompanhamento automático foi pausado. Você pode verificar o status novamente.';
        this.cdr.markForCheck();
      }
      return;
    }
    if (attempt > 0 && !await this.waitBeforeNextPoll(generation)) return;
    if (!this.isRefreshCurrent(generation)) return;
    try {
      const status = await this.catalog.job(jobId);
      if (!this.isRefreshCurrent(generation)) return;
      if (status.id !== jobId) {
        state.busy = false;
        state.canCheck = false;
        state.message = 'O servidor retornou um resultado de acompanhamento inválido.';
        this.cdr.markForCheck();
        return;
      }
      this.updateJobPresentation(state, status);
      if (this.isTerminalStatus(status.status)) {
        state.busy = false;
        state.canCheck = false;
        if (status.status === 'SUCCEEDED') void this.load(this.currentConnectionId);
        this.cdr.markForCheck();
        return;
      }
      this.cdr.markForCheck();
      await this.pollJob(jobId, generation, attempt + 1, state);
    } catch (error: unknown) {
      if (!this.isRefreshCurrent(generation)) return;
      state.busy = false;
      state.canCheck = true;
      state.message = this.refreshFailureCopy(error, 'read');
      state.requestId = safeRequestId(error) ?? state.requestId;
      this.cdr.markForCheck();
    }
  }

  private async readJob(jobId: string, generation: number, state: RefreshJobPresentation): Promise<void> {
    const status = await this.catalog.job(jobId);
    if (!this.isRefreshCurrent(generation)) return;
    if (status.id !== jobId) {
      state.busy = false;
      state.canCheck = false;
      state.message = 'O servidor retornou um resultado de acompanhamento inválido.';
      this.cdr.markForCheck();
      return;
    }
    this.updateJobPresentation(state, status);
    state.busy = false;
    state.canCheck = !this.isTerminalStatus(status.status);
    if (status.status === 'SUCCEEDED') void this.load(this.currentConnectionId);
    this.cdr.markForCheck();
  }

  private updateJobPresentation(state: RefreshJobPresentation, status: ConnectionJobStatus): void {
    state.status = status.status;
    state.requestId = this.safeReference(status.requestId) ?? state.requestId;
    state.message = this.refreshStatusCopy(status.status);
  }

  private isTerminalStatus(status: RefreshStatus): boolean {
    return status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED';
  }

  private refreshFailureCopy(error: unknown, operation: 'start' | 'read'): string {
    if (error instanceof HttpErrorResponse && error.status === 429) {
      return 'O servidor está temporariamente limitando esta operação. Aguarde antes de tentar novamente.';
    }
    if (error instanceof HttpErrorResponse && error.status === 503) {
      return operation === 'start'
        ? 'A atualização de status está indisponível neste ambiente.'
        : 'O acompanhamento está temporariamente indisponível. Tente verificar novamente mais tarde.';
    }
    return operation === 'start'
      ? 'Não foi possível solicitar a atualização de status.'
      : 'Não foi possível consultar o status da atualização.';
  }

  private safeReference(value: unknown): string | null {
    return typeof value === 'string' && SAFE_REFERENCE.test(value) ? value : null;
  }

  private isRefreshCurrent(generation: number): boolean {
    return !this.destroyed && generation === this.refreshGeneration && this.writesAllowed && !!this.currentConnectionId;
  }

  private waitBeforeNextPoll(generation: number): Promise<boolean> {
    if (!this.isRefreshCurrent(generation)) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      timer = setTimeout(() => {
        this.pollTimers.delete(timer);
        this.pollWaiters.delete(timer);
        resolve(this.isRefreshCurrent(generation));
      }, REFRESH_POLL_INTERVAL_MS);
      this.pollTimers.add(timer);
      this.pollWaiters.set(timer, resolve);
    });
  }

  private invalidateRefreshWork(): void {
    this.refreshGeneration += 1;
    for (const timer of this.pollTimers) clearTimeout(timer);
    for (const [timer, resolve] of this.pollWaiters) {
      resolve(false);
      this.pollWaiters.delete(timer);
    }
    this.pollTimers.clear();
    this.refreshStates.clear();
  }
}
