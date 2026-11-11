import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subject, takeUntil } from 'rxjs';
import type { components } from '@ca-meta/contracts';
import { PortalContextStore } from '../../core/portal/portal-context.store';
import { PortalSessionService } from '../../core/portal/portal-session.service';
import { safeRequestId } from '../../core/portal/safe-api-error';
import { TemplateAsset, TemplateCreateRequest, TemplateJobStatus, TemplateListPage, TemplateRecord, WhatsAppTemplatesService } from '../../core/portal/whatsapp-templates.service';

type TemplateCategory = TemplateCreateRequest['category'];
type TemplateForm = { name: string; language: string; category: TemplateCategory; bodyText: string };

@Component({
  selector: 'app-whatsapp-templates',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './whatsapp-templates.component.html',
  styleUrl: './whatsapp-templates.component.scss',
})
export class WhatsAppTemplatesComponent implements OnInit, OnDestroy {
  accounts: readonly TemplateAsset[] = [];
  selectedAssetId = '';
  templates: readonly TemplateRecord[] = [];
  nextCursor: string | null = null;
  pageIndex = 0;
  isLoadingAccounts = true;
  isLoadingTemplates = false;
  isCreating = false;
  accountError = '';
  listError = '';
  formError = '';
  statusMessage = '';
  requestId: string | null = null;
  jobId: string | null = null;
  jobStatus: TemplateJobStatus | null = null;
  jobStatusError = '';
  isCheckingJob = false;
  examplesText = '';
  form: TemplateForm = { name: '', language: '', category: 'UTILITY', bodyText: '' };
  private readonly destroy$ = new Subject<void>();
  private accountGeneration = 0;
  private templateGeneration = 0;
  private lastCreateFingerprint = '';
  private createIdempotencyKey = '';
  private readonly cursorHistory: Array<string | undefined> = [undefined];

  constructor(
    private readonly service: WhatsAppTemplatesService,
    private readonly sessions: PortalSessionService,
    private readonly context: PortalContextStore,
  ) {}

