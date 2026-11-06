import { createHmac, randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import type { components } from '@ca-meta/contracts';
import type { MetaAuthenticationVariant, MetaProductFlow } from '../meta-config/capability-manifest.js';
import { IdentityDeniedError } from '../identity/identity.errors.js';
import { isVerifiedPortalSession, type VerifiedPortalSession } from '../identity/identity.trust.js';
import { TenantAuthorizationService, TenantContextService } from '../identity/identity.service.js';
import {
  hashOnboardingValue,
  isTrustedOnboardingProviderOutcome,
  OnboardingConfigurationUnavailableError,
  OnboardingConflictError,
  type OnboardingCompletionPort,
  type OnboardingCreateInput,
  type OnboardingCreated,
  type OnboardingFlowConfigurationResolver,
  type OnboardingProviderLaunchPort,
  type OnboardingProviderOutcome,
  type OnboardingSessionStore,
  type OnboardingStatus,
  type OnboardingStoredRecord,
} from './onboarding-session.types.js';

export const ONBOARDING_STATE_TTL_SECONDS = 600;

/** HMAC-derived, opaque state makes idempotent launch replay possible without storing the state value. */
export class OnboardingStateSigner {
  private readonly key?: Buffer;

  constructor(encodedKey: string | undefined) {
    if (!encodedKey) return;
    let key: Buffer;
    try {
      key = Buffer.from(encodedKey, 'base64url');
    } catch {
      throw new Error('The onboarding state signing key is invalid.');
    }
    if (key.length !== 32 || key.toString('base64url') !== encodedKey) {
      throw new Error('The onboarding state signing key is invalid.');
    }
    this.key = key;
  }

  issue(input: {
    readonly tenantId: string;
    readonly tenantContextHash: string;
    readonly principalId: string;
    readonly sessionId: string;
    readonly idempotencyHash: string;
    readonly requestHash: string;
    readonly onboardingId: string;
    readonly configurationRef: string;
  }): string {
    if (!this.key) throw new OnboardingConfigurationUnavailableError();
    return createHmac('sha256', this.key)
      .update('ca-meta-onboarding-state-v1\0', 'utf8')
      .update(input.tenantId, 'utf8').update('\0')
      .update(input.tenantContextHash, 'utf8').update('\0')
      .update(input.principalId, 'utf8').update('\0')
      .update(input.sessionId, 'utf8').update('\0')
      .update(input.idempotencyHash, 'utf8').update('\0')
      .update(input.requestHash, 'utf8').update('\0')
      .update(input.onboardingId, 'utf8').update('\0')
      .update(input.configurationRef, 'utf8')
      .digest('base64url');
  }
}

export class UnavailableOnboardingProviderLaunch implements OnboardingProviderLaunchPort {
  async buildAuthorizationUrl(): Promise<string> {
    throw new OnboardingConfigurationUnavailableError();
  }
}

export class OnboardingSessionService {
  constructor(
    private readonly store: OnboardingSessionStore,
    private readonly contexts: TenantContextService,
    private readonly authorization: TenantAuthorizationService,
    private readonly stateSigner: OnboardingStateSigner,
    private readonly providerLaunch: OnboardingProviderLaunchPort,
    private readonly now: () => Date = () => new Date(),
    private readonly configurations?: OnboardingFlowConfigurationResolver,
  ) {}

  async create(
    session: VerifiedPortalSession,
    tenantContextRef: string,
    idempotencyKey: string,
    input: OnboardingCreateInput,
  ): Promise<Omit<OnboardingCreated, 'requestId'>> {
    if (!isVerifiedPortalSession(session) || !validIdempotencyKey(idempotencyKey)) throw new IdentityDeniedError();
    const scope = await this.contexts.resolveCurrent(session, tenantContextRef);
    await this.authorization.authorize(scope, 'CONNECT', scope.tenantId);

    const normalized = normalizeCreateInput(input);
    const configuration = this.configurations?.resolve(normalized.flowVariant);
    if (!configuration) throw new OnboardingConfigurationUnavailableError();
    const idempotencyHash = hashOnboardingValue(idempotencyKey);
    const requestHash = hashOnboardingValue(JSON.stringify(normalized));
    let record = await this.store.findByIdempotency(scope.tenantId, idempotencyHash);
    if (record) {
      if (record.requestHash !== requestHash || record.principalId !== session.principalId ||
        record.portalSessionId !== session.sessionId || record.configurationRef !== configuration.configurationRef ||
        record.authVariant !== configuration.authVariant || record.capabilityManifestVersion !== configuration.capabilityManifestVersion ||
        record.graphApiVersion !== configuration.graphApiVersion) throw new OnboardingConflictError();
      if (record.stateConsumed || record.status !== 'AWAITING_PROVIDER') throw new OnboardingConflictError();
    } else {
      const createdAt = this.now();
      if (!Number.isFinite(createdAt.getTime())) throw new Error('The onboarding clock returned an invalid time.');
      const id = randomUUID();
      const stateRef = this.stateSigner.issue({
        tenantId: scope.tenantId,
        tenantContextHash: session.contextRefHash,
        principalId: session.principalId,
        sessionId: session.sessionId,
        idempotencyHash,
        requestHash,
        onboardingId: id,
        configurationRef: configuration.configurationRef,
      });
      const command = {
        id,
        tenantId: scope.tenantId,
        principalId: session.principalId,
        portalSessionId: session.sessionId,
        tenantContextHash: session.contextRefHash,
        createdAt,
        flowVariant: normalized.flowVariant,
        configurationRef: configuration.configurationRef,
        authVariant: configuration.authVariant,
        capabilityManifestVersion: configuration.capabilityManifestVersion,
        graphApiVersion: configuration.graphApiVersion,
        requestedCapabilities: normalized.requestedCapabilities,
        returnRoute: normalized.returnRoute,
        idempotencyHash,
        requestHash,
        providerStateHash: hashOnboardingValue(stateRef),
        expiresAt: new Date(createdAt.getTime() + ONBOARDING_STATE_TTL_SECONDS * 1000),
      } as const;
      record = await this.store.createOrReplay(command);
      if (record.requestHash !== requestHash || record.principalId !== session.principalId ||
        record.portalSessionId !== session.sessionId || record.configurationRef !== configuration.configurationRef ||
        record.authVariant !== configuration.authVariant || record.capabilityManifestVersion !== configuration.capabilityManifestVersion ||
        record.graphApiVersion !== configuration.graphApiVersion) throw new OnboardingConflictError();
    }

    // Do not re-issue an expired deterministic state if a client retries after the
    // ten-minute correlation period. Status reads also persist EXPIRED in MySQL.
    if (record.expiresAt.getTime() <= this.now().getTime()) throw new OnboardingConflictError();

    const stateRef = this.stateSigner.issue({
      tenantId: record.tenantId,
      tenantContextHash: record.tenantContextHash,
      principalId: record.principalId,
      sessionId: record.portalSessionId,
      idempotencyHash: record.idempotencyHash,
      requestHash: record.requestHash,
      onboardingId: record.id,
      configurationRef: record.configurationRef,
    });
    if (hashOnboardingValue(stateRef) !== record.providerStateHash) throw new OnboardingConfigurationUnavailableError();

    let launchUrl: string;
    try {
      launchUrl = await this.providerLaunch.buildAuthorizationUrl({
        flowVariant: record.flowVariant,
        stateRef,
        returnRoute: record.returnRoute,
        expiresAt: record.expiresAt.toISOString(),
      });
      assertProviderLaunchUrl(launchUrl, stateRef);
    } catch (error) {
      if (error instanceof OnboardingConfigurationUnavailableError || error instanceof OnboardingConflictError) throw error;
      throw new OnboardingConfigurationUnavailableError();
    }

    return Object.freeze({
      id: record.id,
      status: 'AWAITING_PROVIDER',
      expiresAt: record.expiresAt.toISOString(),
      launchUrl,
    });
  }

  async read(
    session: VerifiedPortalSession,
    onboardingId: string,
    currentTenantContextRef: string,
  ): Promise<OnboardingStatus | undefined> {
    if (!isVerifiedPortalSession(session)) throw new IdentityDeniedError();
    const record = await this.store.findForSession(onboardingId, session.sessionId, session.principalId);
    if (!record) return undefined;

    try {
      // Resolve the immutable starting tenant through the current session, even after a tenant switch.
      const scope = await this.contexts.resolveTenantSwitch(session, currentTenantContextRef, record.tenantId);
      await this.authorization.authorize(scope, 'CONNECT', record.tenantId);
    } catch (error) {
      if (error instanceof IdentityDeniedError) throw error;
      throw new ForbiddenException();
    }

    return Object.freeze({
      id: record.id,
      flowVariant: record.flowVariant,
      status: record.status,
      readiness: record.readiness,
      steps: Object.freeze(record.steps.map((step) => Object.freeze({ ...step }))),
      nextAction: record.nextAction,
      lastUpdatedAt: record.lastUpdatedAt.toISOString(),
    });
  }
}

export function metaProfileForOnboardingFlow(flowVariant: OnboardingFlowVariant): {
  readonly flowVariant: MetaProductFlow;
  readonly authVariant: MetaAuthenticationVariant;
} {
  switch (flowVariant) {
    case 'FACEBOOK_LOGIN': return { flowVariant: 'FACEBOOK', authVariant: 'FACEBOOK_LOGIN_FOR_BUSINESS' };
    case 'INSTAGRAM_VIA_FACEBOOK_LOGIN': return { flowVariant: 'INSTAGRAM', authVariant: 'INSTAGRAM_VIA_FACEBOOK_LOGIN' };
    case 'INSTAGRAM_LOGIN': return { flowVariant: 'INSTAGRAM', authVariant: 'INSTAGRAM_LOGIN' };
    case 'WHATSAPP_CLOUD_API': return { flowVariant: 'WHATSAPP_EXCLUSIVE', authVariant: 'WHATSAPP_EMBEDDED_SIGNUP' };
    case 'WHATSAPP_COEXISTENCE': return { flowVariant: 'WHATSAPP_COEXISTENCE', authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING' };
  }
}

export class OnboardingCompletionService implements OnboardingCompletionPort {
  constructor(private readonly store: OnboardingSessionStore) {}

  async complete(outcome: OnboardingProviderOutcome): Promise<boolean> {
    if (!isTrustedOnboardingProviderOutcome(outcome) || !validProviderOutcome(outcome)) {
      throw new ForbiddenException();
    }
    return this.store.completeByProviderState(hashOnboardingValue(outcome.stateRef), outcome);
  }
}

function normalizeCreateInput(input: OnboardingCreateInput): OnboardingCreateInput {
  if (!input || !FLOW_VARIANTS.includes(input.flowVariant) ||
    !Array.isArray(input.requestedCapabilities) || input.requestedCapabilities.length > 32 ||
    new Set(input.requestedCapabilities).size !== input.requestedCapabilities.length ||
    input.requestedCapabilities.some((value) => typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) ||
    (input.returnRoute !== 'connections' && input.returnRoute !== 'setup')) throw new OnboardingConflictError();
  return Object.freeze({
    flowVariant: input.flowVariant,
    requestedCapabilities: Object.freeze([...input.requestedCapabilities].sort()),
    returnRoute: input.returnRoute,
  });
}

const FLOW_VARIANTS: readonly components['schemas']['FlowVariant'][] = [
  'FACEBOOK_LOGIN', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN', 'WHATSAPP_CLOUD_API', 'WHATSAPP_COEXISTENCE',
];

function validIdempotencyKey(value: string): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{16,128}$/.test(value);
}

function assertProviderLaunchUrl(value: string, stateRef: string): void {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new OnboardingConfigurationUnavailableError(); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash ||
    parsed.searchParams.getAll('state').length !== 1 || parsed.searchParams.get('state') !== stateRef) {
    throw new OnboardingConfigurationUnavailableError();
  }
}

