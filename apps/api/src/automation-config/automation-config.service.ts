import type { components } from '@ca-meta/contracts';
import { IdentityDeniedError } from '../identity/identity.errors.js';
import { isVerifiedPortalSession, type VerifiedPortalSession } from '../identity/identity.trust.js';
import { TenantAuthorizationService, TenantContextService } from '../identity/identity.service.js';
import type { MetaEnvironment } from '../meta-assets/meta-assets.types.js';
import type { MetaAssetsRepository } from '../meta-assets/mysql-meta-assets.repository.js';
import {
  AutomationConfigNotFoundError,
  AutomationConfigValidationError,
  AutomationConfigVersionConflictError,
  UnsupportedAutomationConfigFieldError,
  automationConfigAssetKind,
  automationConfigFieldsForAssetKind,
  type AutomationConfigPatch,
  type AutomationConfigRepository,
} from './automation-config.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 4096;
const DISALLOWED_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function isEditor(roles: readonly string[]): boolean {
  return roles.some((role) => role === 'owner' || role === 'admin' || role === 'operator');
}

function validatePatch(patch: AutomationConfigPatch, supportedFields: readonly string[]): void {
  if (!Number.isSafeInteger(patch.version) || patch.version < 0) throw new AutomationConfigVersionConflictError();
  const fields = ['privateWelcomeMessage', 'commentPublicReply', 'commentPrivateReply'] as const;
  const changed = fields.filter((field) => Object.prototype.hasOwnProperty.call(patch, field));
  if (changed.length === 0) throw new AutomationConfigValidationError();
  for (const field of changed) {
    if (!supportedFields.includes(field)) throw new AutomationConfigValidationError();
    const value = patch[field];
    if (typeof value !== 'string' || value.length > MAX_MESSAGE_LENGTH || DISALLOWED_CONTROLS.test(value)) {
      throw new AutomationConfigValidationError();
    }
  }
}

export function automationConfigEtag(version: number): string { return `"automation-v${version}"`; }

export class AutomationConfigService {
  constructor(
    private readonly repository: AutomationConfigRepository,
    private readonly assets: MetaAssetsRepository,
    private readonly contexts: TenantContextService,
    private readonly authorization: TenantAuthorizationService,
    private readonly environment: MetaEnvironment,
  ) {}

  async read(session: VerifiedPortalSession, contextRef: string, assetId: string, requestId: string): Promise<components['schemas']['AutomationConfig']> {
    const scope = await this.scope(session, contextRef);
    await this.authorization.authorize(scope, 'RESOURCE_READ', scope.tenantId);
    const asset = await this.findAsset(scope.tenantId, assetId);
    const assetKind = automationConfigAssetKind(asset.kind);
    if (!assetKind) throw new UnsupportedAutomationConfigFieldError();
    const state = await this.repository.read({ tenantId: scope.tenantId, assetId: asset.assetRef });
    return this.serialize(asset.assetRef, assetKind, state, isEditor(scope.roles), requestId);
  }

  async update(session: VerifiedPortalSession, contextRef: string, assetId: string, requestId: string,
    ifMatchVersion: number, patch: AutomationConfigPatch): Promise<components['schemas']['AutomationConfig']> {
    const scope = await this.scope(session, contextRef);
    await this.authorization.authorize(scope, 'MANAGE_AUTOMATION_CONFIG', scope.tenantId);
    const asset = await this.findAsset(scope.tenantId, assetId);
    const assetKind = automationConfigAssetKind(asset.kind);
    if (!assetKind) throw new UnsupportedAutomationConfigFieldError();
    const supportedFields = automationConfigFieldsForAssetKind(assetKind);
    ifMatchVersion = Number.isSafeInteger(ifMatchVersion) && ifMatchVersion >= 0 ? ifMatchVersion : -1;
    if (ifMatchVersion !== patch.version) throw new AutomationConfigVersionConflictError();
    validatePatch(patch, supportedFields);
    const state = await this.repository.update({
      tenantId: scope.tenantId,
      assetId: asset.assetRef,
      actorId: scope.principalId,
      requestId,
      patch,
    });
    return this.serialize(asset.assetRef, assetKind, state, true, requestId);
  }

  private async scope(session: VerifiedPortalSession, contextRef: string) {
    if (!isVerifiedPortalSession(session)) throw new IdentityDeniedError();
    return this.contexts.resolveCurrent(session, contextRef);
  }

  private async findAsset(tenantId: string, assetId: string) {
    if (!UUID.test(assetId)) throw new AutomationConfigNotFoundError();
    const asset = await this.assets.findAssetCatalog({ tenantId, environment: this.environment, assetRef: assetId });
    if (!asset) throw new AutomationConfigNotFoundError();
    return asset;
  }

  private serialize(assetId: string, assetKind: components['schemas']['AutomationConfigAssetKind'],
    state: Awaited<ReturnType<AutomationConfigRepository['read']>>, canEdit: boolean, requestId: string): components['schemas']['AutomationConfig'] {
    return Object.freeze({
      assetId,
      assetKind,
      inheritanceMode: 'ASSET_ONLY',
      supportedFields: automationConfigFieldsForAssetKind(assetKind),
      privateWelcomeMessage: state.privateWelcomeMessage,
      commentPublicReply: state.commentPublicReply,
      commentPrivateReply: state.commentPrivateReply,
      capabilities: Object.freeze({ canEdit, executable: false }),
      version: state.version,
      updatedAt: state.updatedAt,
      projectionState: state.projectionState,
      requestId,
    });
  }
}
