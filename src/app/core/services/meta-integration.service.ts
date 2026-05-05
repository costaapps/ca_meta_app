import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { WhatsAppTemplate, WhatsAppTemplateCreateRequest } from '../models/channel.model';

export interface ConnectedChannel {
  id: number;
  type: 'FACEBOOK' | 'INSTAGRAM' | 'WHATSAPP';
  externalId: string;    // Antigo pageId ou accountId
  name: string;          // Antigo pageName ou username
  profilePicture: string;
  privateWelcomeMessage?: string;
  commentPublicReply?: string; // Novo
  commentPrivateReply?: string; // Novo
  connectedAt: string;
}


@Injectable({ providedIn: 'root' })
export class MetaIntegrationService {
  private backEndUrl = `${environment.backEndUrl}`;
  private companyUUID: string;

  constructor(private http: HttpClient) {
    // Obter CompanyUUID do localStorage ou passar como parâmetro
    this.companyUUID = localStorage.getItem('cUUID') || '';
  }

  /**
   * Redireciona o usuário para o fluxo de login do Facebook
   */
  redirectToFacebookLogin(): void {
    const params = new URLSearchParams({ company_uuid: this.companyUUID });
    
    this.http.get<{ loginUrl: string }>(
      `${this.backEndUrl}/login-url?${params.toString()}`
    ).subscribe({
      next: (response) => {
        window.location.href = response.loginUrl;
      },
      error: (err) => {
        console.error('Erro ao obter URL de login:', err);
        alert('Erro ao iniciar integração com Facebook. Tente novamente.');
      }
    });
  }

  /**
   * Busca os canais já conectados
   */
  getConnectedChannels(): Observable<ConnectedChannel[]> {
    const params = new URLSearchParams({ company_uuid: this.companyUUID });
    return this.http.get<ConnectedChannel[]>(
      `${this.backEndUrl}/channels?${params.toString()}`
    );
  }

  /**
   * Define o CompanyUUID (útil para aplicações multi-tenant)
   */
  setCompanyUUID(uuid: string): void {
    this.companyUUID = uuid;
    localStorage.setItem('cUUID', uuid);
  }

  /**
   * Saves automatic reply configuration for a connected channel
   * @param channel ConnectedChannel object with configuration
   * @returns Observable of the save response
   */
  saveAutoReply(channel: ConnectedChannel): Observable<any> {
    const payload = {
      CompanyUUID: this.companyUUID,
      ExternalId: channel.externalId,
      Type: channel.type.toUpperCase(),
      PrivateWelcomeMessage: channel.privateWelcomeMessage || '',
      CommentPublicReply: channel.commentPublicReply || '',
      CommentPrivateReply: channel.commentPrivateReply || ''
    };
    return this.http.post<any>(
      `${this.backEndUrl}/save_auto_reply`,
      payload
    );
  }

  /**
   * Fetch WhatsApp templates for a phone number
   */
  getWhatsAppTemplates(phoneNumberId: string): Observable<WhatsAppTemplate[]> {
    const params = new URLSearchParams({
      company_uuid: this.companyUUID,
      phone_number_id: phoneNumberId
    });

    return this.http
      .get<{ data: WhatsAppTemplate[] }>(`${this.backEndUrl}/whatsapp/templates?${params.toString()}`)
      .pipe(map((response) => response.data || []));
  }

  /**
   * Create a new WhatsApp template
   */
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
