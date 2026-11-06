import { createHash, createHmac } from 'node:crypto';
import { IdentityDeniedError } from '../identity/identity.errors.js';
import {
  isVerifiedPlatformIdentityAdmin,
  type VerifiedPlatformIdentityAdmin,
} from '../identity/identity.trust.js';
import { hashMagicLinkEmail } from './magic-link.service.js';
import type { MagicLinkIdentityRevocationReason, MagicLinkIdentityStore } from './magic-link.store.js';

declare const verifiedMagicLinkEmailIdentityBrand: unique symbol;
const verifiedMagicLinkEmailIdentities = new WeakSet<object>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_PROOF_LIFETIME_MS = 15 * 60 * 1000;

/** Runtime-opaque capability issued only by a trusted server-side email proof verifier. */
export interface VerifiedMagicLinkEmailIdentity {
  readonly [verifiedMagicLinkEmailIdentityBrand]: true;
  readonly emailHash: string;
  readonly principalId: string;
  readonly proofReferenceHash: string;
  readonly proofGeneration: number;
  readonly expiresAt: string;
}

export function isVerifiedMagicLinkEmailIdentity(value: unknown): value is VerifiedMagicLinkEmailIdentity {
  return typeof value === 'object' && value !== null && verifiedMagicLinkEmailIdentities.has(value);
}

/**
 * Trusted email-provider adapters subclass this verifier after consuming their own proof and
 * resolving its invitation target from server-side state. The adapter must include the
 * revocation generation captured in the server-side proof-issuance record; it must never accept
 * that value from a caller. This verifier compares the captured value with current state when
 * the proof is consumed. It has no HTTP controller or DTO.
 */
export abstract class MagicLinkEmailProofVerifier {
  protected constructor(
    private readonly recoveryKey: string,
    private readonly generationReader: Pick<MagicLinkIdentityStore, 'readProofGeneration'>,
    private readonly now: () => number = Date.now,
  ) {}

  abstract verifyProof(proofReference: string): Promise<VerifiedMagicLinkEmailIdentity | undefined>;

  protected async issueVerifiedIdentity(input: {
    readonly email: string;
    readonly principalId: string;
    readonly proofReference: string;
    readonly proofGeneration: number;
    readonly expiresAt: string;
  }): Promise<VerifiedMagicLinkEmailIdentity> {
    const expiry = Date.parse(input.expiresAt);
    const now = this.now();
    if (!UUID.test(input.principalId) || typeof input.proofReference !== 'string' ||
      input.proofReference.length < 16 || input.proofReference.length > 512 ||
      /[\u0000-\u001f\u007f]/u.test(input.proofReference) ||
      !Number.isSafeInteger(input.proofGeneration) || input.proofGeneration < 0 ||
      !Number.isFinite(expiry) || expiry <= now || expiry - now > MAX_PROOF_LIFETIME_MS) {
      throw new IdentityDeniedError();
    }
    let emailHash: string;
    try {
      emailHash = hashMagicLinkEmail(input.email, this.recoveryKey);
    } catch {
      throw new IdentityDeniedError();
    }
    const proofReferenceHash = createHmac('sha256', this.recoveryKey)
      .update('ca-meta-magic-link-verified-email-proof-v2\0', 'utf8')
      .update(input.proofReference, 'utf8')
      .digest('hex');
    let currentGeneration: number;
    try {
      currentGeneration = await this.generationReader.readProofGeneration(emailHash);
    } catch {
      throw new IdentityDeniedError();
    }
    if (!Number.isSafeInteger(currentGeneration) || currentGeneration < 0 ||
      currentGeneration !== input.proofGeneration) throw new IdentityDeniedError();
    const result = Object.freeze({
      emailHash,
      principalId: input.principalId,
      proofReferenceHash,
      proofGeneration: input.proofGeneration,
      expiresAt: new Date(expiry).toISOString(),
    }) as VerifiedMagicLinkEmailIdentity;
    verifiedMagicLinkEmailIdentities.add(result);
    return result;
  }
}

/** Internal provisioning service. It accepts no caller-supplied email or tenant values. */
export class MagicLinkIdentityProvisioningService {
  constructor(
    private readonly store: MagicLinkIdentityStore,
    private readonly now: () => number = Date.now,
  ) {}

  async associate(proof: VerifiedMagicLinkEmailIdentity): Promise<void> {
    if (!isVerifiedMagicLinkEmailIdentity(proof) || !UUID.test(proof.principalId) ||
      !SHA256.test(proof.emailHash) || !SHA256.test(proof.proofReferenceHash) ||
      !Number.isSafeInteger(proof.proofGeneration) || proof.proofGeneration < 0 ||
      !Number.isFinite(Date.parse(proof.expiresAt)) || Date.parse(proof.expiresAt) <= this.now()) {
      throw new IdentityDeniedError();
    }
    await this.store.associateVerifiedIdentity({
      emailHash: proof.emailHash,
      principalId: proof.principalId,
      proofReferenceHash: proof.proofReferenceHash,
      proofExpiresAt: proof.expiresAt,
      proofGeneration: proof.proofGeneration,
    });
  }

  async revoke(
    actor: VerifiedPlatformIdentityAdmin,
    emailHash: string,
    principalId: string,
    reasonCode: MagicLinkIdentityRevocationReason,
  ): Promise<void> {
    if (!isVerifiedPlatformIdentityAdmin(actor) || !SHA256.test(emailHash) || !UUID.test(principalId) ||
      (reasonCode !== 'IDENTITY_CORRECTION' && reasonCode !== 'COMPROMISE_REPORTED')) {
      throw new IdentityDeniedError();
    }
    const actorReferenceHash = createHash('sha256')
      .update('ca-meta-platform-identity-admin-v1\0', 'utf8')
      .update(actor.actorRef, 'utf8')
      .digest('hex');
    await this.store.revokeIdentity({ emailHash, principalId, actorReferenceHash, reasonCode });
  }
}
