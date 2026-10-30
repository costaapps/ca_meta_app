import { createHash, verify as verifySignature, type KeyObject } from 'node:crypto';
import {
  IdentityAssertionVerifier,
  type VerifiedIdentityAssertion,
} from '../identity/identity.trust.js';
import {
  TrustedTicketKeySetUnavailableError,
  type TicketExchangeConfiguration,
  type TrustedTicketKeySet,
} from './ticket-contract.js';

const ALLOWED_ALGORITHM = 'RS256';
const MAX_TICKET_LENGTH = 8192;
const MAX_HEADER_BYTES = 2048;
const MAX_CLAIMS_BYTES = 4096;
const MAX_SIGNATURE_BYTES = 1024;

export class RejectedTicketError extends Error {
  constructor() {
    super('The entry ticket was rejected.');
    this.name = 'RejectedTicketError';
  }
}

export interface ValidatedEntryTicket {
  readonly assertion: VerifiedIdentityAssertion;
  readonly requestedTenantId: string;
  readonly ticketJtiSha256: string;
  readonly ticketExpiresAt: Date;
  readonly ticketChallengeSha256: string;
}

interface JwtHeader {
  readonly alg: string;
  readonly kid: string;
  readonly typ?: string;
}

interface EntryClaims {
  readonly iss: string;
  readonly aud: string | readonly string[];
  readonly sub: string;
  readonly tenant: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
  readonly preauth_challenge: string;
  readonly roles: unknown;
  readonly nbf?: number;
}

class AssertionIssuer extends IdentityAssertionVerifier {
  issue(issuer: string, subject: string): VerifiedIdentityAssertion {
    return this.issueVerifiedAssertion(issuer, subject);
  }
}

function invalid(): never {
  throw new RejectedTicketError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeBase64Url(segment: string, maximumBytes: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment) || segment.length % 4 === 1) return invalid();
  const decoded = Buffer.from(segment, 'base64url');
  if (decoded.length === 0 || decoded.length > maximumBytes || decoded.toString('base64url') !== segment) return invalid();
  return decoded;
}

function decodeUtf8Strict(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return invalid();
  }
}

/** Parse JSON while rejecting duplicate keys and prototype-bearing output. */
function parseJsonStrict(source: string): unknown {
  let offset = 0;
  let nodes = 0;

  const skipWhitespace = (): void => {
    while (offset < source.length && (source[offset] === ' ' || source[offset] === '\n' || source[offset] === '\r' || source[offset] === '\t')) {
      offset += 1;
    }
  };

  const parseString = (): string => {
    if (source[offset] !== '"') return invalid();
    const start = offset;
    offset += 1;
    while (offset < source.length) {
      const character = source[offset];
      if (character === '"') {
        offset += 1;
        try {
          const parsed: unknown = JSON.parse(source.slice(start, offset));
          if (typeof parsed !== 'string') return invalid();
          return parsed;
        } catch {
          return invalid();
        }
      }
      if (character === '\\') {
        offset += 2;
      } else {
        if (character.charCodeAt(0) < 0x20) return invalid();
        offset += 1;
      }
    }
    return invalid();
  };

  const parseValue = (depth: number): unknown => {
    nodes += 1;
    if (nodes > 512 || depth > 12) return invalid();
    skipWhitespace();
    const character = source[offset];
    if (character === '"') return parseString();
    if (character === '{') {
      offset += 1;
      skipWhitespace();
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const seen = new Set<string>();
      if (source[offset] === '}') {
        offset += 1;
        return result;
      }
      while (offset < source.length) {
        skipWhitespace();
        const key = parseString();
        if (seen.has(key)) return invalid();
        seen.add(key);
        if (seen.size > 128) return invalid();
        skipWhitespace();
        if (source[offset] !== ':') return invalid();
        offset += 1;
        result[key] = parseValue(depth + 1);
        skipWhitespace();
        if (source[offset] === '}') {
          offset += 1;
          return result;
        }
        if (source[offset] !== ',') return invalid();
        offset += 1;
      }
      return invalid();
    }
    if (character === '[') {
      offset += 1;
      skipWhitespace();
      const result: unknown[] = [];
      if (source[offset] === ']') {
        offset += 1;
        return result;
      }
      while (offset < source.length) {
        result.push(parseValue(depth + 1));
        if (result.length > 128) return invalid();
        skipWhitespace();
        if (source[offset] === ']') {
          offset += 1;
          return result;
        }
        if (source[offset] !== ',') return invalid();
        offset += 1;
      }
      return invalid();
    }
    if (source.startsWith('true', offset)) {
      offset += 4;
      return true;
    }
    if (source.startsWith('false', offset)) {
      offset += 5;
      return false;
    }
    if (source.startsWith('null', offset)) {
      offset += 4;
      return null;
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(offset));
    if (number) {
      offset += number[0].length;
      const parsed = Number(number[0]);
      if (!Number.isFinite(parsed)) return invalid();
      return parsed;
    }
    return invalid();
  };

  const result = parseValue(0);
  skipWhitespace();
  if (offset !== source.length) return invalid();
  return result;
}

function boundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength && !/[\u0000-\u001f\u007f]/.test(value);
}

