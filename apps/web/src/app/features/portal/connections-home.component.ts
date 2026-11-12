import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MetaFlowCard, MetaFlowCatalogService } from '../../core/portal/meta-flow-catalog.service';
import { safeRequestId } from '../../core/portal/safe-api-error';

@Component({
  selector: 'app-connections-home',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './connections-home.component.html',
  styleUrl: './connections-home.component.scss',
})
export class ConnectionsHomeComponent implements OnInit {
  cards: readonly MetaFlowCard[] = [];
  isLoading = true;
  errorMessage = '';
  errorRequestId: string | null = null;

  constructor(private readonly catalogService: MetaFlowCatalogService) {}

  ngOnInit(): void {
    void this.loadCatalog();
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

  private async loadCatalog(): Promise<void> {
    this.isLoading = true;
    this.errorMessage = '';
    this.errorRequestId = null;
    try {
      const response = await this.catalogService.load();
      this.cards = this.catalogService.cards(response);
    } catch (error: unknown) {
      this.errorMessage = 'Não foi possível consultar a disponibilidade das conexões. Tente atualizar a página.';
      this.errorRequestId = safeRequestId(error);
    } finally {
      this.isLoading = false;
    }
  }
}
