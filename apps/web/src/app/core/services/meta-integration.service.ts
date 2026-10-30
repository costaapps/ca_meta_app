import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ConnectedChannel, WhatsAppTemplate, WhatsAppTemplateCreateRequest } from '../models/channel.model';

@Injectable({ providedIn: 'root' })
export class MetaIntegrationService {
  private readonly backEndUrl = environment.backEndUrl;
  private companyUUID: string;

  constructor(private http: HttpClient) {
    this.companyUUID = localStorage.getItem('cUUID') || '';
  }

  getCompanyUUID(): string {
    return this.companyUUID;
  }

  getConnectedChannels(): Observable<ConnectedChannel[]> {
    const params = new URLSearchParams({ company_uuid: this.companyUUID });
    return this.http.get<ConnectedChannel[]>(`${this.backEndUrl}/channels?${params.toString()}`);
  }

  setCompanyUUID(uuid: string): void {
    this.companyUUID = uuid;
    localStorage.setItem('cUUID', uuid);
  }

  saveAutoReply(channel: ConnectedChannel): Observable<any> {
    const payload = {
      CompanyUUID: this.companyUUID,
      ExternalId: channel.externalId,
      Type: channel.type.toUpperCase(),
      PrivateWelcomeMessage: channel.privateWelcomeMessage || '',
      CommentPublicReply: channel.commentPublicReply || '',
      CommentPrivateReply: channel.commentPrivateReply || ''
    };

    return this.http.post<any>(`${this.backEndUrl}/save_auto_reply`, payload);
  }

  getWhatsAppTemplates(phoneNumberId: string): Observable<WhatsAppTemplate[]> {
    const params = new URLSearchParams({
      company_uuid: this.companyUUID,
      phone_number_id: phoneNumberId
    });

    return this.http
      .get<{ data: WhatsAppTemplate[] }>(`${this.backEndUrl}/whatsapp/templates?${params.toString()}`)
      .pipe(map((response) => response.data || []));
  }

  createWhatsAppTemplate(request: WhatsAppTemplateCreateRequest): Observable<any> {
    const payload = {
      company_uuid: this.companyUUID,
      phone_number_id: request.phoneNumberId,
      name: request.name,
      category: request.category,
      body: request.body,
      language: request.language || 'en',
      example_values: request.exampleValues || []
    };

    return this.http.post<any>(`${this.backEndUrl}/whatsapp/templates`, payload);
  }
}
