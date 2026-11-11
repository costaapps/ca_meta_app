import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';
import { ConnectionCatalogFilters, ConnectionCatalogService, ConnectionChannel, ConnectionFlowVariant, ConnectionRecord, ConnectionStatus, ConnectionStatusFilter, connectionFlowLabel, connectionStatusCopy } from '../../core/portal/connection-catalog.service';
import { PortalContextStore } from '../../core/portal/portal-context.store';
import { PortalSessionService } from '../../core/portal/portal-session.service';
import { MetaFlowCard, MetaFlowCatalogService } from '../../core/portal/meta-flow-catalog.service';
import { safeRequestId } from '../../core/portal/safe-api-error';

@Component({
  selector: 'app-connections-home',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './connections-home.component.html',
  styleUrl: './connections-home.component.scss',
})
export class ConnectionsHomeComponent implements OnInit, OnDestroy {
  cards: readonly MetaFlowCard[] = [];
  connections: readonly ConnectionRecord[] = [];
  filters: { channel: ConnectionChannel | ''; flowVariant: ConnectionFlowVariant | ''; number: string; status: ConnectionStatusFilter | '' } = {
    channel: '', flowVariant: '', number: '', status: '',
  };
  isLoading = true;
  isCatalogLoading = true;
  listError = '';
  catalogError = '';
  listRequestId: string | null = null;
  catalogRequestId: string | null = null;
  nextCursor: string | null = null;
  pageIndex = 0;
  private appliedFilters: ConnectionCatalogFilters = {};
  private cursorHistory: Array<string | undefined> = [undefined];
  private listGeneration = 0;
  private catalogGeneration = 0;
  private readonly destroy$ = new Subject<void>();

  constructor(
    private readonly flowCatalog: MetaFlowCatalogService,
    private readonly connectionCatalog: ConnectionCatalogService,
    private readonly sessions: PortalSessionService,
    private readonly context: PortalContextStore,
  ) {}

  ngOnInit(): void {
    void this.loadConnections();
    void this.loadCatalog();
    this.context.contextChanged$.pipe(takeUntil(this.destroy$)).subscribe(() => { void this.resetAfterContextChange(); });
    this.context.sessionExpired$.pipe(takeUntil(this.destroy$)).subscribe(() => { this.clearForExpiredSession(); });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  flowPath(card: MetaFlowCard): string {
    const slug: Record<MetaFlowCard['id'], string> = {
      WHATSAPP_EXCLUSIVE: 'whatsapp-api',
      WHATSAPP_COEXISTENCE: 'whatsapp-app',
      INSTAGRAM: 'instagram',
      FACEBOOK: 'facebook',
    };
    return `/connections/new/${slug[card.id]}`;
  }

  applyFilters(): Promise<void> {
    const number = this.filters.number.trim();
    this.appliedFilters = Object.freeze({
      ...(this.filters.channel ? { channel: this.filters.channel } : {}),
      ...(this.filters.flowVariant ? { flowVariant: this.filters.flowVariant } : {}),
      ...(number ? { number } : {}),
      ...(this.filters.status ? { status: this.filters.status } : {}),
    });
    this.cursorHistory = [undefined];
    this.pageIndex = 0;
    return this.loadConnections();
  }

  clearFilters(): Promise<void> {
    this.filters = { channel: '', flowVariant: '', number: '', status: '' };
    return this.applyFilters();
  }

  previousPage(): Promise<void> {
    if (this.pageIndex === 0) return Promise.resolve();
    this.pageIndex -= 1;
    return this.loadConnections();
  }

  nextPage(): Promise<void> {
    if (!this.nextCursor) return Promise.resolve();
    this.cursorHistory[this.pageIndex + 1] = this.nextCursor;
    this.pageIndex += 1;
    return this.loadConnections();
  }

  flowLabel(connection: ConnectionRecord): string {
    return connectionFlowLabel(connection.flowVariant);
  }

  statusCopy(connection: ConnectionRecord): string {
    return connectionStatusCopy(connection);
  }

  statusLabel(connection: ConnectionRecord): string {
    if (connection.stale) return 'Status desatualizado';
    if (connection.status === 'ACTIVE' && connection.readiness === 'READY') return 'Conexão pronta';
    if (connection.status === 'PARTIAL' || connection.readiness === 'PARTIAL') return 'Conexão parcial';
    if (connection.status === 'REAUTH_REQUIRED') return 'Autorização necessária';
    if (connection.status === 'DISCONNECTED') return 'Desconectada';
    return 'Status não confirmado';
  }

  trackByConnection(_index: number, connection: ConnectionRecord): string { return connection.id; }

  private async loadConnections(): Promise<void> {
    const generation = ++this.listGeneration;
    this.isLoading = true;
    this.listError = '';
    this.listRequestId = null;
    try {
      const cursor = this.cursorHistory[this.pageIndex];
      const page = await this.connectionCatalog.list(this.appliedFilters, cursor);
      if (generation !== this.listGeneration) return;
      this.connections = page.items;
      this.nextCursor = page.nextCursor;
      this.listRequestId = page.requestId;
    } catch (error: unknown) {
      if (generation !== this.listGeneration) return;
      this.connections = [];
      this.nextCursor = null;
      this.listError = 'Não foi possível carregar as conexões.';
      this.listRequestId = safeRequestId(error);
    } finally {
      if (generation === this.listGeneration) this.isLoading = false;
    }
  }

  private async loadCatalog(): Promise<void> {
    const generation = ++this.catalogGeneration;
    this.isCatalogLoading = true;
    this.catalogError = '';
    this.catalogRequestId = null;
    try {
      const response = await this.flowCatalog.load();
      if (generation !== this.catalogGeneration) return;
      this.cards = this.flowCatalog.cards(response);
    } catch (error: unknown) {
      if (generation !== this.catalogGeneration) return;
      this.catalogError = 'Não foi possível consultar a disponibilidade dos fluxos.';
      this.catalogRequestId = safeRequestId(error);
    } finally {
      if (generation === this.catalogGeneration) this.isCatalogLoading = false;
    }
  }

  private async resetAfterContextChange(): Promise<void> {
    const generation = ++this.listGeneration;
    this.catalogGeneration += 1;
    this.connections = [];
    this.cards = [];
    this.nextCursor = null;
    this.cursorHistory = [undefined];
    this.pageIndex = 0;
    this.filters = { channel: '', flowVariant: '', number: '', status: '' };
    this.appliedFilters = {};
    this.listRequestId = null;
    this.listError = '';
    this.catalogRequestId = null;
    this.catalogError = '';
    this.isLoading = true;
    this.isCatalogLoading = true;
    const session = await this.sessions.ensureCurrentSession(true);
    if (generation !== this.listGeneration) return;
    if (!session) {
      this.isLoading = false;
      this.isCatalogLoading = false;
      this.listError = 'A sessão não está disponível para este contexto. Entre novamente.';
      return;
    }
    await Promise.all([this.loadConnections(), this.loadCatalog()]);
  }

  private clearForExpiredSession(): void {
    this.listGeneration += 1;
    this.catalogGeneration += 1;
    this.connections = [];
    this.cards = [];
    this.nextCursor = null;
    this.cursorHistory = [undefined];
    this.pageIndex = 0;
    this.filters = { channel: '', flowVariant: '', number: '', status: '' };
    this.appliedFilters = {};
    this.listRequestId = null;
    this.catalogRequestId = null;
    this.isLoading = false;
    this.isCatalogLoading = false;
    this.listError = 'Sua sessão terminou. Entre novamente para ver as conexões desta empresa.';
    this.catalogError = '';
  }
}
