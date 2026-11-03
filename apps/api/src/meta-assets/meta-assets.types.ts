import { createHash, randomUUID } from 'node:crypto';
import type { MetaAuthVariant, MetaFlowVariant } from '../credentials/credential-resolver.types.js';

export type MetaEnvironment = 'development' | 'test' | 'staging' | 'production';
export type AuthorizationState = 'ACTIVE' | 'PARTIAL' | 'REAUTH_REQUIRED' | 'UNKNOWN' | 'REVOKED' | 'DISCONNECTED';
export type AssetVerificationState = 'CLAIMED' | 'VERIFIED' | 'QUARANTINED';
export type AssetRelationType = 'PHONE_TO_ACCOUNT' | 'INSTAGRAM_TO_PAGE';
export type MetaAssetKind = 'WHATSAPP_PHONE_NUMBER' | 'WHATSAPP_BUSINESS_ACCOUNT' |
  'INSTAGRAM_BUSINESS_ACCOUNT' | 'INSTAGRAM_CREATOR_ACCOUNT' | 'FACEBOOK_PAGE';
export type SubscriptionState = 'UNKNOWN' | 'PENDING' | 'ACTIVE' | 'FAILED' | 'REMOVED';
export type ProjectionState = 'UNKNOWN' | 'PENDING' | 'SYNCED' | 'STALE' | 'FAILED';
export type EvidenceSource = 'META_API' | 'SIGNED_WEBHOOK';

const verifiedEvidence = new WeakSet<object>();
const supportedAssetKinds: ReadonlySet<string> = new Set([
  'WHATSAPP_PHONE_NUMBER', 'WHATSAPP_BUSINESS_ACCOUNT',
  'INSTAGRAM_BUSINESS_ACCOUNT', 'INSTAGRAM_CREATOR_ACCOUNT', 'FACEBOOK_PAGE',
]);

export function isMetaAssetKind(value: string): value is MetaAssetKind {
  return supportedAssetKinds.has(value);
}

/** Capability object issued only by trusted provider adapters. Browser input never maps to this type. */
export interface VerifiedMetaEvidence {
  readonly source: EvidenceSource;
  readonly observedAt: string;
  readonly observationRefHash: string;
}

export function issueVerifiedMetaEvidence(input: {
  readonly source: EvidenceSource;
  readonly observedAt: string;
  /** Reference to a provider observation; stored only as a one-way digest. */
  readonly observationRef: string;
}): VerifiedMetaEvidence {
  if (!isIsoDate(input.observedAt) || input.observationRef.trim().length === 0) {
    throw new MetaAssetsInputError('Provider evidence is incomplete.');
  }
  const evidence = Object.freeze({
    source: input.source,
    observedAt: input.observedAt,
    observationRefHash: createHash('sha256').update(input.observationRef, 'utf8').digest('hex'),
  });
  verifiedEvidence.add(evidence);
  return evidence;
}

export function isVerifiedMetaEvidence(value: unknown): value is VerifiedMetaEvidence {
  return typeof value === 'object' && value !== null && verifiedEvidence.has(value);
}

export interface AssetRelationInput {
  readonly type: AssetRelationType;
  /** Provider external identifier; always treated as an opaque string. */
  readonly targetExternalId: string;
}

export interface LegacyAssetReference {
  readonly legacyDatabaseId: string;
  readonly legacyCompanyId: string;
  readonly legacyAssetRef: string;
}

export interface AssetClaimInput {
  readonly kind: string;
  readonly externalId: string;
  readonly externalName?: string | null;
  readonly evidence?: VerifiedMetaEvidence;
  /** Opaque references imported from a tenant-validated legacy mapping. */
  readonly legacyReferences?: readonly LegacyAssetReference[];
  /** Persisted only when the asset has provider evidence. */
  readonly grants?: readonly string[];
  readonly relations?: readonly AssetRelationInput[];
}

export interface AuthorizationUpsertCommand {
  readonly tenantId: string;
  readonly authorizationId: string;
  readonly appConfigurationId: string;
  readonly provider: 'META';
  readonly environment: MetaEnvironment;
  /** Optional verified server context; never derive these values from a token or browser payload. */
  readonly flowVariant?: MetaFlowVariant;
  readonly authVariant?: MetaAuthVariant;
  readonly providerAuthorizationId?: string | null;
  readonly state: AuthorizationState;
  readonly grantedScopes: readonly string[];
  readonly evidence?: VerifiedMetaEvidence;
  readonly assets: readonly AssetClaimInput[];
  readonly actor: { readonly kind: 'USER' | 'SERVICE' | 'SYSTEM'; readonly ref: string };
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly observedAt: string;
  readonly expectedVersion?: number;
}

