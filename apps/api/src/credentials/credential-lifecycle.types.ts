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
  /** M3.09 has no renewal job; false is a type-level guard against enabling refresh in inspection. */
  readonly refreshEnabled: false;
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

export interface CredentialReauthIntentView {
  readonly intentRef: string;
  readonly authorizationRef: string;
  readonly flowVariant: MetaFlowVariant | null;
  readonly authVariant: MetaAuthVariant | null;
  readonly impactKey: string;
  readonly reasonCode: string;
  readonly status: 'PENDING' | 'ACKNOWLEDGED';
  readonly occurrences: number;
  readonly updatedAt: string;
}

export interface CredentialReauthIntentPage {
  readonly items: readonly CredentialReauthIntentView[];
  readonly nextAfterRef: string | null;
}

export interface CredentialReauthAffectedAssetView {
  readonly credentialRef: string;
  readonly assetRef: string;
  readonly assetKind: string;
  readonly family: string;
  readonly reasonCode: string;
}

export interface CredentialReauthAffectedAssetPage {
  readonly items: readonly CredentialReauthAffectedAssetView[];
  readonly nextAfterAssetRef: string | null;
}

/** The adapter receives plaintext only inside this callback and must not return or log it. */
export interface CredentialLifecycleSecretPort {
  withCredential(binding: CredentialBinding, execute: (secret: string) => Promise<void>): Promise<void>;
}

/** A provider adapter must validate its response before returning this allowlisted shape. */
export interface CredentialInspectionPort {
  inspect(binding: CredentialInspectionBinding, secret: string, signal: AbortSignal): Promise<CredentialInspectionObservation>;
}

/** Future renewal requires a separate CREDENTIAL_RENEWAL durable job with AMBIGUOUS effect mode and CAS finalization. */

export const DEFAULT_CREDENTIAL_LIFECYCLE_POLICY: CredentialLifecycleFamilyPolicy = Object.freeze({
  flowVariant: null, authVariant: null, family: 'UNCONFIGURED', inspectEnabled: false, refreshEnabled: false, createReauthIntent: false,
  reauthImpactKey: null,
  checkIntervalSeconds: 86_400, jitterPercent: 20,
});
