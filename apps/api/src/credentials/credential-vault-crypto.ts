import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CredentialVaultIntegrityError } from './credential-vault.errors.js';
import type { CredentialBinding, CredentialKeyProvider, EncryptedCredential } from './credential-vault.types.js';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_SECRET_BYTES = 16 * 1024;

function associatedData(binding: CredentialBinding, keyVersion: string): Buffer {
  return Buffer.from(JSON.stringify([
    'ca-meta-credential-vault', 1, keyVersion, binding.tenantId, binding.credentialId,
    binding.authorizationId, binding.appConfigurationId, binding.provider, binding.environment, binding.family,
  ]), 'utf8');
}

/** AES-256-GCM with a fresh 96-bit nonce and canonical binding-specific AAD. */
export function encryptCredential(
  binding: CredentialBinding,
  secret: string,
  keyVersion: string,
  keyProvider: CredentialKeyProvider,
): EncryptedCredential {
  if (typeof secret !== 'string' || secret.length === 0 || Buffer.byteLength(secret, 'utf8') > MAX_SECRET_BYTES) {
    throw new CredentialVaultIntegrityError();
  }
  const key = keyProvider.keyFor(keyVersion);
  if (!key || key.length !== KEY_BYTES) {
    key?.fill(0);
    throw new CredentialVaultIntegrityError();
  }
  const nonce = randomBytes(NONCE_BYTES);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(associatedData(binding, keyVersion));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Object.freeze({
      ciphertext,
      nonce,
      authenticationTag: cipher.getAuthTag(),
      keyVersion,
      formatVersion: 1,
    });
  } finally {
    key.fill(0);
  }
}

export function decryptCredential(
  binding: CredentialBinding,
  envelope: EncryptedCredential,
  key: Buffer,
): string {
  if (key.length !== KEY_BYTES || envelope.formatVersion !== 1 || envelope.nonce.length !== NONCE_BYTES ||
      envelope.authenticationTag.length !== TAG_BYTES || envelope.ciphertext.length > MAX_SECRET_BYTES) {
    key.fill(0);
    throw new CredentialVaultIntegrityError();
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(associatedData(binding, envelope.keyVersion));
    decipher.setAuthTag(envelope.authenticationTag);
    const plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
    if (plaintext.length === 0 || plaintext.length > MAX_SECRET_BYTES) {
      plaintext.fill(0);
      throw new CredentialVaultIntegrityError();
    }
    const result = plaintext.toString('utf8');
    plaintext.fill(0);
    return result;
  } catch {
    throw new CredentialVaultIntegrityError();
  } finally {
    key.fill(0);
  }
}
