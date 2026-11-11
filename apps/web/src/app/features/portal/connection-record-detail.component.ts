import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';
import type { components } from '@ca-meta/contracts';
import { ConnectionCatalogService, ConnectionRecordDetail, assetKindLabel, assetStatusCopy, authorizationStatusCopy, connectionFlowLabel, connectionStatusCopy, credentialHealthCopy, observationTimeCopy, projectionStatusCopy, subscriptionStatusCopy } from '../../core/portal/connection-catalog.service';
import { PortalContextStore } from '../../core/portal/portal-context.store';
import { PortalSessionService } from '../../core/portal/portal-session.service';
import { safeRequestId } from '../../core/portal/safe-api-error';

type ConnectionAsset = components['schemas']['ConnectionAsset'];

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
  private readonly destroy$ = new Subject<void>();
  private currentConnectionId = '';
  private detailGeneration = 0;

  constructor(
    private readonly route: ActivatedRoute,
    private readonly catalog: ConnectionCatalogService,
    private readonly sessions: PortalSessionService,
    private readonly context: PortalContextStore,
  ) {}

  ngOnInit(): void {
    this.route.paramMap.pipe(takeUntil(this.destroy$)).subscribe((params) => {
      const id = params.get('id') ?? '';
      this.currentConnectionId = id;
      void this.load(id);
    });
    this.context.contextChanged$.pipe(takeUntil(this.destroy$)).subscribe(() => { void this.reloadAfterContextChange(); });
  }

  ngOnDestroy(): void {
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

  /** SessionContext has no safe company label in the current contract, so tenant writes stay disabled. */
  get writesAllowed(): boolean { return false; }

  private async load(id: string): Promise<void> {
    const generation = ++this.detailGeneration;
    if (!id) {
      this.connection = null;
      this.isLoading = false;
      this.errorMessage = 'Esta conexão não foi encontrada.';
      this.errorRequestId = null;
      return;
    }
    this.connection = null;
    this.isLoading = true;
    this.errorMessage = '';
    this.errorRequestId = null;
    try {
      const connection = await this.catalog.detail(id);
      if (generation !== this.detailGeneration) return;
      this.connection = connection;
    } catch (error: unknown) {
      if (generation !== this.detailGeneration) return;
      this.errorMessage = 'Não foi possível carregar os detalhes desta conexão.';
      this.errorRequestId = safeRequestId(error);
    } finally {
      if (generation === this.detailGeneration) this.isLoading = false;
    }
  }

  private async reloadAfterContextChange(): Promise<void> {
    const generation = ++this.detailGeneration;
    this.connection = null;
    this.errorMessage = '';
    this.errorRequestId = null;
    this.isLoading = true;
    const session = await this.sessions.ensureCurrentSession(true);
    if (generation !== this.detailGeneration) return;
    if (!session) {
      this.isLoading = false;
      this.errorMessage = 'A sessão não está disponível para este contexto. Entre novamente.';
      return;
    }
    await this.load(this.currentConnectionId);
  }
}