function validProviderOutcome(outcome: OnboardingProviderOutcome): boolean {
  const stepStatuses = new Set(['PENDING', 'RUNNING', 'SUCCEEDED', 'RETRY_PENDING', 'FAILED', 'UNKNOWN', 'SKIPPED']);
  if (typeof outcome.stateRef !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(outcome.stateRef) ||
    !Array.isArray(outcome.steps) || outcome.steps.length > 32 ||
    !['CREATED', 'AWAITING_PROVIDER', 'CODE_RECEIVED', 'EXCHANGING', 'ASSETS_VERIFIED', 'PROVISIONING', 'READY', 'PARTIAL', 'CANCELLED', 'EXPIRED', 'FAILED'].includes(outcome.status) ||
    !['READY', 'PARTIAL', 'UNKNOWN'].includes(outcome.readiness) ||
    !['WAIT', 'CHECK_STATUS', 'REAUTHORIZE', 'RECONCILE', 'RESUME', 'RESOLVE_CONFLICT', 'NONE'].includes(outcome.nextAction) ||
    !outcome.steps.every((step) => typeof step?.name === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(step.name) &&
      stepStatuses.has(step.status) && Object.keys(step).every((key) => key === 'name' || key === 'status'))) return false;
  const hasSuccessfulStep = (name: string) => outcome.steps.some((step) => step.name === name && step.status === 'SUCCEEDED');
  if (outcome.status === 'READY') return outcome.readiness === 'READY' && hasSuccessfulStep('authorization') &&
    hasSuccessfulStep('asset-verification') && hasSuccessfulStep('subscription') && hasSuccessfulStep('projection') &&
    Array.isArray(outcome.verifiedAssetRefs) && outcome.verifiedAssetRefs.length > 0 &&
    outcome.subscriptionVerified === true && outcome.projectionVerified === true && outcome.nextAction === 'NONE';
  if (outcome.status === 'PARTIAL') return outcome.readiness === 'PARTIAL' &&
    ['REAUTHORIZE', 'RECONCILE', 'RESUME', 'CHECK_STATUS'].includes(outcome.nextAction);
  if (outcome.status === 'PROVISIONING') return outcome.readiness === 'UNKNOWN' && outcome.nextAction === 'CHECK_STATUS';
  if (outcome.status === 'FAILED' || outcome.status === 'EXPIRED' || outcome.status === 'CANCELLED') {
    return outcome.readiness === 'UNKNOWN' && outcome.nextAction === 'NONE';
  }
  return false;
}
