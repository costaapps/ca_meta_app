import { Injectable } from '@angular/core';
import { environment } from '../../../environments/environment';
import {
  MetaProductType,
  MetaSetupFlowConfig
} from '../models/meta-auth.model';

const META_SETUP_FLOWS: MetaSetupFlowConfig[] = [
  {
    product: 'WHATSAPP',
    title: 'WhatsApp',
    summary: 'Conecte o WhatsApp Business ao Msg4 para transformar conversas em processos.',
    description:
      'O Msg4 organiza atendimentos, vendas, consultas e aprovações pelo canal que seus clientes já usam. Com o Agent4, a operação também pode ganhar respostas inteligentes e apoio em linguagem natural.',
    ctaLabel: 'Conectar WhatsApp',
    backendPath: '/connect_whatsapp.php',
    callbackPath: '/setup/whatsapp/callback',
    accentClass: 'whatsapp',
    badgeLabel: 'WhatsApp',
    highlights: [
      'Atendimento e vendas em fluxos rastreáveis',
      'Integração com sistemas de gestão e dados do negócio',
      'Base para automações e agentes inteligentes'
    ]
  },
  {
    product: 'FACEBOOK',
    title: 'Facebook',
    summary: 'Conecte páginas do Facebook à operação conversacional do Msg4.',
    description:
      'Centralize interações da página, direcione atendimentos e mantenha a comunicação conectada aos processos comerciais e operacionais da empresa.',
    ctaLabel: 'Conectar Facebook',
    backendPath: '/connect_facebook.php',
    callbackPath: '/setup/facebook/callback',
    accentClass: 'facebook',
    badgeLabel: 'Facebook',
    highlights: [
      'Gestão de conversas vindas das páginas',
      'Padronização de atendimento pelo Msg4',
      'Conexão com dados e regras do negócio'
    ]
  },
  {
    product: 'INSTAGRAM',
    title: 'Instagram',
    summary: 'Conecte o Instagram ao Msg4 para organizar relacionamento e atendimento.',
    description:
      'Leve mensagens e interações do Instagram para fluxos operacionais, com histórico, contexto e possibilidade de apoio inteligente pelo Agent4.',
    ctaLabel: 'Conectar Instagram',
    backendPath: '/connect_instagram.php',
    callbackPath: '/setup/instagram/callback',
    accentClass: 'instagram',
    badgeLabel: 'Instagram',
    highlights: [
      'Atendimento social conectado à operação',
      'Histórico e contexto para cada interação',
      'Apoio a automações comerciais e de suporte'
    ]
  }
];

@Injectable({ providedIn: 'root' })
export class MetaAuthService {
  private readonly backEndUrl = environment.backEndUrl;
  private readonly pendingProductStorageKey = 'meta.pendingProduct';

  getCompanyUUID(): string {
    return localStorage.getItem('cUUID') || '';
  }

  getSetupFlows(): MetaSetupFlowConfig[] {
    return META_SETUP_FLOWS.map((flow) => ({ ...flow, highlights: [...flow.highlights] }));
  }

  getFlow(product: MetaProductType): MetaSetupFlowConfig {
    const flow = META_SETUP_FLOWS.find((item) => item.product === product);
    if (!flow) {
      throw new Error(`Unknown Meta product: ${product}`);
    }
    return flow;
  }

  buildConnectionUrl(product: MetaProductType): string {
    const companyUUID = localStorage.getItem('cUUID') || '';
    const flow = this.getFlow(product);
    const params = new URLSearchParams({
      company_uuid: companyUUID
    });

    return `${this.backEndUrl}${flow.backendPath}?${params.toString()}`;
  }

  storePendingProduct(product: MetaProductType): void {
    sessionStorage.setItem(this.pendingProductStorageKey, product);
  }

  readPendingProduct(): MetaProductType | null {
    const value = sessionStorage.getItem(this.pendingProductStorageKey);
    if (value === 'WHATSAPP' || value === 'FACEBOOK' || value === 'INSTAGRAM') {
      return value;
    }
    return null;
  }

  clearPendingProduct(): void {
    sessionStorage.removeItem(this.pendingProductStorageKey);
  }

}