function parseHeader(value: unknown): JwtHeader {
  if (!isRecord(value)) return invalid();
  if (Object.keys(value).some((key) => !['alg', 'kid', 'typ'].includes(key))) return invalid();
  if (value.alg !== ALLOWED_ALGORITHM || !boundedString(value.kid, 128)) return invalid();
  if (value.typ !== undefined && value.typ !== 'JWT') return invalid();
  return value as unknown as JwtHeader;
}

function exactAudience(value: unknown, configuredAudience: string): value is string | readonly string[] {
  if (value === configuredAudience) return true;
  return Array.isArray(value) && value.length === 1 && value[0] === configuredAudience;
}

function parseClaims(value: unknown, configuration: TicketExchangeConfiguration, nowSeconds: number): EntryClaims {
  if (!isRecord(value)) return invalid();
  if (
    value.iss !== configuration.issuer ||
    !exactAudience(value.aud, configuration.audience) ||
    !boundedString(value.sub, 255) ||
    !boundedString(value.tenant, 255) ||
    !boundedString(value.jti, 255) ||
    !boundedString(value.preauth_challenge, 512) ||
    !Object.prototype.hasOwnProperty.call(value, 'roles') ||
    !Number.isSafeInteger(value.iat) ||
    !Number.isSafeInteger(value.exp)
  ) {
    return invalid();
  }

  const iat = value.iat as number;
  const exp = value.exp as number;
  const skew = configuration.clockSkewSeconds;
  if (
    iat > nowSeconds + skew ||
    exp <= nowSeconds - skew ||
    exp <= iat ||
    exp - iat > configuration.maximumLifetimeSeconds
  ) {
    return invalid();
  }
  if (value.nbf !== undefined && (!Number.isSafeInteger(value.nbf) || (value.nbf as number) > nowSeconds + skew)) {
    return invalid();
  }
  return value as unknown as EntryClaims;
}

function validConfiguration(configuration: TicketExchangeConfiguration): void {
  let issuer: URL;
  try {
    issuer = new URL(configuration.issuer);
  } catch {
    throw new Error('Ticket exchange issuer configuration is invalid.');
  }
  if (
    issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.hash ||
    configuration.issuer.length > 512 ||
    !boundedString(configuration.audience, 255) ||
    !Number.isSafeInteger(configuration.clockSkewSeconds) || configuration.clockSkewSeconds < 0 || configuration.clockSkewSeconds > 30 ||
    !Number.isSafeInteger(configuration.maximumLifetimeSeconds) || configuration.maximumLifetimeSeconds < 1 || configuration.maximumLifetimeSeconds > 60
  ) {
    throw new Error('Ticket exchange configuration is invalid.');
  }
}

export class SignedEntryTicketVerifier {
  private readonly assertionIssuer = new AssertionIssuer();

  constructor(
    private readonly configuration: TicketExchangeConfiguration,
    private readonly keySet: TrustedTicketKeySet,
    private readonly now: () => number = Date.now,
  ) {
    validConfiguration(configuration);
  }

  async verify(ticket: string): Promise<ValidatedEntryTicket> {
    if (typeof ticket !== 'string' || ticket.length < 16 || ticket.length > MAX_TICKET_LENGTH) return invalid();
    const segments = ticket.split('.');
    if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) return invalid();

    const headerBytes = decodeBase64Url(segments[0], MAX_HEADER_BYTES);
    const claimsBytes = decodeBase64Url(segments[1], MAX_CLAIMS_BYTES);
    const signature = decodeBase64Url(segments[2], MAX_SIGNATURE_BYTES);
    const header = parseHeader(parseJsonStrict(decodeUtf8Strict(headerBytes)));
    const nowSeconds = Math.floor(this.now() / 1000);
    const claims = parseClaims(parseJsonStrict(decodeUtf8Strict(claimsBytes)), this.configuration, nowSeconds);

    let key: KeyObject | undefined;
    try {
      key = await this.keySet.findPublicKey(header.kid);
    } catch (error) {
      if (error instanceof TrustedTicketKeySetUnavailableError) throw error;
      throw new TrustedTicketKeySetUnavailableError();
    }
    if (!key || key.type !== 'public' || key.asymmetricKeyType !== 'rsa') return invalid();
    const modulusLength = key.asymmetricKeyDetails?.modulusLength;
    if (!modulusLength || modulusLength < 2048 || modulusLength > 8192 || signature.length !== Math.ceil(modulusLength / 8)) return invalid();

    const validSignature = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${segments[0]}.${segments[1]}`, 'ascii'),
      key,
      signature,
    );
    if (!validSignature) return invalid();

    // No request, tenant selector, frontend role, or unverified token can mint this capability.
    const assertion = this.assertionIssuer.issue(claims.iss, claims.sub);
    return Object.freeze({
      assertion,
      requestedTenantId: claims.tenant,
      ticketJtiSha256: createHash('sha256').update(claims.iss, 'utf8').update('\0').update(claims.jti, 'utf8').digest('hex'),
      // Keep the JTI tombstone through the final instant at which skew still permits acceptance.
      ticketExpiresAt: new Date((claims.exp + this.configuration.clockSkewSeconds) * 1000),
      ticketChallengeSha256: createHash('sha256').update(claims.preauth_challenge, 'utf8').digest('hex'),
    });
  }
}