export interface AssetReadModel {
  readonly assetRef: string;
  readonly kind: string;
  readonly externalId: string;
  readonly externalName: string | null;
  readonly verificationState: AssetVerificationState;
  readonly grants: readonly string[];
  readonly relations: readonly { readonly type: AssetRelationType; readonly targetAssetRef: string }[];
  readonly subscriptionState: SubscriptionState;
  readonly projectionState: ProjectionState;
  readonly version: number;
  readonly updatedAt: string;
}

export interface AuthorizationReadModel {
  readonly authorizationRef: string;
  readonly provider: 'META';
  readonly environment: MetaEnvironment;
  readonly state: AuthorizationState;
  readonly grantedScopes: readonly string[];
  readonly version: number;
  readonly observedAt: string;
  readonly assets: readonly AssetReadModel[];
}

export interface AuthorizationUpsertResult {
  readonly authorizationRef: string;
  readonly version: number;
  readonly assets: readonly {
    readonly externalId: string;
    readonly assetRef?: string;
    readonly verificationState: AssetVerificationState;
  }[];
  readonly quarantinedCount: number;
}

export class MetaAssetsInputError extends Error {
  constructor(message: string) { super(message); this.name = 'MetaAssetsInputError'; }
}

export class MetaAssetsConflictError extends Error {
  constructor(message = 'The requested asset or authorization version conflicts with stored state.') {
    super(message);
    this.name = 'MetaAssetsConflictError';
  }
}

export function validateAuthorizationUpsert(command: AuthorizationUpsertCommand): void {
  if (!isUuid(command.tenantId) || !isUuid(command.authorizationId) || !isUuid(command.appConfigurationId)) {
    throw new MetaAssetsInputError('Tenant, authorization and app configuration references must be internal UUIDs.');
  }
  if (!command.actor.ref.trim() || command.actor.ref.length > 128 || !command.correlationId.trim() || command.correlationId.length > 128) {
    throw new MetaAssetsInputError('Actor and correlation references are required.');
  }
  if (!isIsoDate(command.observedAt)) throw new MetaAssetsInputError('Observation time must be an ISO UTC timestamp.');
  const flowAuthVariants: Readonly<Record<MetaFlowVariant, readonly MetaAuthVariant[]>> = {
    FACEBOOK: ['FACEBOOK_LOGIN_FOR_BUSINESS'],
    INSTAGRAM: ['FACEBOOK_LOGIN_FOR_BUSINESS', 'INSTAGRAM_LOGIN'],
    WHATSAPP_EXCLUSIVE: ['WHATSAPP_EMBEDDED_SIGNUP'],
    WHATSAPP_COEXISTENCE: ['WHATSAPP_BUSINESS_APP_ONBOARDING'],
  };
  if ((command.flowVariant === undefined) !== (command.authVariant === undefined) ||
      (command.flowVariant !== undefined && !flowAuthVariants[command.flowVariant]?.includes(command.authVariant!))) {
    throw new MetaAssetsInputError('Authorization flow/auth context must be a valid complete server-owned pair.');
  }
  if ((command.flowVariant !== undefined || command.authVariant !== undefined) &&
      (!command.evidence || command.actor.kind === 'USER')) {
    throw new MetaAssetsInputError('Authorization flow/auth context requires trusted service evidence.');
  }
  if (command.providerAuthorizationId !== undefined && command.providerAuthorizationId !== null &&
      (!command.providerAuthorizationId.length || command.providerAuthorizationId.length > 512)) {
    throw new MetaAssetsInputError('Provider authorization identifier is invalid.');
  }
  if (command.evidence !== undefined && !isVerifiedMetaEvidence(command.evidence)) {
    throw new MetaAssetsInputError('Authorization evidence was not issued by a trusted provider adapter.');
  }
  const commandObservation = normalizedIsoObservation(command.observedAt);
  if (command.evidence && normalizedIsoObservation(command.evidence.observedAt) !== commandObservation) {
    throw new MetaAssetsInputError('Authorization evidence time must match the command observation time.');
  }
  if (command.grantedScopes.length > 256 || command.grantedScopes.some((scope) => !validOpaqueName(scope, 128))) {
    throw new MetaAssetsInputError('Granted scope list is invalid.');
  }
  if (!command.evidence && command.grantedScopes.length > 0) {
    throw new MetaAssetsInputError('Browser claims cannot be persisted as granted scopes.');
  }
  if (command.assets.length > 500) throw new MetaAssetsInputError('Asset batch exceeds the supported limit.');
  if (command.actor.kind === 'USER' && command.assets.some((asset) => (asset.legacyReferences?.length ?? 0) > 0)) {
    throw new MetaAssetsInputError('Legacy references can only be attached by a service or system actor.');
  }
  if (!command.evidence && (command.providerAuthorizationId != null || command.assets.some((asset) => asset.evidence !== undefined || asset.grants !== undefined || (asset.relations?.length ?? 0) > 0))) {
    throw new MetaAssetsInputError('Provider authorization and asset grants require trusted provider evidence.');
  }
  const externalIds = new Set<string>();
  for (const asset of command.assets) {
    if (!isMetaAssetKind(asset.kind) || !validOpaqueName(asset.externalId, 512)) {
      throw new MetaAssetsInputError('Asset kind or external identifier is invalid.');
    }
    const naturalKey = `${asset.kind}\u0000${asset.externalId}`;
    if (externalIds.has(naturalKey)) throw new MetaAssetsInputError('Asset batch contains a duplicate natural key.');
    externalIds.add(naturalKey);
    if ((asset.legacyReferences?.length ?? 0) > 32) throw new MetaAssetsInputError('Legacy reference batch exceeds the supported limit.');
    for (const reference of asset.legacyReferences ?? []) {
      if (!validOpaqueName(reference.legacyDatabaseId, 128) || !validOpaqueName(reference.legacyCompanyId, 191) || !validOpaqueName(reference.legacyAssetRef, 512)) {
        throw new MetaAssetsInputError('Legacy asset reference is invalid.');
      }
    }
    if (asset.externalName !== undefined && asset.externalName !== null && asset.externalName.length > 255) {
      throw new MetaAssetsInputError('Asset external name is too long.');
    }
    if (asset.evidence !== undefined && !isVerifiedMetaEvidence(asset.evidence)) {
      throw new MetaAssetsInputError('Asset evidence was not issued by a trusted provider adapter.');
    }
    if (asset.evidence && normalizedIsoObservation(asset.evidence.observedAt) !== commandObservation) {
      throw new MetaAssetsInputError('Asset evidence time must match the command observation time.');
    }
    if (!asset.evidence && (asset.grants !== undefined || (asset.relations?.length ?? 0) > 0)) {
      throw new MetaAssetsInputError('Asset grants and relations require provider verification.');
    }
    if ((asset.grants ?? []).some((grant) => !validOpaqueName(grant, 128))) {
      throw new MetaAssetsInputError('Asset grant is invalid.');
    }
    for (const relation of asset.relations ?? []) {
      if (!['PHONE_TO_ACCOUNT', 'INSTAGRAM_TO_PAGE'].includes(relation.type) || !validOpaqueName(relation.targetExternalId, 512)) {
        throw new MetaAssetsInputError('Asset relation is invalid.');
      }
    }
  }
}

