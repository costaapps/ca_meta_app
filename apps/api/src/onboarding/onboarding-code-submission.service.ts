import { randomUUID, timingSafeEqual } from 'node:crypto';
import { IdentityDeniedError } from '../identity/identity.errors.js';
import { isVerifiedPortalSession, type VerifiedPortalSession } from '../identity/identity.trust.js';
import { TenantAuthorizationService, TenantContextService } from '../identity/identity.service.js';
import { hashOnboardingValue, OnboardingConfigurationUnavailableError, type OnboardingFlowConfigurationResolver, type OnboardingFlowVariant, type OnboardingSessionStore, type OnboardingStoredRecord } from './onboarding-session.types.js';
import { OnboardingCodeProtector } from './onboarding-code-crypto.js';
import { MysqlOnboardingCodeSubmissionStore, type AcceptedOnboardingCode } from './onboarding-code-submission.store.js';
import type { OnboardingSagaAdapter } from './onboarding-saga.types.js';

export const ONBOARDING_CODE_STORE = Symbol('ONBOARDING_CODE_STORE');
export const ONBOARDING_CODE_PROTECTOR = Symbol('ONBOARDING_CODE_PROTECTOR');
export const ONBOARDING_CONFIGURATION_RESOLVER = Symbol('ONBOARDING_CONFIGURATION_RESOLVER');

export interface ProviderAuthorizationCodeInput {
  readonly authorizationCode: string;
  readonly stateRef: string;
}

export type MetaCallbackVariant = 'facebook-login' | 'instagram-via-facebook-login' | 'instagram-login' |
  'whatsapp-cloud-api' | 'whatsapp-coexistence';

export class OnboardingCodeNotFoundError extends Error {
  constructor() { super('The onboarding session is unavailable.'); this.name = 'OnboardingCodeNotFoundError'; }
}

export class OnboardingCodeConflictError extends Error {
  constructor() { super('The provider code submission conflicts with this onboarding.'); this.name = 'OnboardingCodeConflictError'; }
}

