import { createPublicKey, type KeyObject } from 'node:crypto';
import { TrustedTicketKeySet } from './ticket-contract.js';

export interface ConfiguredTicketPublicKey {
  readonly kid: string;
  readonly publicKeyPem: string;
}

/** Static server-owned keys only. A ticket header can select a kid but cannot select a URL. */
export class ConfiguredTicketKeySet extends TrustedTicketKeySet {
  private readonly keys: ReadonlyMap<string, KeyObject>;

  constructor(configuredKeys: readonly ConfiguredTicketPublicKey[]) {
    super();
    const keys = new Map<string, KeyObject>();
    for (const configured of configuredKeys) {
      const key = createPublicKey(configured.publicKeyPem);
      if (key.type !== 'public' || key.asymmetricKeyType !== 'rsa') {
        throw new Error('Portal ticket public key configuration is invalid.');
      }
      const modulusLength = key.asymmetricKeyDetails?.modulusLength;
      if (!modulusLength || modulusLength < 2048 || modulusLength > 8192 || keys.has(configured.kid)) {
        throw new Error('Portal ticket public key configuration is invalid.');
      }
      keys.set(configured.kid, key);
    }
    if (keys.size === 0) throw new Error('Portal ticket public key configuration is empty.');
    this.keys = keys;
  }

  async findPublicKey(kid: string): Promise<KeyObject | undefined> {
    return this.keys.get(kid);
  }
}
