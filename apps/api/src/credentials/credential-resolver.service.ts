import { isVerifiedServiceTenantScope } from '../identity/identity.service.js';
import type { ServiceTenantAuthorizationService } from '../identity/identity.service.js';
import type { VerifiedServiceTenantScope } from '../identity/identity.types.js';
import { CredentialResolutionError } from './credential-resolver.errors.js';
import type {
  CredentialHealthObservation,
  CredentialOperationPolicy,
  CredentialOperationPolicyPort,
  CredentialResolutionActor,
  CredentialResolutionAuditEntry,
  CredentialResolutionAuditPort,
  CredentialResolutionAuthorizationPort,
  CredentialResolutionCandidate,
  CredentialResolutionContext,
  CredentialResolutionHandle,
  CredentialResolutionRepository,
  CredentialResolutionResult,
  CredentialSecretExecutor,
  CredentialSelectionReason,
} from './credential-resolver.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_NAME = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_CANDIDATES = 1000;
const MAX_ANCESTRY_DEPTH = 4;

const FLOW_AUTH_VARIANTS = {
  FACEBOOK: ['FACEBOOK_LOGIN_FOR_BUSINESS'],
  INSTAGRAM: ['FACEBOOK_LOGIN_FOR_BUSINESS', 'INSTAGRAM_LOGIN'],
  WHATSAPP_EXCLUSIVE: ['WHATSAPP_EMBEDDED_SIGNUP'],
  WHATSAPP_COEXISTENCE: ['WHATSAPP_BUSINESS_APP_ONBOARDING'],
} as const;

const FLOW_ASSET_KINDS = {
  FACEBOOK: ['FACEBOOK_PAGE'],
  INSTAGRAM: ['INSTAGRAM_BUSINESS_ACCOUNT', 'INSTAGRAM_CREATOR_ACCOUNT', 'FACEBOOK_PAGE'],
  WHATSAPP_EXCLUSIVE: ['WHATSAPP_PHONE_NUMBER', 'WHATSAPP_BUSINESS_ACCOUNT'],
  WHATSAPP_COEXISTENCE: ['WHATSAPP_PHONE_NUMBER', 'WHATSAPP_BUSINESS_ACCOUNT'],
} as const;

const SUPPORTED_ANCESTRY_RULES = new Set([
  'PHONE_TO_ACCOUNT:WHATSAPP_PHONE_NUMBER:WHATSAPP_BUSINESS_ACCOUNT',
  'INSTAGRAM_TO_PAGE:INSTAGRAM_BUSINESS_ACCOUNT:FACEBOOK_PAGE',
  'INSTAGRAM_TO_PAGE:INSTAGRAM_CREATOR_ACCOUNT:FACEBOOK_PAGE',
]);

interface ResolvedState {
  readonly context: CredentialResolutionContext;
  readonly actor: CredentialResolutionActor;
  readonly policy: CredentialOperationPolicy;
  readonly candidate: CredentialResolutionCandidate;
}

interface EligibleCandidate {
  readonly candidate: CredentialResolutionCandidate;
  readonly lineageDepth: number;
  readonly familyPreference: number;
  readonly expirySortValue: number;
}

function isEnvironment(value: string): value is CredentialResolutionContext['environment'] {
  return ['development', 'test', 'staging', 'production'].includes(value);
}