  ngOnInit(): void {
    void this.loadAccounts();
    this.context.contextChanged$.pipe(takeUntil(this.destroy$)).subscribe(() => { void this.reloadForCurrentContext(); });
    this.context.sessionExpired$.pipe(takeUntil(this.destroy$)).subscribe(() => this.clearForExpiredSession());
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  get selectedAccount(): TemplateAsset | undefined { return this.accounts.find((asset) => asset.id === this.selectedAssetId); }
  get accountCanManageTemplates(): boolean {
    const selected = this.selectedAccount;
    return selected?.kind === 'WHATSAPP_BUSINESS_ACCOUNT' && selected.authorizationStatus === 'VERIFIED' &&
      selected.status === 'ACTIVE' && !selected.stale && selected.capabilities?.canManageTemplates === true;
  }

  selectAccount(assetId: string): void {
    if (!this.accounts.some((asset) => asset.id === assetId)) return;
    const changed = assetId !== this.selectedAssetId;
    if (changed) {
      this.accountGeneration += 1;
      this.templateGeneration += 1;
      this.isCreating = false;
      this.isCheckingJob = false;
      this.jobId = null;
      this.jobStatus = null;
      this.jobStatusError = '';
      this.lastCreateFingerprint = '';
      this.createIdempotencyKey = '';
    }
    this.selectedAssetId = assetId;
    this.templates = [];
    this.cursorHistory.splice(0, this.cursorHistory.length, undefined);
    this.pageIndex = 0;
    this.nextCursor = null;
    this.requestId = null;
    this.listError = '';
    this.statusMessage = '';
    if (this.accountCanManageTemplates) void this.loadTemplates();
  }

  previousPage(): Promise<void> {
    if (this.pageIndex === 0 || !this.accountCanManageTemplates) return Promise.resolve();
    this.pageIndex -= 1;
    return this.loadTemplates();
  }

  nextPage(): Promise<void> {
    if (!this.nextCursor || !this.accountCanManageTemplates) return Promise.resolve();
    this.cursorHistory[this.pageIndex + 1] = this.nextCursor;
    this.pageIndex += 1;
    return this.loadTemplates();
  }

  async createTemplate(): Promise<void> {
    this.formError = '';
    this.statusMessage = '';
    if (!this.accountCanManageTemplates || this.isCreating) return;
    const generation = this.accountGeneration;
    const assetId = this.selectedAssetId;
    const examples = this.parseExamples(this.form.bodyText, this.examplesText);
    if (!examples) {
      this.formError = 'Confira os marcadores do texto e informe um exemplo para cada valor distinto, na ordem.';
      return;
    }
    const request: TemplateCreateRequest = {
      name: this.form.name.trim(),
      language: this.form.language.trim(),
      category: this.form.category,
      bodyText: this.form.bodyText,
      exampleValues: examples,
    };
    if (!this.validRequest(request)) {
      this.formError = 'Revise nome, idioma, categoria e texto do modelo.';
      return;
    }

    const fingerprint = JSON.stringify(request);
    if (fingerprint !== this.lastCreateFingerprint) {
      const key = globalThis.crypto?.randomUUID?.();
      if (!key) {
        this.formError = 'Este navegador não conseguiu criar uma chave segura para o pedido.';
        return;
      }
      this.lastCreateFingerprint = fingerprint;
      this.createIdempotencyKey = key;
    }

    this.isCreating = true;
    this.requestId = null;
    try {
      const accepted = await this.service.create(assetId, request, this.createIdempotencyKey);
      if (generation !== this.accountGeneration || assetId !== this.selectedAssetId) return;
      if (!this.isAcceptedJob(accepted)) throw new Error('The template request was not accepted.');
      this.requestId = accepted.requestId;
      this.jobId = accepted.jobId;
      this.jobStatus = null;
      this.jobStatusError = '';
      this.statusMessage = 'Pedido enviado para processamento. A aceitação da solicitação não confirma aprovação do modelo pela Meta.';
    } catch (error: unknown) {
      if (generation !== this.accountGeneration || assetId !== this.selectedAssetId) return;
      this.formError = 'Não foi possível confirmar o envio do pedido. Consulte o status antes de tentar novamente.';
      this.requestId = safeRequestId(error);
    } finally {
      if (generation === this.accountGeneration && assetId === this.selectedAssetId) this.isCreating = false;
    }
  }

  async checkJobStatus(): Promise<void> {
    if (!this.jobId || this.isCheckingJob) return;
    const generation = this.accountGeneration;
    const jobId = this.jobId;
    this.isCheckingJob = true;
    this.jobStatusError = '';
    try {
      const status = await this.service.job(jobId);
      if (generation !== this.accountGeneration || jobId !== this.jobId) return;
      this.jobStatus = status;
      if (this.jobStatus.status === 'SUCCEEDED') {
        this.statusMessage = 'O pedido foi encaminhado ao provedor. O estado do trabalho não confirma aprovação do modelo pela Meta.';
      } else if (this.jobStatus.status === 'UNKNOWN') {
        this.statusMessage = 'O resultado ainda não está confirmado. Atualize a lista de modelos antes de fazer outro pedido.';
      } else if (this.jobStatus.status === 'FAILED') {
        this.statusMessage = 'O pedido não foi concluído. Consulte os detalhes seguros do trabalho antes de tentar novamente.';
      } else {
        this.statusMessage = 'O pedido continua em processamento.';
      }
      this.requestId = this.jobStatus.requestId;
    } catch (error: unknown) {
      if (generation !== this.accountGeneration || jobId !== this.jobId) return;
      this.jobStatusError = 'Não foi possível consultar o status do pedido.';
      this.requestId = safeRequestId(error);
    } finally {
      if (generation === this.accountGeneration && jobId === this.jobId) this.isCheckingJob = false;
    }
  }

  trackByAsset(_index: number, asset: TemplateAsset): string { return asset.id; }
  trackByTemplate(_index: number, item: TemplateRecord): string { return `${item.id}:${item.language}`; }

  private async loadAccounts(): Promise<void> {
    const generation = ++this.accountGeneration;
    this.isLoadingAccounts = true;
    this.accountError = '';
    this.statusMessage = '';
    this.accounts = [];
    this.templates = [];
    this.selectedAssetId = '';
    try {
      this.accounts = await this.service.accounts();
      if (generation !== this.accountGeneration) return;
      const first = this.accounts[0];
      if (first) {
        this.selectedAssetId = first.id;
        if (this.accountCanManageTemplates) await this.loadTemplates();
      }
    } catch (error: unknown) {
      if (generation !== this.accountGeneration) return;
      this.accountError = 'Não foi possível carregar as contas WhatsApp desta empresa.';
      this.requestId = safeRequestId(error);
    } finally {
      if (generation === this.accountGeneration) this.isLoadingAccounts = false;
    }
  }

  private async loadTemplates(): Promise<void> {
    const generation = ++this.templateGeneration;
    this.isLoadingTemplates = true;
    this.listError = '';
    this.statusMessage = '';
    this.requestId = null;
    try {
      const page = await this.service.list(this.selectedAssetId, this.cursorHistory[this.pageIndex]);
      if (generation !== this.templateGeneration) return;
      if (!this.isTemplatePage(page)) throw new Error('The template list response was not valid.');
      this.templates = page.items;
      this.nextCursor = page.nextCursor;
      this.requestId = page.requestId;
    } catch (error: unknown) {
      if (generation !== this.templateGeneration) return;
      this.templates = [];
      this.nextCursor = null;
      this.listError = 'Não foi possível consultar os modelos desta conta.';
      this.requestId = safeRequestId(error);
    } finally {
      if (generation === this.templateGeneration) this.isLoadingTemplates = false;
    }
  }

  private async reloadForCurrentContext(): Promise<void> {
    this.accountGeneration += 1;
    this.templateGeneration += 1;
    this.isLoadingAccounts = true;
    this.isLoadingTemplates = false;
    this.accounts = [];
    this.templates = [];
    this.selectedAssetId = '';
    this.nextCursor = null;
    this.cursorHistory.splice(0, this.cursorHistory.length, undefined);
    this.pageIndex = 0;
    this.requestId = null;
    this.jobId = null;
    this.jobStatus = null;
    this.jobStatusError = '';
    this.isCheckingJob = false;
    this.isCreating = false;
    this.lastCreateFingerprint = '';
    this.createIdempotencyKey = '';
    this.form = { name: '', language: '', category: 'UTILITY', bodyText: '' };
    this.examplesText = '';
    this.listError = '';
    this.accountError = '';
    this.formError = '';
    this.statusMessage = '';
    if (!await this.sessions.ensureCurrentSession(true)) {
      this.accountError = 'A sessão não está disponível para este contexto. Entre novamente.';
      this.isLoadingAccounts = false;
      return;
    }
    await this.loadAccounts();
  }

  private clearForExpiredSession(): void {
    this.accountGeneration += 1;
    this.templateGeneration += 1;
    this.accounts = [];
    this.templates = [];
    this.selectedAssetId = '';
    this.nextCursor = null;
    this.isLoadingAccounts = false;
    this.isLoadingTemplates = false;
    this.isCreating = false;
    this.isCheckingJob = false;
    this.jobId = null;
    this.jobStatus = null;
    this.jobStatusError = '';
    this.requestId = null;
    this.lastCreateFingerprint = '';
    this.createIdempotencyKey = '';
    this.form = { name: '', language: '', category: 'UTILITY', bodyText: '' };
    this.examplesText = '';
    this.formError = '';
    this.statusMessage = '';
    this.accountError = 'Sua sessão terminou. Entre novamente para consultar os modelos.';
  }

  private parseExamples(bodyText: string, rawExamples: string): readonly string[] | null {
    const values = rawExamples.split(/\r?\n/).map((value) => value.trim()).filter((value) => value.length > 0);
    const placeholderPattern = /\{\{([1-9][0-9]{0,2})\}\}/g;
    const found = new Set<number>();
    for (const match of bodyText.matchAll(placeholderPattern)) {
      const index = Number(match[1]);
      if (index > 100 || (!found.has(index) && index !== found.size + 1)) return null;
      found.add(index);
    }
    const stripped = bodyText.replace(new RegExp(placeholderPattern.source, 'g'), '');
    if (stripped.includes('{{') || stripped.includes('}}') || found.size !== values.length) return null;
    return Object.freeze(values);
  }

  private validRequest(request: TemplateCreateRequest): boolean {
    return /^[a-z0-9_]{1,128}$/.test(request.name) && /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/.test(request.language) &&
      request.bodyText.trim().length > 0 && request.bodyText.length <= 1024 &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(request.bodyText) &&
      (request.exampleValues?.length ?? 0) <= 100 && request.exampleValues?.every((value) => value.trim().length > 0 &&
        value.length <= 1024 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) !== false;
  }

  private isAcceptedJob(value: unknown): value is components['schemas']['JobAccepted'] {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const body = value as Record<string, unknown>;
    return body['status'] === 'PENDING' && typeof body['jobId'] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body['jobId']) &&
      body['location'] === `/api/v1/jobs/${body['jobId']}` && typeof body['requestId'] === 'string' && body['requestId'].length > 0;
  }

  private isTemplatePage(value: unknown): value is TemplateListPage {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const page = value as Record<string, unknown>;
    return Array.isArray(page['items']) && page['items'].length <= 100 &&
      (page['nextCursor'] === null || typeof page['nextCursor'] === 'string') && typeof page['requestId'] === 'string';
  }
}
