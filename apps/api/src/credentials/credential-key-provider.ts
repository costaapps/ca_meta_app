import type { CredentialKeyRingConfiguration } from '../config/environment.js';
import type { CredentialKeyProvider } from './credential-vault.types.js';

/** Runtime-only key ring. The returned bytes are copies so callers can clear temporary key material. */
export class ConfiguredCredentialKeyProvider implements CredentialKeyProvider {
  constructor(private readonly configuration?: CredentialKeyRingConfiguration) {}

  activeVersion(): string | undefined {
    return this.configuration?.activeVersion();
  }

  keyFor(version: string): Buffer | undefined {
    return this.configuration?.keyFor(version);
  }
}
