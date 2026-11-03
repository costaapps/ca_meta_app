import type { CredentialBinding } from './credential-vault.types.js';
import type { MetaAuthVariant, MetaFlowVariant } from './credential-resolver.types.js';

export type LifecycleHealthState = 'VALID' | 'HEALTHY' | 'EXPIRING' | 'EXPIRED' | 'REVOKED' | 'ACTION_REQUIRED';
export type LifecycleReasonCode = 'NONE' | 'TOKEN_EXPIRED' | 'ACCESS_EXPIRED' | 'PERMISSION_REVOKED' | 'REAUTH_REQUIRED';
export type LifecycleExpiryState = 'KNOWN' | 'PROVIDER_NO_EXPIRY' | 'UNKNOWN';

/** Normalized, validated allowlist. Provider payloads never cross this port. */
export interface CredentialInspectionObservation {
  readonly health: LifecycleHealthState;
  readonly issuedAt: string | null;
  readonly expiryState: LifecycleExpiryState;
  readonly expiresAt: string | null;
  readonly dataAccessExpiresAt: string | null;
  readonly reasonCode: LifecycleReasonCode;
}

export interface CredentialLifecycleFamilyPolicy {
  readonly flowVariant: MetaFlowVariant | null;
  readonly authVariant: MetaAuthVariant | null;
  readonly family: string;
  readonly inspectEnabled: boolean;
  /** An exact flow/auth/family capability may opt into injected renewal; no Meta family is enabled in production. */
  readonly refreshEnabled: boolean;
  readonly createReauthIntent: boolean;
  /** Safe server-owned impact class used with authorizationId to coalesce affected credentials. */
  readonly reauthImpactKey: string | null;
  /** Operational check cadence, independent of provider token lifetime. */
  readonly checkIntervalSeconds: number;
  readonly jitterPercent: number;
}

export interface CredentialInspectionBinding extends CredentialBinding {
  readonly flowVariant: MetaFlowVariant;
  readonly authVariant: MetaAuthVariant;
  readonly credentialVersion: number;
  readonly secretVersion: number;
  readonly authorizationVersion: number;
  readonly lifecycleVersion: number;
  readonly generation: number;
  readonly leaseOwner: string;
  readonly leaseToken: string;
}

export interface CredentialLifecyclePolicyPort {
  forCredential(flowVariant: MetaFlowVariant, authVariant: MetaAuthVariant, family: string): CredentialLifecycleFamilyPolicy | undefined;
}

/** The adapter receives plaintext only inside this callback and must not return or log it. */
export interface CredentialLifecycleSecretPort {
  withCredential(binding: CredentialBinding, execute: (secret: string) => Promise<void>): Promise<void>;
  replaceCredentialWithin(manager: import('typeorm').EntityManager, binding: CredentialBinding,
    fence: CredentialInspectionBinding, replacementSecret: string): Promise<boolean>;
}

/** A provider adapter must validate its response before returning this allowlisted shape. */
export interface CredentialInspectionPort {
  inspect(binding: CredentialInspectionBinding, secret: string, signal: AbortSignal): Promise<CredentialInspectionObservation>;
}

/** Family-specific adapter. No endpoint or exchange recipe is provided by this port. */
export interface CredentialRenewalPort {
  renew(binding: CredentialInspectionBinding, currentSecret: string, signal: AbortSignal): Promise<{
    readonly replacementSecret: string;
    readonly observation: CredentialInspectionObservation;
  } | undefined>;
}

export const DEFAULT_CREDENTIAL_LIFECYCLE_POLICY: CredentialLifecycleFamilyPolicy = Object.freeze({
  flowVariant: null, authVariant: null, family: 'UNCONFIGURED', inspectEnabled: false, refreshEnabled: false, createReauthIntent: false,
  reauthImpactKey: null,
  checkIntervalSeconds: 86_400, jitterPercent: 20,
});
