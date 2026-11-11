import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';
import { MetaAuthVariant, MetaFlowProfile, MetaFlowVariant, MetaFlowCatalogService } from '../../core/portal/meta-flow-catalog.service';
import { safeRequestId } from '../../core/portal/safe-api-error';

const FLOW_BY_SLUG: Readonly<Record<string, MetaFlowVariant>> = Object.freeze({
  'whatsapp-api': 'WHATSAPP_EXCLUSIVE',
  'whatsapp-app': 'WHATSAPP_COEXISTENCE',
  instagram: 'INSTAGRAM',
  facebook: 'FACEBOOK',
});

const FLOW_COPY: Readonly<Record<MetaFlowVariant, { title: string; description: string }>> = Object.freeze({
  WHATSAPP_EXCLUSIVE: { title: 'WhatsApp API', description: 'Fluxo para um número dedicado à API do WhatsApp Business.' },
  WHATSAPP_COEXISTENCE: { title: 'WhatsApp + aplicativo', description: 'Fluxo separado para um número que permanece no WhatsApp Business.' },
  INSTAGRAM: { title: 'Instagram', description: 'Conexão de conta profissional com variante definida pela configuração do servidor.' },
  FACEBOOK: { title: 'Facebook', description: 'Conexão de uma página autorizada pelo administrador da empresa.' },
});

@Component({
  selector: 'app-connection-detail',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './connection-detail.component.html',
  styleUrl: './connection-detail.component.scss',
})
export class ConnectionDetailComponent implements OnInit, OnDestroy {
  flow: MetaFlowVariant | null = null;
  title = 'Fluxo de conexão';
  description = '';
  profiles: readonly MetaFlowProfile[] = [];
  selectedAuthVariant: MetaAuthVariant | '' = '';
  isLoading = true;
  errorMessage = '';
  errorRequestId: string | null = null;
  private readonly destroy$ = new Subject<void>();

  constructor(private readonly route: ActivatedRoute, readonly catalog: MetaFlowCatalogService) {}

  get selectedProfile(): MetaFlowProfile | undefined {
    return this.profiles.find((profile) => profile.authVariant === this.selectedAuthVariant);
  }

  get canContinue(): boolean {
    // The onboarding action has no handler in M5.01; server configuration alone must never imply that it can start.
    return false;
  }

  ngOnInit(): void {
    this.route.paramMap.pipe(takeUntil(this.destroy$)).subscribe((params) => {
      this.flow = FLOW_BY_SLUG[params.get('flow') ?? ''] ?? null;
      if (!this.flow) {
        this.isLoading = false;
        this.errorMessage = 'Este fluxo não está disponível.';
        return;
      }
      const copy = FLOW_COPY[this.flow];
      this.title = copy.title;
      this.description = copy.description;
      void this.loadProfiles();
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private async loadProfiles(): Promise<void> {
    if (!this.flow) return;
    this.isLoading = true;
    this.errorMessage = '';
    this.errorRequestId = null;
    try {
      const response = await this.catalog.load();
      this.profiles = Object.freeze(response.profiles.filter((profile) => profile.flowVariant === this.flow));
      const requestedAuthVariant = this.route.snapshot.queryParamMap.get('authVariant');
      const requested = this.profiles.find((profile) => profile.authVariant === requestedAuthVariant);
      const enabled = this.profiles.filter((profile) => profile.enabled);
      this.selectedAuthVariant = requested?.authVariant ?? (enabled.length === 1 ? enabled[0].authVariant : '');
    } catch (error: unknown) {
      this.errorMessage = 'Não foi possível confirmar a disponibilidade deste fluxo. Atualize a página para tentar novamente.';
      this.errorRequestId = safeRequestId(error);
    } finally {
      this.isLoading = false;
    }
  }
}
