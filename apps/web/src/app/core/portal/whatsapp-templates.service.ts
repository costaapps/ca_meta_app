import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { components } from '@ca-meta/contracts';
import { META_API_BASE_URL } from '../config/public-runtime-config';
import { normalizeApiV1BaseUrl } from './portal-session.service';

export type TemplateRecord = components['schemas']['Template'];
export type TemplateListPage = components['schemas']['TemplateListPage'];
export type TemplateCreateRequest = components['schemas']['TemplateCreateRequest'];
export type TemplateAsset = components['schemas']['AssetListItem'];
export type TemplateJobStatus = components['schemas']['JobStatus'];

@Injectable({ providedIn: 'root' })
export class WhatsAppTemplatesService {
  private readonly baseUrl: string;

  constructor(private readonly http: HttpClient, @Inject(META_API_BASE_URL) baseUrl: string) {
    this.baseUrl = normalizeApiV1BaseUrl(baseUrl);
  }

  async accounts(): Promise<readonly TemplateAsset[]> {
    const params = new HttpParams().set('channel', 'WHATSAPP').set('limit', '100');
    const page = await firstValueFrom(this.http.get<components['schemas']['AssetListPage']>(`${this.baseUrl}/assets`, { params }));
    return Object.freeze(page.items.filter((item) => item.kind === 'WHATSAPP_BUSINESS_ACCOUNT'));
  }

  list(assetId: string, cursor?: string): Promise<TemplateListPage> {
    let params = new HttpParams().set('limit', '50');
    if (cursor) params = params.set('cursor', cursor);
    return firstValueFrom(this.http.get<TemplateListPage>(
      `${this.baseUrl}/whatsapp/accounts/${encodeURIComponent(assetId)}/templates`, { params },
    ));
  }

  create(assetId: string, request: TemplateCreateRequest, idempotencyKey: string): Promise<components['schemas']['JobAccepted']> {
    if (!/^[A-Za-z0-9._~-]{16,128}$/.test(idempotencyKey)) throw new Error('A valid idempotency key is required.');
    return firstValueFrom(this.http.post<components['schemas']['JobAccepted']>(
      `${this.baseUrl}/whatsapp/accounts/${encodeURIComponent(assetId)}/templates`, request,
      { headers: new HttpHeaders({ 'Idempotency-Key': idempotencyKey }) },
    ));
  }

  job(jobId: string): Promise<TemplateJobStatus> {
    return firstValueFrom(this.http.get<TemplateJobStatus>(`${this.baseUrl}/jobs/${encodeURIComponent(jobId)}`));
  }
}
