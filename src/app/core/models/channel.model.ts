/**
 * Shared channel and template models for Meta integrations.
 */

export interface ConnectedChannel {
  id: number;
  type: 'FACEBOOK' | 'INSTAGRAM' | 'WHATSAPP';
  externalId: string;
  name: string;
  profilePicture: string;
  privateWelcomeMessage?: string;
  commentPublicReply?: string;
  commentPrivateReply?: string;
  connectedAt: string;
}

export interface InstagramAccount {
  id: string;
  username?: string;
  profile_picture_url?: string;
}

export interface FacebookPage {
  id: string;
  name: string;
  access_token?: string;
  picture?: string;
  instagram_business_account?: InstagramAccount | null;
  is_connected: boolean;
  welcomeMessage?: string;
}

export interface ChannelSetupResponse {
  pages: FacebookPage[];
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
