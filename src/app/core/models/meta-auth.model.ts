export type MetaProductType = 'WHATSAPP' | 'FACEBOOK' | 'INSTAGRAM';

export interface MetaSetupFlowConfig {
  product: MetaProductType;
  title: string;
  summary: string;
  description: string;
  ctaLabel: string;
  backendPath: string;
  callbackPath: string;
  accentClass: string;
  badgeLabel: string;
  highlights: string[];
}

export interface MetaFlowState {
  isConnecting: boolean;
  successMessage: string | null;
  errorMessage: string | null;
}

export interface MetaAuthCallbackData {
  auth_success?: string;
  error?: string;
  product?: string;
  flow?: string;
  channel?: string;
  cUUID?: string;
}
