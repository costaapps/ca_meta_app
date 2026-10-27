import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { MetaAuthService } from '../../../../core/services/meta-auth.service';
import { MetaFlowState, MetaProductType, MetaSetupFlowConfig } from '../../../../core/models/meta-auth.model';

type FlowStateMap = Record<MetaProductType, MetaFlowState>;

@Component({
  selector: 'app-channel-setup',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './channel-setup.component.html',
  styleUrls: ['./channel-setup.component.scss']
})
export class ChannelSetupComponent implements OnInit, OnDestroy {
  readonly flows: MetaSetupFlowConfig[];
  readonly trackFlow = (_: number, flow: MetaSetupFlowConfig): MetaProductType => flow.product;

  flowStates: FlowStateMap = {
    WHATSAPP: { isConnecting: false, successMessage: null, errorMessage: null },
    FACEBOOK: { isConnecting: false, successMessage: null, errorMessage: null },
    INSTAGRAM: { isConnecting: false, successMessage: null, errorMessage: null }
  };

  private destroy$ = new Subject<void>();

  constructor(
    private metaAuthService: MetaAuthService,
    private route: ActivatedRoute,
    private router: Router
  ) {
    this.flows = this.metaAuthService.getSetupFlows();
  }

  ngOnInit(): void {
    this.route.queryParams.pipe(takeUntil(this.destroy$)).subscribe((params) => {
      this.syncTenant(params['cUUID']);
      this.applyCallbackState(params);
    });
  }

  connect(product: MetaProductType): void {
    this.resetState(product);
    const companyUUID = this.metaAuthService.getCompanyUUID();

    if (!companyUUID) {
      this.flowStates[product].errorMessage =
        'Não foi possível identificar a empresa para iniciar a conexão.';
      return;
    }

    this.flowStates[product].isConnecting = true;
    this.metaAuthService.storePendingProduct(product);
    window.location.href = this.metaAuthService.buildConnectionUrl(product);
  }

  getState(product: MetaProductType): MetaFlowState {
    return this.flowStates[product];
  }

  getFlow(product: MetaProductType): MetaSetupFlowConfig {
    return this.metaAuthService.getFlow(product);
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private syncTenant(companyUUID: string | undefined): void {
    if (companyUUID) {
      localStorage.setItem('cUUID', companyUUID);
    }
  }

  private applyCallbackState(params: Record<string, string | undefined>): void {
    const authSuccess = params['auth_success'] === 'true';
    const error = params['error'];

    if (!authSuccess && !error) {
      return;
    }

    const product = this.getRouteProduct() || this.metaAuthService.readPendingProduct();

    if (!product) {
      return;
    }

    const flow = this.metaAuthService.getFlow(product);
    this.resetState(product);

    if (authSuccess) {
      this.flowStates[product].successMessage = `${flow.badgeLabel} conectado com sucesso.`;
      this.metaAuthService.clearPendingProduct();
      window.setTimeout(() => {
        this.router.navigate(['/channels']);
      }, 2500);
      return;
    }

    this.flowStates[product].errorMessage = error
      ? `Erro ao conectar ${flow.badgeLabel}: ${error}`
      : `Erro ao conectar ${flow.badgeLabel}.`;
  }

  private getRouteProduct(): MetaProductType | null {
    const product = String(this.route.snapshot.data['metaProduct'] || '').toUpperCase();
    if (product === 'WHATSAPP' || product === 'FACEBOOK' || product === 'INSTAGRAM') {
      return product;
    }

    return null;
  }

  private resetState(product: MetaProductType): void {
    this.flowStates[product] = {
      isConnecting: false,
      successMessage: null,
      errorMessage: null
    };
  }
}
