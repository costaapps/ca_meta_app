import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, takeUntil } from 'rxjs';
import type { components } from '@ca-meta/contracts';
import { AutomationConfigService, type VersionedAutomationConfig } from '../../core/portal/automation-config.service';
import { PortalContextStore } from '../../core/portal/portal-context.store';
import { PortalTenantIdentityService } from '../../core/portal/portal-tenant-identity.service';
import { safeRequestId } from '../../core/portal/safe-api-error';

type AutomationConfig = components['schemas']['AutomationConfig'];
type AutomationConfigField = components['schemas']['AutomationConfigField'];
type AutomationConfigUpdate = components['schemas']['AutomationConfigUpdate'];
type EditableValues = {
  privateWelcomeMessage: string;
  commentPublicReply: string;
  commentPrivateReply: string;
};

const FIELD_LABELS: Readonly<Record<AutomationConfigField, string>> = Object.freeze({
  privateWelcomeMessage: 'Mensagem privada de boas-vindas',
  commentPublicReply: 'Resposta pública a comentários',
  commentPrivateReply: 'Resposta privada a comentários',
});

@Component({
  selector: 'app-asset-automation-config',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './asset-automation-config.component.html',
  styleUrl: './asset-automation-config.component.scss',
})
export class AssetAutomationConfigComponent implements OnInit, OnDestroy {
  config: AutomationConfig | null = null;
  form: EditableValues = { privateWelcomeMessage: '', commentPublicReply: '', commentPrivateReply: '' };
  isLoading = true;
  isSaving = false;
  errorMessage = '';
  errorRequestId: string | null = null;
  savedMessage = '';
  private etag = '';
  private assetId = '';
  private generation = 0;
  private readonly destroy$ = new Subject<void>();

  constructor(
    private readonly route: ActivatedRoute,
    private readonly settings: AutomationConfigService,
    private readonly context: PortalContextStore,
    readonly tenantIdentity: PortalTenantIdentityService,
  ) {}

  get supportedFields(): readonly AutomationConfigField[] { return this.config?.supportedFields ?? []; }
  get canSave(): boolean {
    return !!this.config?.capabilities.canEdit && this.tenantIdentity.current.confirmed && this.isDirty && !this.isSaving;
  }
  get isDirty(): boolean {
    if (!this.config) return false;
    return this.supportedFields.some((field) => this.form[field] !== (this.config?.[field] ?? ''));
  }
  get writesUnavailableCopy(): string {
    return this.tenantIdentity.current.confirmed
      ? ''
      : 'Identidade da empresa não confirmada. A edição de mensagens está indisponível neste ambiente.';
  }

  ngOnInit(): void {
    this.route.paramMap.pipe(takeUntil(this.destroy$)).subscribe((params) => {
      this.assetId = params.get('id') ?? '';
      void this.load();
    });
    this.context.contextChanged$.pipe(takeUntil(this.destroy$)).subscribe(() => { void this.load(); });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  fieldLabel(field: AutomationConfigField): string { return FIELD_LABELS[field]; }
  supports(field: AutomationConfigField): boolean { return this.supportedFields.includes(field); }

  async save(): Promise<void> {
    if (!this.config || !this.canSave || !this.etag) return;
    const generation = this.generation;
    const assetId = this.assetId;
    const contextRef = this.context.contextRef;
    if (!contextRef) return;
    const update = {
      version: this.config.version,
      ...(this.supports('privateWelcomeMessage') && this.form.privateWelcomeMessage !== (this.config.privateWelcomeMessage ?? '')
        ? { privateWelcomeMessage: this.form.privateWelcomeMessage } : {}),
      ...(this.supports('commentPublicReply') && this.form.commentPublicReply !== (this.config.commentPublicReply ?? '')
        ? { commentPublicReply: this.form.commentPublicReply } : {}),
      ...(this.supports('commentPrivateReply') && this.form.commentPrivateReply !== (this.config.commentPrivateReply ?? '')
        ? { commentPrivateReply: this.form.commentPrivateReply } : {}),
    } satisfies AutomationConfigUpdate;
    if (Object.keys(update).length < 2) return;
    this.isSaving = true;
    this.errorMessage = '';
    this.savedMessage = '';
    this.errorRequestId = null;
    try {
      const next = await this.settings.update(assetId, update, this.etag);
      if (!this.isCurrentSave(generation, assetId, contextRef)) return;
      this.setConfig(next);
      this.savedMessage = 'Configuração salva no catálogo central. A sincronização empresarial está pendente quando indicada abaixo.';
    } catch (error: unknown) {
      if (!this.isCurrentSave(generation, assetId, contextRef)) return;
      this.errorMessage = error instanceof HttpErrorResponse && error.status === 412
        ? 'A configuração mudou em outra sessão. Atualize e revise os valores antes de salvar.'
        : 'Não foi possível salvar a configuração. Nenhuma mensagem foi enviada.';
      this.errorRequestId = safeRequestId(error);
    } finally {
      if (this.isCurrentSave(generation, assetId, contextRef)) this.isSaving = false;
    }
  }

  private async load(): Promise<void> {
    const generation = ++this.generation;
    this.config = null;
    this.isLoading = true;
    this.isSaving = false;
    this.errorMessage = '';
    this.errorRequestId = null;
    this.savedMessage = '';
    if (!this.assetId) {
      this.isLoading = false;
      this.errorMessage = 'Este recurso não foi encontrado.';
      return;
    }
    try {
      const current = await this.settings.read(this.assetId);
      if (generation !== this.generation) return;
      this.setConfig(current);
    } catch (error: unknown) {
      if (generation !== this.generation) return;
      this.errorMessage = 'Não foi possível carregar a configuração deste recurso.';
      this.errorRequestId = safeRequestId(error);
    } finally {
      if (generation === this.generation) this.isLoading = false;
    }
  }

  private setConfig(value: VersionedAutomationConfig): void {
    this.config = value.config;
    this.etag = value.etag;
    this.form = {
      privateWelcomeMessage: value.config.privateWelcomeMessage ?? '',
      commentPublicReply: value.config.commentPublicReply ?? '',
      commentPrivateReply: value.config.commentPrivateReply ?? '',
    };
  }

  private isCurrentSave(generation: number, assetId: string, contextRef: string): boolean {
    return generation === this.generation && assetId === this.assetId && contextRef === this.context.contextRef;
  }
}
