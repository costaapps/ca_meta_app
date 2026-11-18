import type { components } from '@ca-meta/contracts';

export type AutomationConfigField = components['schemas']['AutomationConfigField'];
export type AutomationConfigAssetKind = components['schemas']['AutomationConfigAssetKind'];
export type AutomationConfigProjectionState = components['schemas']['AutomationConfigProjectionState'];

export interface AutomationConfigState {
  readonly privateWelcomeMessage: string | null;
  readonly commentPublicReply: string | null;
  readonly commentPrivateReply: string | null;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly projectionState: AutomationConfigProjectionState;
}

export interface AutomationConfigPatch {
  readonly version: number;
  readonly privateWelcomeMessage?: string;
  readonly commentPublicReply?: string;
  readonly commentPrivateReply?: string;
}

export interface AutomationConfigRepository {
  read(input: { readonly tenantId: string; readonly assetId: string }): Promise<AutomationConfigState>;
  update(input: {
    readonly tenantId: string;
    readonly assetId: string;
    readonly actorId: string;
    readonly requestId: string;
    readonly patch: AutomationConfigPatch;
  }): Promise<AutomationConfigState>;
}

export const AUTOMATION_CONFIG_FIELDS_BY_ASSET_KIND: Readonly<Record<AutomationConfigAssetKind, readonly AutomationConfigField[]>> = Object.freeze({
  WHATSAPP_PHONE_NUMBER: Object.freeze(['privateWelcomeMessage'] as const),
  FACEBOOK_PAGE: Object.freeze(['commentPublicReply', 'commentPrivateReply'] as const),
  INSTAGRAM_BUSINESS_ACCOUNT: Object.freeze(['commentPublicReply', 'commentPrivateReply'] as const),
  INSTAGRAM_CREATOR_ACCOUNT: Object.freeze(['commentPublicReply', 'commentPrivateReply'] as const),
});

export function automationConfigAssetKind(kind: string): AutomationConfigAssetKind | undefined {
  return Object.prototype.hasOwnProperty.call(AUTOMATION_CONFIG_FIELDS_BY_ASSET_KIND, kind)
    ? kind as AutomationConfigAssetKind : undefined;
}

export function automationConfigFieldsForAssetKind(kind: AutomationConfigAssetKind): readonly AutomationConfigField[] {
  return AUTOMATION_CONFIG_FIELDS_BY_ASSET_KIND[kind];
}

export class AutomationConfigNotFoundError extends Error {
  constructor() { super('Automation configuration asset is unavailable.'); this.name = 'AutomationConfigNotFoundError'; }
}

export class UnsupportedAutomationConfigFieldError extends Error {
  constructor() { super('The requested field is not available for this asset.'); this.name = 'UnsupportedAutomationConfigFieldError'; }
}

export class AutomationConfigValidationError extends Error {
  constructor() { super('Automation configuration update is invalid.'); this.name = 'AutomationConfigValidationError'; }
}

export class AutomationConfigVersionConflictError extends Error {
  constructor() { super('Automation configuration version changed.'); this.name = 'AutomationConfigVersionConflictError'; }
}
