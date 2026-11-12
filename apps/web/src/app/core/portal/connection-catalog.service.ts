import { HttpClient, HttpParams } from '@angular/common/http';
import { Inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { components } from '@ca-meta/contracts';
import { META_API_BASE_URL } from '../config/public-runtime-config';
import { normalizeApiV1BaseUrl } from './portal-session.service';

export type ConnectionRecord = components['schemas']['Connection'];
export type ConnectionRecordDetail = components['schemas']['ConnectionDetail'];
export type ConnectionListPage = components['schemas']['ConnectionListPage'];
export type ConnectionFlowVariant = components['schemas']['FlowVariant'];
export type ConnectionChannel = 'FACEBOOK' | 'INSTAGRAM' | 'WHATSAPP';
export type ConnectionStatus = ConnectionRecord['status'];
export type ConnectionStatusFilter = ConnectionStatus | 'STALE';
export type ConnectionJobStatus = components['schemas']['JobStatus'];

export interface ConnectionCatalogFilters {
  readonly channel?: ConnectionChannel;
  readonly flowVariant?: ConnectionFlowVariant;
  readonly number?: string;
  readonly status?: ConnectionStatusFilter;
}

@Injectable({ providedIn: 'root' })
export class ConnectionCatalogService {
  private readonly baseUrl: string;
  readonly pageSize = 25;

  constructor(private readonly http: HttpClient, @Inject(META_API_BASE_URL) baseUrl: string) {
    this.baseUrl = normalizeApiV1BaseUrl(baseUrl);
  }

  list(filters: ConnectionCatalogFilters = {}, cursor?: string): Promise<ConnectionListPage> {
    let params = new HttpParams().set('limit', String(this.pageSize));
    if (cursor) params = params.set('cursor', cursor);
    if (filters.channel) params = params.set('channel', filters.channel);
    if (filters.flowVariant) params = params.set('flowVariant', filters.flowVariant);
    if (filters.number) params = params.set('number', filters.number);
    if (filters.status) params = params.set('status', filters.status);
    return firstValueFrom(this.http.get<ConnectionListPage>(`${this.baseUrl}/connections`, { params }));
  }

  detail(connectionId: string): Promise<ConnectionRecordDetail> {
    return firstValueFrom(this.http.get<ConnectionRecordDetail>(
      `${this.baseUrl}/connections/${encodeURIComponent(connectionId)}`,
    ));
  }

  /** Starts a tenant-scoped refresh using the server-owned internal asset reference. */
  refresh(assetId: string): Promise<components['schemas']['JobAccepted']> {
    return firstValueFrom(this.http.post<components['schemas']['JobAccepted']>(
      `${this.baseUrl}/assets/${encodeURIComponent(assetId)}/refresh`, null,
    ));
  }

  /** Reads only the opaque server-issued job reference; callers own a bounded polling policy. */
  job(jobId: string): Promise<ConnectionJobStatus> {
    return firstValueFrom(this.http.get<ConnectionJobStatus>(
      `${this.baseUrl}/jobs/${encodeURIComponent(jobId)}`,
    ));
  }
}

const FLOW_LABELS: Readonly<Record<ConnectionFlowVariant, string>> = Object.freeze({
  FACEBOOK_LOGIN: 'Facebook · Login',
  INSTAGRAM_VIA_FACEBOOK_LOGIN: 'Instagram · Login do Facebook',
  INSTAGRAM_LOGIN: 'Instagram · Login do Instagram',
  WHATSAPP_CLOUD_API: 'WhatsApp · API exclusiva',
  WHATSAPP_COEXISTENCE: 'WhatsApp · coexistência',
});

export function connectionFlowLabel(flowVariant: ConnectionFlowVariant): string {
  return FLOW_LABELS[flowVariant];
}

export function connectionStatusCopy(connection: Pick<ConnectionRecord, 'status' | 'readiness' | 'observedAt' | 'stale'> & Partial<Pick<ConnectionRecord, 'assetCount'>>): string {
  if (connection.stale) {
    return `Última confirmação em ${connection.observedAt}; o status pode ter mudado.`;
  }
  if (connection.status === 'ACTIVE' && connection.readiness === 'READY') {
    return `Conectado · status confirmado em ${connection.observedAt}.`;
  }
  if (connection.status === 'PARTIAL' || connection.readiness === 'PARTIAL') {
    const count = connection.assetCount === undefined ? 'quantidade de recursos não confirmada' : `${connection.assetCount} recurso(s)`;
    return `Conexão parcial · ${count} · confirmado em ${connection.observedAt}.`;
  }
  if (connection.status === 'REAUTH_REQUIRED') return 'A autorização precisa ser atualizada.';
  if (connection.status === 'DISCONNECTED') return `O servidor confirma uma conexão desconectada em ${connection.observedAt}.`;
  return 'Ainda não foi possível confirmar o status desta conexão.';
}

export function assetKindLabel(kind: components['schemas']['ConnectionAsset']['kind']): string {
  switch (kind) {
    case 'PAGE': return 'Página do Facebook';
    case 'INSTAGRAM_ACCOUNT': return 'Conta profissional do Instagram';
    case 'WHATSAPP_BUSINESS_ACCOUNT': return 'Conta do WhatsApp Business';
    case 'PHONE_NUMBER': return 'Número do WhatsApp';
  }
}

export function assetStatusCopy(asset: Pick<components['schemas']['ConnectionAsset'], 'status' | 'authorizationStatus' | 'stale'>): string {
  if (asset.stale || asset.status === 'STALE') return 'Última confirmação desatualizada; isso não confirma perda do recurso.';
  if (asset.authorizationStatus === 'REVOKED') return 'Este recurso está sem autorização válida.';
  if (asset.status === 'UNKNOWN' || asset.authorizationStatus === 'UNKNOWN') return 'O status deste recurso ainda não foi confirmado.';
  if (asset.status === 'INACTIVE') return 'Este recurso está inativo segundo a última confirmação.';
  return 'Recurso ativo · autorização confirmada.';
}

export function authorizationStatusCopy(status: components['schemas']['ConnectionAsset']['authorizationStatus']): string {
  if (status === 'VERIFIED') return 'Autorização confirmada.';
  if (status === 'REVOKED') return 'Autorização revogada.';
  return 'Autorização ainda não confirmada.';
}

export function credentialHealthCopy(status: components['schemas']['AssetDiagnostics']['tokenHealth']): string {
  switch (status) {
    case 'HEALTHY': return 'Credencial confirmada como ativa.';
    case 'EXPIRING': return 'A credencial pode expirar em breve.';
    case 'EXPIRED': return 'A credencial expirou.';
    case 'REVOKED': return 'A credencial foi revogada.';
    case 'ACTION_REQUIRED': return 'A autorização precisa de uma ação para continuar.';
    case 'STALE': return 'A confirmação da credencial está desatualizada.';
    case 'UNKNOWN': return 'A saúde da credencial ainda não foi confirmada.';
  }
}

export function subscriptionStatusCopy(status: components['schemas']['AssetDiagnostics']['subscriptionState']): string {
  switch (status) {
    case 'ACTIVE': return 'Eventos configurados · confirmação disponível.';
    case 'PENDING': return 'Configuração de eventos pendente.';
    case 'FAILED': return 'A configuração de eventos falhou segundo a última confirmação.';
    case 'REMOVED': return 'Configuração de eventos removida segundo a última confirmação.';
    case 'UNKNOWN': return 'Status da configuração de eventos não disponível.';
  }
}

export function projectionStatusCopy(status: components['schemas']['AssetDiagnostics']['projectionState']): string {
  switch (status) {
    case 'SYNCED': return 'Sincronização empresarial confirmada.';
    case 'PENDING': return 'Sincronização empresarial pendente.';
    case 'STALE': return 'A sincronização empresarial está desatualizada.';
    case 'FAILED': return 'A sincronização empresarial falhou segundo a última confirmação.';
    case 'UNKNOWN': return 'Status da sincronização empresarial não disponível.';
  }
}

export function observationTimeCopy(asset: components['schemas']['ConnectionAsset']): string {
  const observation = asset.statusObservation;
  if (observation?.observedAt) return `${observation.observedAt} · ${observation.source} · buscar em ${observation.fetchedAt} · desatualiza após ${observation.staleAfter}`;
  if (asset.lastVerifiedAt) return `${asset.lastVerifiedAt} · ${asset.verificationSource ?? 'fonte não informada'}`;
  return 'Sem confirmação registrada.';
}
