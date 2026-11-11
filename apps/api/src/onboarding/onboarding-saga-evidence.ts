import { createHash } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { isUuid } from '../jobs/event-validation.js';
import type { OnboardingFlowVariant } from './onboarding-session.types.js';
import { isSafePhoneReadiness, type OnboardingPhoneReadiness } from './onboarding-phone-readiness.js';

export interface OnboardingSagaEvidenceContext {
  readonly tenantId: string;
  readonly onboardingId: string;
  readonly configurationRef: string;
  readonly providerAppId: string;
  readonly providerEnvironment: string;
  readonly flowVariant: OnboardingFlowVariant;
  readonly authVariant: string;
}

export interface OnboardingSagaEvidenceValues {
  readonly authorizationRef?: string;
  readonly verifiedAssetRefs?: readonly string[];
  readonly subscriptionRef?: string;
  readonly projectionRef?: string;
  readonly phoneReadiness?: readonly OnboardingPhoneReadiness[];
}

export type OnboardingSagaReceiptStage = 'subscription' | 'projection';

/** These are local stage receipts, scoped to the exact tenant/session/config/authorization tuple. */
export function onboardingSagaStageReceipt(
  stage: OnboardingSagaReceiptStage,
  context: OnboardingSagaEvidenceContext,
  authorizationRef: string,
  verifiedAssetRefs: readonly string[],
): string {
  const digest = createHash('sha256').update([
    'ca-meta:onboarding-saga-receipt:v1', stage, context.tenantId, context.onboardingId,
    context.configurationRef, context.providerAppId, context.providerEnvironment,
    context.flowVariant, context.authVariant, authorizationRef, ...[...verifiedAssetRefs].sort(),
  ].join('\0')).digest('hex');
  return `internal:${stage}:${digest}`;
}

export function assertSafeOnboardingSagaEvidence(
  evidence: OnboardingSagaEvidenceValues,
  context: OnboardingSagaEvidenceContext,
): void {
  if (evidence.authorizationRef !== undefined && !isUuid(evidence.authorizationRef)) {
    throw new Error('Unsafe authorization evidence reference.');
  }
  if (evidence.verifiedAssetRefs !== undefined && (evidence.verifiedAssetRefs.length < 1 || evidence.verifiedAssetRefs.length > 100 ||
    new Set(evidence.verifiedAssetRefs).size !== evidence.verifiedAssetRefs.length || !evidence.verifiedAssetRefs.every(isUuid))) {
    throw new Error('Unsafe verified asset evidence.');
  }
  if (evidence.phoneReadiness !== undefined && (!evidence.verifiedAssetRefs ||
      !isSafePhoneReadiness(evidence.phoneReadiness, context.flowVariant, evidence.verifiedAssetRefs))) {
    throw new Error('Unsafe WhatsApp phone readiness evidence.');
  }
  if (evidence.subscriptionRef !== undefined && (!evidence.authorizationRef || !evidence.verifiedAssetRefs?.length ||
    evidence.subscriptionRef !== onboardingSagaStageReceipt('subscription', context, evidence.authorizationRef, evidence.verifiedAssetRefs))) {
    throw new Error('Unsafe subscription evidence reference.');
  }
  if (evidence.projectionRef !== undefined && (!evidence.authorizationRef || !evidence.subscriptionRef ||
    !evidence.verifiedAssetRefs?.length ||
    evidence.projectionRef !== onboardingSagaStageReceipt('projection', context, evidence.authorizationRef, evidence.verifiedAssetRefs))) {
    throw new Error('Unsafe projection evidence reference.');
  }
}