export class OnboardingCodeSubmissionService {
  constructor(
    private readonly sessions: OnboardingSessionStore,
    private readonly contexts: TenantContextService,
    private readonly authorization: TenantAuthorizationService,
    private readonly configurations: OnboardingFlowConfigurationResolver,
    private readonly protector: OnboardingCodeProtector,
    private readonly codes: MysqlOnboardingCodeSubmissionStore,
    private readonly adapter: OnboardingSagaAdapter | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async submit(
    session: VerifiedPortalSession,
    tenantContextRef: string,
    onboardingId: string,
    idempotencyKey: string,
    input: ProviderAuthorizationCodeInput,
  ): Promise<AcceptedOnboardingCode> {
    if (!isVerifiedPortalSession(session)) throw new IdentityDeniedError();
    if (!this.adapter) throw new OnboardingConfigurationUnavailableError();
    if (!validIdempotencyKey(idempotencyKey)) throw new OnboardingCodeConflictError();
    const scope = await this.contexts.resolveCurrent(session, tenantContextRef);
    await this.authorization.authorize(scope, 'CONNECT', scope.tenantId);
    const record = await this.sessions.findForSession(onboardingId, session.sessionId, session.principalId);
    if (!record || record.tenantId !== scope.tenantId) throw new OnboardingCodeNotFoundError();
    return this.accept(record, input, hashOnboardingValue(idempotencyKey));
  }

  /** OAuth callback correlation is exclusively by the stored state hash; query tenant fields are ignored. */
  async callback(
    variant: MetaCallbackVariant,
    stateRef: string,
    code: string | undefined,
    providerError: string | undefined,
  ): Promise<{ readonly onboardingId: string }> {
    if (typeof stateRef !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(stateRef)) {
      throw new OnboardingCodeNotFoundError();
    }
    const stateHash = hashOnboardingValue(stateRef);
    const record = await this.sessions.findByProviderStateHash(stateHash);
    if (!record || !callbackVariantMatchesProfile(variant, record.flowVariant, record.authVariant)) throw new OnboardingCodeNotFoundError();

    // Provider cancellation/error is terminal before any code or config processing.
    if (providerError !== undefined || code === undefined || code === '') {
      const cancelled = await this.sessions.cancelByProviderState(stateHash);
      if (!cancelled && record.status === 'AWAITING_PROVIDER' && !record.stateConsumed) throw new OnboardingCodeConflictError();
      return Object.freeze({ onboardingId: record.id });
    }
    if (typeof code !== 'string' || Buffer.byteLength(code, 'utf8') > 16_384) throw new OnboardingCodeConflictError();
    if (!this.adapter) throw new OnboardingConfigurationUnavailableError();
    const deterministicCallbackKey = hashOnboardingValue(`meta-callback\0${record.id}`);
    const input = Object.freeze({ authorizationCode: code, stateRef });
    await this.accept(record, input, deterministicCallbackKey);
    return Object.freeze({ onboardingId: record.id });
  }

  private async accept(
    record: OnboardingStoredRecord,
    input: ProviderAuthorizationCodeInput,
    idempotencyHash: string,
  ): Promise<AcceptedOnboardingCode> {
    if (record.expiresAt.getTime() <= this.now().getTime() || ['CANCELLED', 'EXPIRED', 'FAILED'].includes(record.status) ||
      typeof input.stateRef !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(input.stateRef)) throw new OnboardingCodeConflictError();
    const expected = Buffer.from(record.providerStateHash, 'hex');
    const actual = Buffer.from(hashOnboardingValue(input.stateRef), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new OnboardingCodeConflictError();
    const configuration = this.configurations.resolve(record.flowVariant);
    if (!configuration || configuration.configurationRef !== record.configurationRef ||
      configuration.authVariant !== record.authVariant ||
      configuration.capabilityManifestVersion !== record.capabilityManifestVersion ||
      configuration.graphApiVersion !== record.graphApiVersion) throw new OnboardingConfigurationUnavailableError();

    const codeContext = Object.freeze({
      tenantId: record.tenantId,
      onboardingId: record.id,
      flowVariant: record.flowVariant,
      authVariant: record.authVariant,
      configurationRef: record.configurationRef,
    });
    const sealedCode = this.protector.seal(codeContext, input.authorizationCode);
    const requestHash = hashOnboardingValue(JSON.stringify({
      onboardingId: record.id,
      flowVariant: record.flowVariant,
      configurationRef: record.configurationRef,
      stateHash: record.providerStateHash,
      codeHash: sealedCode.codeHash,
    }));
    return this.codes.accept({
      record,
      codeRef: randomUUID(),
      idempotencyHash,
      requestHash,
      sealedCode,
      principalId: record.principalId,
      portalSessionId: record.portalSessionId,
    });
  }

}

export function callbackVariantMatchesProfile(
  variant: MetaCallbackVariant,
  flow: OnboardingFlowVariant,
  authVariant: OnboardingStoredRecord['authVariant'],
): boolean {
  switch (variant) {
    case 'facebook-login': return flow === 'FACEBOOK_LOGIN' && authVariant === 'FACEBOOK_LOGIN_FOR_BUSINESS';
    case 'instagram-via-facebook-login': return flow === 'INSTAGRAM_VIA_FACEBOOK_LOGIN' && authVariant === 'INSTAGRAM_VIA_FACEBOOK_LOGIN';
    case 'instagram-login': return flow === 'INSTAGRAM_LOGIN' && authVariant === 'INSTAGRAM_LOGIN';
    case 'whatsapp-cloud-api': return flow === 'WHATSAPP_CLOUD_API' && authVariant === 'WHATSAPP_EMBEDDED_SIGNUP';
    case 'whatsapp-coexistence': return flow === 'WHATSAPP_COEXISTENCE' && authVariant === 'WHATSAPP_BUSINESS_APP_ONBOARDING';
  }
}

function validIdempotencyKey(value: string): boolean { return /^[A-Za-z0-9._~-]{16,128}$/.test(value); }