/** Explicit safe serialization: credential material is not part of the read-model contract. */
export function serializeAuthorizationReadModel(value: AuthorizationReadModel): AuthorizationReadModel {
  return Object.freeze({
    authorizationRef: value.authorizationRef,
    provider: value.provider,
    environment: value.environment,
    state: value.state,
    grantedScopes: Object.freeze([...value.grantedScopes]),
    version: value.version,
    observedAt: value.observedAt,
    assets: Object.freeze(value.assets.map((asset) => Object.freeze({
      assetRef: asset.assetRef,
      kind: asset.kind,
      externalId: asset.externalId,
      externalName: asset.externalName,
      verificationState: asset.verificationState,
      grants: Object.freeze([...asset.grants]),
      relations: Object.freeze(asset.relations.map((relation) => Object.freeze({ ...relation }))),
      subscriptionState: asset.subscriptionState,
      projectionState: asset.projectionState,
      version: asset.version,
      updatedAt: asset.updatedAt,
    }))),
  });
}

export function newAuthorizationId(): string { return randomUUID(); }

export function assetIdentityHash(input: {
  readonly provider: string;
  readonly appExternalId: string;
  readonly environment: string;
  readonly kind: string;
  readonly externalId: string;
}): Buffer {
  return createHash('sha256')
    .update([input.provider, input.appExternalId, input.environment, input.kind, input.externalId].join('\u0000'), 'utf8')
    .digest();
}

function validOpaqueName(value: string, maxLength: number): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isIsoDate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value)); }
function normalizedIsoObservation(value: string): string {
  const fraction = value.match(/\.(\d{1,6})Z$/)?.[1] ?? '';
  return new Date(value).toISOString().slice(0, 19) + '.' + fraction.padEnd(6, '0') + 'Z';
}
