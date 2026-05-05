/**
 * Modelo de Dados para Integração Meta (Facebook/Instagram)
 */

export interface InstagramAccount {
  id: string;
  username?: string;
  profile_picture_url?: string;
}

export interface FacebookPage {
  id: string; // Page ID
  name: string;
  access_token?: string; // Opcional no front
  picture?: string; // URL da foto da página (opcional)
  instagram_business_account?: InstagramAccount | null; // Se null, não serve pro nosso caso
  is_connected: boolean; // Flag visual: Já está salvo no nosso banco?
  welcomeMessage?: string; // Welcome message for automation
}

export interface ChannelSetupResponse {
  pages: FacebookPage[]; // Lista de páginas trazidas da API do Facebook via Backend
}

export interface AuthResponse {
  success: boolean;
  message?: string;
  token?: string;
}

export interface WhatsAppTemplate {
  name: string;
  status?: string;
  category?: string;
  language?: string;
  components?: WhatsAppTemplateComponent[];
}

export interface WhatsAppTemplateComponent {
  type?: string;
  text?: string;
  format?: string;
}

export interface WhatsAppTemplateCreateRequest {
  phoneNumberId: string;
  name: string;
  category: string;
  body: string;
  language?: string;
  exampleValues?: string[];
}
