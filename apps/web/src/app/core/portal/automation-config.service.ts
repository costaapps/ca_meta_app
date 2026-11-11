import { HttpClient, HttpResponse } from '@angular/common/http';
import { Inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { components } from '@ca-meta/contracts';
import { META_API_BASE_URL } from '../config/public-runtime-config';
import { normalizeApiV1BaseUrl } from './portal-session.service';

export type AutomationConfig = components['schemas']['AutomationConfig'];
export type AutomationConfigUpdate = components['schemas']['AutomationConfigUpdate'];

export interface VersionedAutomationConfig {
  readonly config: AutomationConfig;
  readonly etag: string;
}

function validEtag(value: string | null, version: number): value is string {
  return value === `"automation-v${version}"`;
}

@Injectable({ providedIn: 'root' })
export class AutomationConfigService {
  private readonly baseUrl: string;

  constructor(private readonly http: HttpClient, @Inject(META_API_BASE_URL) baseUrl: string) {
    this.baseUrl = normalizeApiV1BaseUrl(baseUrl);
  }

  async read(assetId: string): Promise<VersionedAutomationConfig> {
    const response = await firstValueFrom(this.http.get<AutomationConfig>(
      `${this.baseUrl}/assets/${encodeURIComponent(assetId)}/automation-config`, { observe: 'response' },
    ));
    return this.versioned(response);
  }

  async update(assetId: string, update: AutomationConfigUpdate, etag: string): Promise<VersionedAutomationConfig> {
    const response = await firstValueFrom(this.http.patch<AutomationConfig>(
      `${this.baseUrl}/assets/${encodeURIComponent(assetId)}/automation-config`, update,
      { observe: 'response', headers: { 'If-Match': etag } },
    ));
    return this.versioned(response);
  }

  private versioned(response: HttpResponse<AutomationConfig>): VersionedAutomationConfig {
    const config = response.body;
    const etag = response.headers.get('ETag');
    if (!config || !validEtag(etag, config.version)) throw new Error('The automation config response is incomplete.');
    return Object.freeze({ config, etag });
  }
}
