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
  CONFIGURATION_MISSING: 'A configuração Meta deste fluxo ainda não foi instalada. Peça à equipe responsável para configurar o aplicativo.',
  CONFIGURATION_DISABLED: 'A configuração Meta deste fluxo está desativada. Peça à equipe responsável para verificar a configuração.',
  VERSION_EVIDENCE_REQUIRED: 'As versões necessárias do SDK ou do Embedded Signup ainda não foram confirmadas.',
  PERMISSION_MAPPING_NOT_CONFIRMED: 'O mapeamento das permissões necessárias ainda não foi confirmado.',
  CAPABILITY_EVIDENCE_MISSING: 'A evidência de uma ou mais capacidades necessárias ainda não foi confirmada.',
  ACCESS_LEVEL_NOT_CONFIRMED: 'O nível de acesso necessário para este fluxo ainda não foi confirmado.',
  APP_REVIEW_NOT_CONFIRMED: 'A revisão necessária do aplicativo Meta ainda não foi confirmada.',
  SANDBOX_NOT_CONFIRMED: 'A validação necessária em ambiente de teste ainda não foi confirmada.',
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
const BOOTSTRAP_REASONS = new Set<string>([
  'CONFIGURATION_MISSING', 'CONFIGURATION_DISABLED', 'VERSION_EVIDENCE_REQUIRED',
  'PERMISSION_MAPPING_NOT_CONFIRMED', 'CAPABILITY_EVIDENCE_MISSING', 'ACCESS_LEVEL_NOT_CONFIRMED',
  'APP_REVIEW_NOT_CONFIRMED', 'SANDBOX_NOT_CONFIRMED',
]);
const CAPABILITY_OPERATIONS = new Set<string>([
  'ASSET_DISCOVERY', 'SEND_MESSAGE', 'MANAGE_COMMENTS', 'MANAGE_TEMPLATES', 'READ_STATUS',
  'SUBSCRIBE_WEBHOOKS', 'SYNC_HISTORY', 'PHONE_REGISTRATION_CONVENTIONAL',
]);
const PROFILE_KEYS = [
  'flowVariant', 'authVariant', 'enabled', 'reasonCode', 'capabilities', 'providerAppId',
  'publicConfigId', 'appDomain', 'javascriptSdkVersion', 'embeddedSignupVersion',
];
const VERSION_PATTERN = /^v[0-9]{1,2}\.[0-9]{1,3}$/;

function parseReasonCode(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && BOOTSTRAP_REASONS.has(value) ? value : undefined;
}

function validOptionalPublicFields(profile: Record<string, unknown>, enabled: boolean): boolean {
  const publicFields = [
    'providerAppId', 'publicConfigId', 'appDomain', 'javascriptSdkVersion', 'embeddedSignupVersion',
  ] as const;
  if (!enabled && publicFields.some((field) => profile[field] !== undefined)) return false;

  const providerAppId = profile['providerAppId'];
  const publicConfigId = profile['publicConfigId'];
  const appDomain = profile['appDomain'];
  const javascriptSdkVersion = profile['javascriptSdkVersion'];
  const embeddedSignupVersion = profile['embeddedSignupVersion'];
  return (providerAppId === undefined || (typeof providerAppId === 'string' && /^[0-9]{1,32}$/.test(providerAppId))) &&
    (publicConfigId === undefined || (typeof publicConfigId === 'string' && publicConfigId.length >= 1 && publicConfigId.length <= 96)) &&
    (appDomain === undefined || (typeof appDomain === 'string' && appDomain.length >= 1 && appDomain.length <= 253)) &&
    (javascriptSdkVersion === undefined || (typeof javascriptSdkVersion === 'string' && VERSION_PATTERN.test(javascriptSdkVersion))) &&
    (embeddedSignupVersion === undefined || (typeof embeddedSignupVersion === 'string' && VERSION_PATTERN.test(embeddedSignupVersion)));
}

export function parseMetaFlowCatalog(value: unknown): MetaFlowCatalog | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['requestId', 'manifestVersion', 'profiles']) ||
      typeof value['requestId'] !== 'string' || value['requestId'].length < 1 || value['requestId'].length > 128 ||
      value['manifestVersion'] !== 'm4.04-2026-11-10.1' || !Array.isArray(value['profiles']) ||
      value['profiles'].length !== 5) return null;
  const profiles: MetaFlowProfile[] = [];
  for (const profile of value['profiles']) {
    const reasonCode = isRecord(profile) ? parseReasonCode(profile['reasonCode']) : undefined;
    if (!isRecord(profile) || !hasOnlyKeys(profile, PROFILE_KEYS) ||
        typeof profile['flowVariant'] !== 'string' || !FLOW_VARIANTS.has(profile['flowVariant']) ||
        typeof profile['authVariant'] !== 'string' || !AUTH_VARIANTS.has(profile['authVariant']) ||
        typeof profile['enabled'] !== 'boolean' ||
        reasonCode === undefined || !validOptionalPublicFields(profile, profile['enabled']) ||
        !Array.isArray(profile['capabilities']) || profile['capabilities'].length > 16) return null;
    const capabilities: MetaFlowProfile['capabilities'][number][] = [];
    for (const capability of profile['capabilities']) {
      const capabilityReason = isRecord(capability) ? parseReasonCode(capability['reasonCode']) : undefined;
      if (!isRecord(capability) || !hasOnlyKeys(capability, ['operation', 'enabled', 'reasonCode']) ||
          typeof capability['operation'] !== 'string' || !CAPABILITY_OPERATIONS.has(capability['operation']) ||
          typeof capability['enabled'] !== 'boolean' || capabilityReason === undefined) return null;
      capabilities.push(Object.freeze({
        operation: capability['operation'], enabled: capability['enabled'], reasonCode: capabilityReason,
      }));
    }
    profiles.push(Object.freeze({
      flowVariant: profile['flowVariant'] as MetaFlowVariant,
      authVariant: profile['authVariant'] as MetaAuthVariant,
      enabled: profile['enabled'],
      reasonCode,
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
