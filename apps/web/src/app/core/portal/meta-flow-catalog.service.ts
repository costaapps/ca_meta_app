import { HttpClient } from '@angular/common/http';
import { Inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { META_API_BASE_URL } from '../config/public-runtime-config';
import { normalizeApiV1BaseUrl } from './portal-session.service';

export type MetaFlowVariant = 'FACEBOOK' | 'INSTAGRAM' | 'WHATSAPP_EXCLUSIVE' | 'WHATSAPP_COEXISTENCE';
export type MetaAuthVariant = 'FACEBOOK_LOGIN_FOR_BUSINESS' | 'INSTAGRAM_VIA_FACEBOOK_LOGIN' | 'INSTAGRAM_LOGIN' |
  'WHATSAPP_EMBEDDED_SIGNUP' | 'WHATSAPP_BUSINESS_APP_ONBOARDING';

export interface MetaFlowProfile {
  readonly flowVariant: MetaFlowVariant;
  readonly authVariant: MetaAuthVariant;
  readonly enabled: boolean;
  readonly reasonCode: string | null;
  readonly capabilities: readonly { readonly operation: string; readonly enabled: boolean; readonly reasonCode: string | null }[];
}

export interface MetaFlowCatalog {
  readonly requestId: string;
  readonly manifestVersion: string;
  readonly profiles: readonly MetaFlowProfile[];
}

export interface MetaFlowCard {
  readonly id: MetaFlowVariant;
  readonly title: string;
  readonly summary: string;
  readonly profiles: readonly MetaFlowProfile[];
  readonly enabled: boolean;
  readonly reason: string;
}

const FLOW_CARDS: readonly Pick<MetaFlowCard, 'id' | 'title' | 'summary'>[] = Object.freeze([
  { id: 'WHATSAPP_EXCLUSIVE', title: 'WhatsApp API', summary: 'Conecte um número dedicado à operação do Msg4.' },
  { id: 'WHATSAPP_COEXISTENCE', title: 'WhatsApp + aplicativo', summary: 'Mantenha o número no WhatsApp Business e conecte-o ao Msg4.' },
  { id: 'INSTAGRAM', title: 'Instagram', summary: 'Conecte uma conta profissional do Instagram.' },
  { id: 'FACEBOOK', title: 'Facebook', summary: 'Conecte uma página do Facebook.' },
]);

const REASON_COPY: Readonly<Record<string, string>> = Object.freeze({
  CONFIGURATION_MISSING: 'Indisponível neste ambiente.',
  ADAPTER_UNAVAILABLE: 'A configuração está pronta, mas a integração ainda não está ativa.',
  UNKNOWN: 'A disponibilidade ainda não foi confirmada.',
  EVIDENCE_MISSING: 'A disponibilidade ainda não foi confirmada.',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

const FLOW_VARIANTS = new Set<string>(['FACEBOOK', 'INSTAGRAM', 'WHATSAPP_EXCLUSIVE', 'WHATSAPP_COEXISTENCE']);
const AUTH_VARIANTS = new Set<string>([
  'FACEBOOK_LOGIN_FOR_BUSINESS', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN',
  'WHATSAPP_EMBEDDED_SIGNUP', 'WHATSAPP_BUSINESS_APP_ONBOARDING',
]);

export function parseMetaFlowCatalog(value: unknown): MetaFlowCatalog | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['requestId', 'manifestVersion', 'profiles']) ||
      typeof value['requestId'] !== 'string' || typeof value['manifestVersion'] !== 'string' ||
      !Array.isArray(value['profiles'])) return null;
  const profiles: MetaFlowProfile[] = [];
  for (const profile of value['profiles']) {
    if (!isRecord(profile) || !hasOnlyKeys(profile, ['flowVariant', 'authVariant', 'enabled', 'reasonCode', 'capabilities']) ||
        typeof profile['flowVariant'] !== 'string' || !FLOW_VARIANTS.has(profile['flowVariant']) ||
        typeof profile['authVariant'] !== 'string' || !AUTH_VARIANTS.has(profile['authVariant']) ||
        typeof profile['enabled'] !== 'boolean' ||
        !(profile['reasonCode'] === null || typeof profile['reasonCode'] === 'string') ||
        !Array.isArray(profile['capabilities'])) return null;
    const capabilities: MetaFlowProfile['capabilities'][number][] = [];
    for (const capability of profile['capabilities']) {
      if (!isRecord(capability) || !hasOnlyKeys(capability, ['operation', 'enabled', 'reasonCode']) ||
          typeof capability['operation'] !== 'string' || typeof capability['enabled'] !== 'boolean' ||
          !(capability['reasonCode'] === null || typeof capability['reasonCode'] === 'string')) return null;
      capabilities.push(Object.freeze({
        operation: capability['operation'], enabled: capability['enabled'], reasonCode: capability['reasonCode'],
      }));
    }
    profiles.push(Object.freeze({
      flowVariant: profile['flowVariant'] as MetaFlowVariant,
      authVariant: profile['authVariant'] as MetaAuthVariant,
      enabled: profile['enabled'],
      reasonCode: profile['reasonCode'],
      capabilities: Object.freeze(capabilities),
    }));
  }
  return Object.freeze({
    requestId: value['requestId'],
    manifestVersion: value['manifestVersion'],
    profiles: Object.freeze(profiles),
  });
}

@Injectable({ providedIn: 'root' })
export class MetaFlowCatalogService {
  private readonly baseUrl: string;

  constructor(private readonly http: HttpClient, @Inject(META_API_BASE_URL) baseUrl: string) {
    this.baseUrl = normalizeApiV1BaseUrl(baseUrl);
  }

  async load(): Promise<MetaFlowCatalog> {
    const value: unknown = await firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/meta/bootstrap`));
    const catalog = parseMetaFlowCatalog(value);
    if (!catalog) throw new Error('O servidor retornou uma configuração de fluxos inválida.');
    return catalog;
  }

  cards(catalog: MetaFlowCatalog): readonly MetaFlowCard[] {
    return Object.freeze(FLOW_CARDS.map((definition) => {
      const profiles = catalog.profiles.filter((profile) => profile.flowVariant === definition.id);
      const enabled = profiles.some((profile) => profile.enabled);
      const reasonCode = profiles.find((profile) => !profile.enabled && profile.reasonCode)?.reasonCode ?? null;
      return Object.freeze({
        ...definition,
        profiles: Object.freeze(profiles),
        enabled,
        reason: enabled ? 'Configuração disponível. A conexão só será confirmada após a verificação dos recursos.' :
          (reasonCode && REASON_COPY[reasonCode]) || 'Indisponível neste ambiente.',
      });
    }));
  }

  reasonFor(profile: MetaFlowProfile): string {
    return profile.enabled ? 'Configuração disponível. A autorização e os recursos serão verificados pelo servidor.' :
      (profile.reasonCode && REASON_COPY[profile.reasonCode]) || 'Indisponível neste ambiente.';
  }
}
