import { createHash, timingSafeEqual } from 'node:crypto';
import { ServiceCredentialVerifier } from './identity.trust.js';
import type { InternalServiceCredentialHash } from './identity.trust.js';
import type { VerifiedServiceCredential } from './identity.trust.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Runtime service proof verifier. Configuration contains only hashes and binds each proof to a
 * single tenant and principal; current tenant scopes are still resolved from the identity store.
 */
export class ConfiguredServiceCredentialVerifier extends ServiceCredentialVerifier {
  private readonly credentials: readonly {
    readonly principalId: string;
    readonly tenantId: string;
    readonly digest: Buffer;
  }[];

  constructor(credentials: readonly InternalServiceCredentialHash[] = []) {
    super();
    this.credentials = Object.freeze(credentials.map((entry) => {
      if (!entry || !UUID.test(entry.principalId) || !UUID.test(entry.tenantId) ||
          !/^[a-f0-9]{64}$/.test(entry.credentialSha256)) {
        throw new Error('Internal service credential configuration is malformed.');
      }
      return Object.freeze({
        principalId: entry.principalId.toLowerCase(),
        tenantId: entry.tenantId.toLowerCase(),
        digest: Buffer.from(entry.credentialSha256, 'hex'),
      });
    }));
  }

  async verifyCredential(credential: string | undefined): Promise<VerifiedServiceCredential | undefined> {
    if (typeof credential !== 'string' || Buffer.byteLength(credential, 'utf8') < 32 ||
        Buffer.byteLength(credential, 'utf8') > 512 || /[\r\n\u0000]/.test(credential)) return undefined;
    const candidate = createHash('sha256').update(credential, 'utf8').digest();
    let match: { readonly principalId: string; readonly tenantId: string } | undefined;
    for (const configured of this.credentials) {
      if (timingSafeEqual(candidate, configured.digest)) match = configured;
    }
    candidate.fill(0);
    return match ? this.issueVerifiedServiceCredential(match.principalId, match.tenantId) : undefined;
  }
}
