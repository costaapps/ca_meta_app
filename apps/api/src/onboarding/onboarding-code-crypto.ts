import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OnboardingFlowVariant } from './onboarding-session.types.js';
import { OnboardingConfigurationUnavailableError } from './onboarding-session.types.js';

export interface OnboardingCodeContext {
  readonly tenantId: string;
  readonly onboardingId: string;
  readonly flowVariant: OnboardingFlowVariant;
  readonly authVariant: string;
  readonly configurationRef: string;
}

export interface SealedOnboardingCode {
  readonly codeHash: string;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly authenticationTag: Buffer;
}

/** Short-lived authorization codes use a purpose-derived key and AES-GCM AAD scoped to one onboarding. */
export class OnboardingCodeProtector {
  private readonly key?: Buffer;

  constructor(encodedStateKey: string | undefined) {
    if (!encodedStateKey) return;
    let master: Buffer;
    try { master = Buffer.from(encodedStateKey, 'base64url'); } catch { return; }
    if (master.length !== 32 || master.toString('base64url') !== encodedStateKey) return;
    this.key = Buffer.from(hkdfSync(
      'sha256', master, Buffer.from('ca-meta-onboarding-code-v1', 'utf8'),
      Buffer.from('authorization-code-envelope-v1', 'utf8'), 32,
    ));
    master.fill(0);
  }

  seal(context: OnboardingCodeContext, code: string): SealedOnboardingCode {
    if (!this.key) throw new OnboardingConfigurationUnavailableError();
    if (typeof code !== 'string' || code.length < 1 || code.length > 16_384 || Buffer.byteLength(code, 'utf8') > 16_384 || /[\u0000-\u001f\u007f]/.test(code)) {
      throw new OnboardingCodeInvalidError();
    }
    const codeHash = createHash('sha256').update(code, 'utf8').digest('hex');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad(context, codeHash));
    const ciphertext = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
    return Object.freeze({ codeHash, nonce, ciphertext, authenticationTag: cipher.getAuthTag() });
  }

  open(context: OnboardingCodeContext, envelope: SealedOnboardingCode): string {
    if (!this.key || !/^[a-f0-9]{64}$/.test(envelope.codeHash) || envelope.nonce.length !== 12 ||
      envelope.authenticationTag.length !== 16 || envelope.ciphertext.length < 1 || envelope.ciphertext.length > 16_384) {
      throw new OnboardingCodeIntegrityError();
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, envelope.nonce, { authTagLength: 16 });
      decipher.setAAD(aad(context, envelope.codeHash));
      decipher.setAuthTag(envelope.authenticationTag);
      const plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
      const actualHash = createHash('sha256').update(plaintext).digest();
      const expectedHash = Buffer.from(envelope.codeHash, 'hex');
      if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) {
        plaintext.fill(0);
        throw new OnboardingCodeIntegrityError();
      }
      const value = plaintext.toString('utf8');
      plaintext.fill(0);
      return value;
    } catch {
      throw new OnboardingCodeIntegrityError();
    }
  }
}

function aad(context: OnboardingCodeContext, codeHash: string): Buffer {
  return Buffer.from(JSON.stringify({
    schema: 1,
    tenantId: context.tenantId,
    onboardingId: context.onboardingId,
    flowVariant: context.flowVariant,
    authVariant: context.authVariant,
    configurationRef: context.configurationRef,
    codeHash,
  }), 'utf8');
}

export class OnboardingCodeInvalidError extends Error {
  constructor() { super('The provider authorization code is invalid.'); this.name = 'OnboardingCodeInvalidError'; }
}

export class OnboardingCodeIntegrityError extends Error {
  constructor() { super('The provider authorization code could not be recovered.'); this.name = 'OnboardingCodeIntegrityError'; }
}