/** Refuse references that are not already owned by this exact tenant, config and Meta flow. */
export async function assertOwnedOnboardingSagaEvidence(
  manager: Pick<EntityManager, 'query'>,
  evidence: OnboardingSagaEvidenceValues,
  context: OnboardingSagaEvidenceContext,
): Promise<void> {
  assertSafeOnboardingSagaEvidence(evidence, context);
  if (!evidence.authorizationRef) {
    if (evidence.verifiedAssetRefs || evidence.subscriptionRef || evidence.projectionRef || evidence.phoneReadiness) {
      throw new Error('Onboarding evidence has no owning authorization.');
    }
    return;
  }

  const databaseAuthorization = databaseAuthorizationFor(context.flowVariant, context.authVariant);
  const authorizationRows = await manager.query(
    `SELECT auth.id
     FROM ca_meta_authorizations auth
     INNER JOIN ca_meta_app_configurations app
       ON app.tenant_id = auth.tenant_id AND app.id = auth.app_configuration_id
        AND app.provider = auth.provider AND app.environment = auth.environment
     WHERE app.tenant_id = ? AND app.provider = 'META' AND app.environment = ? AND app.app_external_id = ?
       AND auth.tenant_id = ? AND auth.id = ?
       AND auth.provider = 'META' AND auth.flow_variant = ? AND auth.auth_variant = ?
       AND auth.authorization_state = 'ACTIVE' LIMIT 1`,
    [context.tenantId, context.providerEnvironment, context.providerAppId, context.tenantId,
      evidence.authorizationRef, databaseAuthorization.flowVariant, databaseAuthorization.authVariant],
  ) as Array<{ id: string }>;
  if (authorizationRows.length !== 1 || authorizationRows[0]?.id !== evidence.authorizationRef) {
    throw new Error('Onboarding authorization evidence is not owned by this tenant and flow.');
  }

  const assetRefs = evidence.verifiedAssetRefs;
  if (!assetRefs) return;
  const placeholders = assetRefs.map(() => '?').join(', ');
  const ownedAssets = await manager.query(
    `SELECT aa.asset_id, asset.asset_kind
     FROM ca_meta_asset_authorizations aa
     INNER JOIN ca_meta_assets asset
       ON asset.tenant_id = aa.tenant_id AND asset.id = aa.asset_id
        AND asset.app_configuration_id = aa.app_configuration_id
        AND asset.provider = aa.provider AND asset.environment = aa.environment
     INNER JOIN ca_meta_authorizations auth
       ON auth.tenant_id = aa.tenant_id AND auth.id = aa.authorization_id
        AND auth.app_configuration_id = aa.app_configuration_id
        AND auth.provider = aa.provider AND auth.environment = aa.environment
     INNER JOIN ca_meta_app_configurations app
       ON app.tenant_id = auth.tenant_id AND app.id = auth.app_configuration_id
        AND app.provider = 'META' AND app.environment = auth.environment
     WHERE app.tenant_id = ? AND app.provider = 'META' AND app.environment = ? AND app.app_external_id = ?
       AND aa.tenant_id = ? AND aa.authorization_id = ? AND aa.app_configuration_id = app.id
       AND aa.provider = 'META' AND aa.asset_id IN (${placeholders})
       AND aa.state = 'ACTIVE' AND aa.verification_state = 'VERIFIED'
       AND auth.flow_variant = ? AND auth.auth_variant = ? AND auth.authorization_state = 'ACTIVE'`,
    [context.tenantId, context.providerEnvironment, context.providerAppId, context.tenantId,
      evidence.authorizationRef, ...assetRefs, databaseAuthorization.flowVariant, databaseAuthorization.authVariant],
  ) as Array<{ asset_id: string; asset_kind: string }>;
  const ownedIds = new Set(ownedAssets.map((row) => row.asset_id));
  if (ownedIds.size !== assetRefs.length || !assetRefs.every((ref) => ownedIds.has(ref))) {
    throw new Error('Onboarding asset evidence is not owned by this tenant and authorization.');
  }
  if (evidence.phoneReadiness) {
    if (databaseAuthorization.flowVariant !== 'WHATSAPP_EXCLUSIVE' || databaseAuthorization.authVariant !== 'WHATSAPP_EMBEDDED_SIGNUP') {
      throw new Error('WhatsApp phone readiness is attached to another onboarding flow.');
    }
    const phoneRefs = ownedAssets.filter((asset) => asset.asset_kind === 'WHATSAPP_PHONE_NUMBER').map((asset) => asset.asset_id).sort();
    const readinessRefs = evidence.phoneReadiness.map((item) => item.assetRef).sort();
    if (phoneRefs.length === 0 || phoneRefs.length !== readinessRefs.length || phoneRefs.some((ref, index) => ref !== readinessRefs[index])) {
      throw new Error('WhatsApp phone readiness does not cover exactly the verified numbers.');
    }
  }
}

function databaseAuthorizationFor(flow: OnboardingFlowVariant, authVariant: string): {
  readonly flowVariant: string;
  readonly authVariant: string;
} {
  switch (flow) {
    case 'FACEBOOK_LOGIN':
      if (authVariant === 'FACEBOOK_LOGIN_FOR_BUSINESS') return { flowVariant: 'FACEBOOK', authVariant };
      break;
    case 'INSTAGRAM_VIA_FACEBOOK_LOGIN':
      if (authVariant === 'INSTAGRAM_VIA_FACEBOOK_LOGIN') {
        return { flowVariant: 'INSTAGRAM', authVariant: 'FACEBOOK_LOGIN_FOR_BUSINESS' };
      }
      break;
    case 'INSTAGRAM_LOGIN':
      if (authVariant === 'INSTAGRAM_LOGIN') return { flowVariant: 'INSTAGRAM', authVariant };
      break;
    case 'WHATSAPP_CLOUD_API':
      if (authVariant === 'WHATSAPP_EMBEDDED_SIGNUP') return { flowVariant: 'WHATSAPP_EXCLUSIVE', authVariant };
      break;
    case 'WHATSAPP_COEXISTENCE':
      if (authVariant === 'WHATSAPP_BUSINESS_APP_ONBOARDING') return { flowVariant: 'WHATSAPP_COEXISTENCE', authVariant };
      break;
  }
  throw new Error('Unsupported onboarding flow/auth context.');
}