function isIsoUtc(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function validContext(context: CredentialResolutionContext): boolean {
  return !!context && context.provider === 'META' && isEnvironment(context.environment) &&
    UUID.test(context.tenantId) && UUID.test(context.appConfigurationId) && UUID.test(context.assetId) &&
    ['ASSET_DISCOVERY', 'READ_STATUS', 'SUBSCRIBE_WEBHOOKS', 'SEND_MESSAGE', 'MANAGE_TEMPLATES',
      'PHONE_REGISTRATION_CONVENTIONAL'].includes(context.operation);
}

function validPolicy(context: CredentialResolutionContext, policy: CredentialOperationPolicy): boolean {
  if (!policy || policy.tenantId !== context.tenantId || policy.provider !== context.provider ||
      policy.appConfigurationId !== context.appConfigurationId || policy.environment !== context.environment ||
      policy.operation !== context.operation || policy.capability !== context.operation ||
      !Number.isSafeInteger(policy.version) || policy.version < 1 ||
      !FLOW_AUTH_VARIANTS[policy.flowVariant]?.includes(policy.authVariant as never) ||
      !Array.isArray(policy.assetKinds) || policy.assetKinds.length === 0 ||
      policy.assetKinds.some((kind) => !FLOW_ASSET_KINDS[policy.flowVariant].includes(kind as never)) ||
      !Array.isArray(policy.allowedFamilies) || policy.allowedFamilies.length === 0 ||
      policy.allowedFamilies.some((family) => !/^[A-Z][A-Z0-9_-]{0,31}$/.test(family)) ||
      new Set(policy.allowedFamilies).size !== policy.allowedFamilies.length ||
      !Array.isArray(policy.preferredFamilies) || policy.preferredFamilies.length === 0 ||
      policy.preferredFamilies.some((family) => !policy.allowedFamilies.includes(family)) ||
      policy.preferredFamilies.length !== policy.allowedFamilies.length ||
      new Set(policy.preferredFamilies).size !== policy.preferredFamilies.length ||
      !Array.isArray(policy.requiredAssetGrants) || policy.requiredAssetGrants.length === 0 ||
      policy.requiredAssetGrants.some((grant) => !SAFE_NAME.test(grant)) ||
      !Array.isArray(policy.requiredAuthorizationScopes) ||
      policy.requiredAuthorizationScopes.some((scope) => !SAFE_NAME.test(scope)) ||
      !Array.isArray(policy.ancestryRules) || policy.ancestryRules.length > MAX_ANCESTRY_DEPTH ||
      policy.ancestryRules.some((rule) => !rule ||
        !SUPPORTED_ANCESTRY_RULES.has(`${rule.relationType}:${rule.childKind}:${rule.parentKind}`)) ||
      !Number.isSafeInteger(policy.maxHealthObservationAgeSeconds) || policy.maxHealthObservationAgeSeconds < 1 ||
      policy.maxHealthObservationAgeSeconds > 86400 || typeof policy.allowExpiring !== 'boolean' ||
      !['APP_INSPECTION', 'CUSTOMER_OPERATION'].includes(policy.purpose)) {
    return false;
  }
  if (context.operation === 'PHONE_REGISTRATION_CONVENTIONAL' && policy.flowVariant === 'WHATSAPP_COEXISTENCE') return false;
  return true;
}

function candidateMatchesBinding(candidate: CredentialResolutionCandidate, context: CredentialResolutionContext,
  policy: CredentialOperationPolicy): boolean {
  if (!candidate || !candidate.binding) return false;
  const binding = candidate.binding;
  return binding.tenantId === context.tenantId && binding.provider === context.provider &&
    binding.appConfigurationId === context.appConfigurationId && binding.environment === context.environment &&
    UUID.test(binding.credentialId) && UUID.test(binding.authorizationId) &&
    /^[A-Z][A-Z0-9_-]{0,31}$/.test(binding.family) && policy.allowedFamilies.includes(binding.family);
}

function lineageDepth(candidate: CredentialResolutionCandidate, asset: NonNullable<Awaited<ReturnType<CredentialResolutionRepository['inspect']>>['asset']>,
  policy: CredentialOperationPolicy): number | undefined {
  if (candidate.grantAssetId === asset.assetId) {
    return candidate.grantAssetKind === asset.kind && Array.isArray(candidate.lineage) && candidate.lineage.length === 0 ? 0 : undefined;
  }
  if (!Array.isArray(candidate.lineage) || candidate.lineage.length === 0 || candidate.lineage.length > MAX_ANCESTRY_DEPTH) return undefined;
  let expectedAssetId = asset.assetId;
  let expectedKind = asset.kind;
  const seen = new Set([asset.assetId]);
  for (const step of candidate.lineage) {
    if (!step) return undefined;
    const allowed = policy.ancestryRules.some((rule) => rule.relationType === step.relationType &&
      rule.childKind === step.childKind && rule.parentKind === step.parentKind);
    if (!allowed || step.verified !== true || step.childAssetId !== expectedAssetId || step.childKind !== expectedKind ||
        !UUID.test(step.parentAssetId) || seen.has(step.parentAssetId)) return undefined;
    expectedAssetId = step.parentAssetId;
    expectedKind = step.parentKind;
    seen.add(step.parentAssetId);
  }
  return expectedAssetId === candidate.grantAssetId && expectedKind === candidate.grantAssetKind
    ? candidate.lineage.length
    : undefined;
}

function isFreshObservation(value: string | undefined, now: number, maxAgeSeconds: number): boolean {
  if (!value || !isIsoUtc(value)) return false;
  const observed = Date.parse(value);
  return observed <= now && now - observed <= maxAgeSeconds * 1000;
}

function expirySortValue(candidate: CredentialResolutionCandidate): number | undefined {
  if (candidate.expiry.state === 'PROVIDER_NO_EXPIRY') return Number.POSITIVE_INFINITY;
  if (candidate.expiry.state === 'KNOWN' && isIsoUtc(candidate.expiry.expiresAt)) return Date.parse(candidate.expiry.expiresAt);
  return undefined;
}

function dataAccessExpiryValue(candidate: CredentialResolutionCandidate): number | undefined {
  if (candidate.dataAccessExpiry.state === 'KNOWN' && isIsoUtc(candidate.dataAccessExpiry.expiresAt)) {
    return Date.parse(candidate.dataAccessExpiry.expiresAt);
  }
  return undefined;
}

function isUsableHealth(health: CredentialHealthObservation, policy: CredentialOperationPolicy, now: number): boolean {
  if (health.state !== 'HEALTHY' && !(policy.allowExpiring && health.state === 'EXPIRING')) return false;
  return ['META_API', 'SIGNED_WEBHOOK'].includes(health.source) &&
    isFreshObservation(health.observedAt, now, policy.maxHealthObservationAgeSeconds);
}

function eligibleCandidate(candidate: CredentialResolutionCandidate, context: CredentialResolutionContext,
  policy: CredentialOperationPolicy, asset: NonNullable<Awaited<ReturnType<CredentialResolutionRepository['inspect']>>['asset']>,
  now: number): EligibleCandidate | undefined {
  if (!candidate || !candidate.binding || !candidate.health || !candidate.expiry || !candidate.dataAccessExpiry ||
      !Array.isArray(candidate.grantedAssetGrants) || !Array.isArray(candidate.grantedAuthorizationScopes) ||
      !candidateMatchesBinding(candidate, context, policy) || candidate.authorizationState !== 'ACTIVE' &&
      candidate.authorizationState !== 'PARTIAL' || candidate.credentialStatus !== 'ACTIVE' ||
      candidate.assetAuthorizationState !== 'ACTIVE' || candidate.assetVerificationState !== 'VERIFIED' ||
      !UUID.test(candidate.grantAssetId) || typeof candidate.grantAssetKind !== 'string' ||
      candidate.grantAssetKind.length === 0 || candidate.secretAvailable !== true ||
      !Number.isSafeInteger(candidate.secretVersion) || candidate.secretVersion < 1 ||
      !Number.isSafeInteger(candidate.authorizationVersion) || candidate.authorizationVersion < 1 ||
      !Number.isSafeInteger(candidate.credentialVersion) || candidate.credentialVersion < 1 ||
      !Number.isSafeInteger(candidate.assetAuthorizationVersion) || candidate.assetAuthorizationVersion < 1) return undefined;
  const depth = lineageDepth(candidate, asset, policy);
  if (depth === undefined || !policy.assetKinds.includes(asset.kind) ||
      !policy.requiredAssetGrants.every((grant) => candidate.grantedAssetGrants.includes(grant))) return undefined;
  if (!policy.requiredAuthorizationScopes.every((scope) => candidate.grantedAuthorizationScopes.includes(scope))) return undefined;
  if (!isUsableHealth(candidate.health, policy, now)) return undefined;
  const expiryValue = expirySortValue(candidate);
  const expiryFresh = candidate.expiry.state === 'KNOWN' || candidate.expiry.state === 'PROVIDER_NO_EXPIRY'
    ? ['META_API', 'SIGNED_WEBHOOK'].includes(candidate.expiry.source) &&
      isFreshObservation(candidate.expiry.observedAt, now, policy.maxHealthObservationAgeSeconds)
    : false;
  const accessExpiryValue = dataAccessExpiryValue(candidate);
  const accessExpiryFresh = candidate.dataAccessExpiry.state === 'KNOWN' &&
    ['META_API', 'SIGNED_WEBHOOK'].includes(candidate.dataAccessExpiry.source) &&
    isFreshObservation(candidate.dataAccessExpiry.observedAt, now, policy.maxHealthObservationAgeSeconds);
  if (expiryValue === undefined || (!Number.isFinite(expiryValue) && expiryValue !== Number.POSITIVE_INFINITY) ||
      !expiryFresh || expiryValue <= now || accessExpiryValue === undefined || !Number.isFinite(accessExpiryValue) ||
      !accessExpiryFresh || accessExpiryValue <= now) return undefined;
  return {
    candidate,
    lineageDepth: depth,
    familyPreference: policy.preferredFamilies.indexOf(candidate.binding.family),
    expirySortValue: Math.min(expiryValue, accessExpiryValue),
  };
}

function compareCandidates(left: EligibleCandidate, right: EligibleCandidate): number {
  const leftHasNoProviderExpiry = left.candidate.expiry.state === 'PROVIDER_NO_EXPIRY';
  const rightHasNoProviderExpiry = right.candidate.expiry.state === 'PROVIDER_NO_EXPIRY';
  const expiryOrder = leftHasNoProviderExpiry && rightHasNoProviderExpiry ? 0
    : leftHasNoProviderExpiry ? 1
      : rightHasNoProviderExpiry ? -1
        : right.expirySortValue - left.expirySortValue;
  return left.lineageDepth - right.lineageDepth || left.familyPreference - right.familyPreference || expiryOrder ||
    right.candidate.authorizationVersion - left.candidate.authorizationVersion ||
    right.candidate.credentialVersion - left.candidate.credentialVersion ||
    left.candidate.binding.authorizationId.localeCompare(right.candidate.binding.authorizationId) ||
    left.candidate.binding.credentialId.localeCompare(right.candidate.binding.credentialId);
}

function selectionReason(candidate: EligibleCandidate): CredentialSelectionReason {
  return candidate.lineageDepth === 0 ? 'DIRECT_ASSET_GRANT' : 'VERIFIED_ANCESTOR_GRANT';
}

function failureCode(candidates: readonly CredentialResolutionCandidate[], context: CredentialResolutionContext,
  policy: CredentialOperationPolicy, assetId: string, now: number): 'ASSET_GRANT_MISSING' | 'META_PERMISSION_REQUIRED' |
  'META_REAUTH_REQUIRED' | 'DEPENDENCY_UNAVAILABLE' {
  const scoped = candidates.filter((candidate) => candidateMatchesBinding(candidate, context, policy));
  if (scoped.some((candidate) => !candidate.health || !candidate.expiry || !candidate.dataAccessExpiry || !Array.isArray(candidate.lineage) ||
      !Array.isArray(candidate.grantedAssetGrants) || !Array.isArray(candidate.grantedAuthorizationScopes))) {
    return 'DEPENDENCY_UNAVAILABLE';
  }
  if (scoped.some((candidate) => candidate.authorizationState === 'REAUTH_REQUIRED' ||
      candidate.authorizationState === 'REVOKED' || candidate.authorizationState === 'DISCONNECTED' ||
      candidate.credentialStatus === 'REAUTH_REQUIRED' || candidate.credentialStatus === 'REVOKED' ||
      ['EXPIRED', 'REVOKED', 'ACTION_REQUIRED'].includes(candidate.health.state) ||
      candidate.expiry.state === 'KNOWN' && isIsoUtc(candidate.expiry.expiresAt) && Date.parse(candidate.expiry.expiresAt) <= now ||
      candidate.dataAccessExpiry.state === 'KNOWN' && isIsoUtc(candidate.dataAccessExpiry.expiresAt) &&
        Date.parse(candidate.dataAccessExpiry.expiresAt) <= now)) return 'META_REAUTH_REQUIRED';
  const grants = scoped.filter((candidate) => candidate.grantAssetId === assetId || candidate.lineage.length > 0);
  if (grants.some((candidate) => policy.requiredAssetGrants.every((grant) => candidate.grantedAssetGrants.includes(grant)) &&
      !policy.requiredAuthorizationScopes.every((scope) => candidate.grantedAuthorizationScopes.includes(scope)))) {
    return 'META_PERMISSION_REQUIRED';
  }
  if (scoped.some((candidate) => candidate.health.state === 'UNKNOWN' || candidate.health.state === 'STALE' ||
      candidate.expiry.state === 'UNKNOWN' || candidate.expiry.state === 'STALE' ||
      candidate.dataAccessExpiry.state === 'UNKNOWN' || candidate.dataAccessExpiry.state === 'STALE')) return 'DEPENDENCY_UNAVAILABLE';
  if (grants.length > 0 && !grants.some((candidate) => policy.requiredAssetGrants.every((grant) => candidate.grantedAssetGrants.includes(grant)))) {
    return 'ASSET_GRANT_MISSING';
  }
  return 'ASSET_GRANT_MISSING';
}

function isSameSelection(left: CredentialResolutionCandidate, right: CredentialResolutionCandidate): boolean {
  return left.binding.tenantId === right.binding.tenantId && left.binding.credentialId === right.binding.credentialId &&
    left.binding.authorizationId === right.binding.authorizationId &&
    left.binding.appConfigurationId === right.binding.appConfigurationId && left.binding.provider === right.binding.provider &&
    left.binding.environment === right.binding.environment && left.binding.family === right.binding.family &&
    left.authorizationVersion === right.authorizationVersion && left.credentialVersion === right.credentialVersion &&
    left.assetAuthorizationVersion === right.assetAuthorizationVersion && left.secretVersion === right.secretVersion;
}

export class CredentialResolverService {
  private readonly handles = new WeakMap<object, ResolvedState>();

  constructor(
    private readonly repository: CredentialResolutionRepository,
    private readonly policies: CredentialOperationPolicyPort,
    private readonly authorization: CredentialResolutionAuthorizationPort,
    private readonly audit: CredentialResolutionAuditPort,
    private readonly vault: CredentialSecretExecutor,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async resolve(context: CredentialResolutionContext, actor: CredentialResolutionActor): Promise<CredentialResolutionResult> {
    this.validateRequest(context, actor);
    const actorSnapshot = Object.freeze({ serviceScope: actor.serviceScope, correlationId: actor.correlationId });
    await this.authorize(actorSnapshot.serviceScope, context.tenantId);
    const policy = await this.findPolicy(context);
    const { snapshot, selected } = await this.inspectAndSelect(context, policy);
    if (!snapshot.asset?.verified || snapshot.asset.assetId !== context.assetId ||
        !policy.assetKinds.includes(snapshot.asset.kind)) {
      throw new CredentialResolutionError('RESOURCE_NOT_AVAILABLE');
    }
    const selectedReason = selectionReason(selected);
    const candidate = selected.candidate;
    const auditEntry: CredentialResolutionAuditEntry = {
      tenantId: context.tenantId,
      actorRef: actorSnapshot.serviceScope.principalId,
      appConfigurationId: context.appConfigurationId,
      environment: context.environment,
      provider: context.provider,
      assetId: context.assetId,
      authorizationId: candidate.binding.authorizationId,
      credentialId: candidate.binding.credentialId,
      family: candidate.binding.family,
      operation: context.operation,
      purpose: policy.purpose,
      reason: selectedReason,
      policyVersion: policy.version,
      authorizationVersion: candidate.authorizationVersion,
      credentialVersion: candidate.credentialVersion,
      correlationId: actorSnapshot.correlationId,
    };
    try {
      await this.audit.recordSelection(Object.freeze(auditEntry));
    } catch {
      throw new CredentialResolutionError('DEPENDENCY_UNAVAILABLE');
    }
    const handle = Object.freeze({}) as CredentialResolutionHandle;
    this.handles.set(handle, {
      context: Object.freeze({ ...context }),
      actor: actorSnapshot,
      policy,
      candidate: this.copyCandidate(candidate),
    });
    return Object.freeze({
      handle,
      status: 'READY',
      capability: policy.capability,
      family: candidate.binding.family,
      purpose: policy.purpose,
    });
  }

  /** The trusted adapter receives plaintext only inside the vault callback. Handles are one-use. */
  async withCredential(handle: CredentialResolutionHandle, execute: (secret: string) => Promise<void>): Promise<void> {
    if (typeof handle !== 'object' || handle === null) throw new CredentialResolutionError('ACCESS_DENIED');
    const state = this.handles.get(handle);
    if (!state) throw new CredentialResolutionError('ACCESS_DENIED');
    this.handles.delete(handle);
    await this.authorize(state.actor.serviceScope, state.context.tenantId);
    const currentPolicy = await this.findPolicy(state.context);
    if (currentPolicy.version !== state.policy.version) throw new CredentialResolutionError('CONTEXT_CHANGED');
    const { selected } = await this.inspectAndSelect(state.context, currentPolicy);
    if (!isSameSelection(selected.candidate, state.candidate)) throw new CredentialResolutionError('CONTEXT_CHANGED');
    await this.vault.withCredential({
      ...state.candidate.binding,
      actorRef: state.actor.serviceScope.principalId,
      correlationId: state.actor.correlationId,
      operation: state.context.operation,
    }, async (secret) => { await execute(secret); });
  }

  private validateRequest(context: CredentialResolutionContext, actor: CredentialResolutionActor): void {
    if (!validContext(context) || !actor || !isVerifiedServiceTenantScope(actor.serviceScope) ||
        actor.serviceScope.tenantId !== context.tenantId || !UUID.test(actor.serviceScope.principalId) ||
        !UUID.test(actor.correlationId)) {
      throw new CredentialResolutionError('ACCESS_DENIED');
    }
  }

  private async authorize(scope: VerifiedServiceTenantScope, tenantId: string): Promise<void> {
    if (!isVerifiedServiceTenantScope(scope) || scope.tenantId !== tenantId) {
      throw new CredentialResolutionError('INTERNAL_SCOPE_DENIED');
    }
    try {
      await this.authorization.authorize(scope, tenantId);
    } catch {
      throw new CredentialResolutionError('INTERNAL_SCOPE_DENIED');
    }
  }

  private async findPolicy(context: CredentialResolutionContext): Promise<CredentialOperationPolicy> {
    let policy: CredentialOperationPolicy | undefined;
    try {
      policy = await this.policies.findPolicy(context);
    } catch {
      throw new CredentialResolutionError('DEPENDENCY_UNAVAILABLE');
    }
    if (!policy || !validPolicy(context, policy)) throw new CredentialResolutionError('DEPENDENCY_UNAVAILABLE');
    return Object.freeze({
      ...policy,
      assetKinds: Object.freeze([...policy.assetKinds]),
      allowedFamilies: Object.freeze([...policy.allowedFamilies]),
      preferredFamilies: Object.freeze([...policy.preferredFamilies]),
      requiredAssetGrants: Object.freeze([...policy.requiredAssetGrants]),
      requiredAuthorizationScopes: Object.freeze([...policy.requiredAuthorizationScopes]),
      ancestryRules: Object.freeze(policy.ancestryRules.map((rule) => Object.freeze({ ...rule }))),
    });
  }

  private copyCandidate(candidate: CredentialResolutionCandidate): CredentialResolutionCandidate {
    return Object.freeze({
      ...candidate,
      binding: Object.freeze({ ...candidate.binding }),
      lineage: Object.freeze(candidate.lineage.map((step) => Object.freeze({ ...step }))),
      grantedAssetGrants: Object.freeze([...candidate.grantedAssetGrants]),
      grantedAuthorizationScopes: Object.freeze([...candidate.grantedAuthorizationScopes]),
      health: Object.freeze({ ...candidate.health }),
      expiry: Object.freeze({ ...candidate.expiry }),
      dataAccessExpiry: Object.freeze({ ...candidate.dataAccessExpiry }),
    });
  }

  private async inspectAndSelect(context: CredentialResolutionContext, policy: CredentialOperationPolicy): Promise<{
    readonly snapshot: Awaited<ReturnType<CredentialResolutionRepository['inspect']>>;
    readonly selected: EligibleCandidate;
  }> {
    let snapshot: Awaited<ReturnType<CredentialResolutionRepository['inspect']>>;
    try {
      snapshot = await this.repository.inspect(context, policy);
    } catch {
      throw new CredentialResolutionError('DEPENDENCY_UNAVAILABLE');
    }
    if (!snapshot || !Array.isArray(snapshot.candidates) || snapshot.candidates.length > MAX_CANDIDATES) {
      throw new CredentialResolutionError('DEPENDENCY_UNAVAILABLE');
    }
    if (!snapshot.asset) throw new CredentialResolutionError('RESOURCE_NOT_AVAILABLE');
    if (snapshot.asset.assetId !== context.assetId || !UUID.test(snapshot.asset.assetId) || !snapshot.asset.verified ||
        !Number.isSafeInteger(snapshot.asset.version) || snapshot.asset.version < 1) {
      throw new CredentialResolutionError('RESOURCE_NOT_AVAILABLE');
    }
    const now = this.now();
    if (!Number.isFinite(now)) throw new CredentialResolutionError('DEPENDENCY_UNAVAILABLE');
    const eligible = snapshot.candidates
      .map((candidate) => eligibleCandidate(candidate, context, policy, snapshot.asset!, now))
      .filter((candidate): candidate is EligibleCandidate => candidate !== undefined)
      .sort(compareCandidates);
    if (eligible.length === 0) {
      throw new CredentialResolutionError(failureCode(snapshot.candidates, context, policy, context.assetId, now));
    }
    const selected = eligible[0];
    if (!selected) throw new CredentialResolutionError('ASSET_GRANT_MISSING');
    return { snapshot, selected };
  }
}

export class FailClosedCredentialOperationPolicy implements CredentialOperationPolicyPort {
  async findPolicy(): Promise<undefined> { return undefined; }
}

export class FailClosedCredentialResolutionAudit implements CredentialResolutionAuditPort {
  async recordSelection(): Promise<void> { throw new Error('Credential resolution audit is not configured.'); }
}

export class FailClosedCredentialResolutionAuthorization implements CredentialResolutionAuthorizationPort {
  async authorize(): Promise<void> { throw new Error('Credential resolution authorization is not configured.'); }
}

/** Rechecks the current service grant on every resolution and every one-use handle execution. */
export class IdentityCredentialResolutionAuthorization implements CredentialResolutionAuthorizationPort {
  constructor(private readonly serviceAuthorization: ServiceTenantAuthorizationService) {}

  async authorize(scope: VerifiedServiceTenantScope, tenantId: string): Promise<void> {
    await this.serviceAuthorization.authorize(scope, 'CREDENTIAL_USE', tenantId);
  }
}
