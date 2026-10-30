import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { test } from 'node:test';
import type { Response } from 'express';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { IdentityDeniedError } from '../src/identity/identity.errors.js';
import {
  isVerifiedIdentityAssertion,
  PortalSessionVerifier,
  type VerifiedIdentityAssertion,
  type VerifiedPortalSession,
} from '../src/identity/identity.trust.js';
import type { MembershipRole } from '../src/identity/identity.types.js';
import { RejectedTicketError, SignedEntryTicketVerifier } from '../src/auth-exchange/signed-ticket.verifier.js';
import {
  type AuthExchangeCookieWriter,
  type IssuedPortalSession,
  type PortalPreAuthServicePort,
  type PortalExchangeAbuseLimitPort,
  PortalExchangeRateLimitedError,
  type PortalSessionIssueOptions,
  type PortalSessionIssuerPort,
  type PortalSessionVerifierPort,
  type TicketExchangeConfiguration,
  TrustedTicketKeySet,
  type VerifiedPortalPreAuth,
  TrustedTicketKeySetUnavailableError,
  PRE_AUTH_COOKIE_NAME,
  PORTAL_SESSION_COOKIE_NAME,
} from '../src/auth-exchange/ticket-contract.js';
import { TicketExchangeService } from '../src/auth-exchange/ticket-exchange.service.js';

const ISSUER = 'https://suite4.synthetic.invalid/portal';
const AUDIENCE = 'https://portal.synthetic.invalid';
const ORIGIN = 'https://portal.synthetic.invalid';
const NOW = Date.parse('2028-05-01T12:00:00.000Z');
const PREAUTH_COOKIE = 'p'.repeat(43);
const SESSION_COOKIE = 's'.repeat(43);
const CSRF_TOKEN = 'c'.repeat(43);
const CONTEXT_REF = 'x'.repeat(43);
const RAW_JTI = 'synthetic-one-use-jti-39f43a';
const RAW_CHALLENGE = 'synthetic-browser-challenge-9b7f';

const configuration: TicketExchangeConfiguration = {
  issuer: ISSUER,
  audience: AUDIENCE,
  clockSkewSeconds: 5,
  maximumLifetimeSeconds: 60,
};

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });

function encoded(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function makeTicket(options: {
  readonly header?: Record<string, unknown>;
  readonly claims?: Record<string, unknown>;
  readonly rawClaims?: string;
  readonly privateKey?: KeyObject;
} = {}): string {
  const header = { alg: 'RS256', kid: 'key-current', typ: 'JWT', ...options.header };
  const issuedAt = Math.floor(NOW / 1000) - 3;
  const claims: Record<string, unknown> = {
    iss: ISSUER,
    aud: AUDIENCE,
    purpose: 'META_PORTAL_ENTRY',
    ver: 1,
    sub: 'suite4-user-123',
    tenant: 'tenant-a',
    session_iss: 'https://session-issuer.synthetic.invalid',
    roles: ['owner'],
    jti: RAW_JTI,
    iat: issuedAt,
    exp: issuedAt + 45,
    preauth_challenge: RAW_CHALLENGE,
    ...options.claims,
  };
  for (const [claim, value] of Object.entries(claims)) {
    if (value === undefined) delete claims[claim];
  }
  const headerPart = encoded(JSON.stringify(header));
  const claimsPart = encoded(options.rawClaims ?? JSON.stringify(claims));
  const signingInput = `${headerPart}.${claimsPart}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput, 'ascii'), options.privateKey ?? keyPair.privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

class MemoryKeySet extends TrustedTicketKeySet {
  readonly keys = new Map<string, KeyObject>([['key-current', keyPair.publicKey]]);
  unavailable = false;
  lookups: string[] = [];

  async findPublicKey(kid: string): Promise<KeyObject | undefined> {
    this.lookups.push(kid);
    if (this.unavailable) throw new TrustedTicketKeySetUnavailableError();
    return this.keys.get(kid);
  }
}

const verifiedPreAuth = Object.freeze({}) as VerifiedPortalPreAuth;

class FakePreAuth implements PortalPreAuthServicePort {
  calls: { challengeRef: string | undefined; cookie: string | undefined }[] = [];
  async verifyBrowserBinding(challengeRef: string | undefined, preAuthCookie: string | undefined): Promise<VerifiedPortalPreAuth | undefined> {
    this.calls.push({ challengeRef, cookie: preAuthCookie });
    return challengeRef === 'preauth-reference-123' && preAuthCookie === PREAUTH_COOKIE ? verifiedPreAuth : undefined;
  }
}

class FakeSessions implements PortalSessionIssuerPort {
  readonly consumed = new Set<string>();
  readonly assertions: VerifiedIdentityAssertion[] = [];
  readonly requestedTenants: string[] = [];
  readonly options: PortalSessionIssueOptions[] = [];
  sessionRef: string | undefined = '91b2ef8b-2763-4dca-b3d4-845f7223949d';
  issueCount = 0;
  denyMembership = false;

  async issueFromVerifiedAssertion(
    assertion: VerifiedIdentityAssertion,
    requestedTenantId: string,
    options: PortalSessionIssueOptions,
  ): Promise<IssuedPortalSession> {
    assert.equal(isVerifiedIdentityAssertion(assertion), true);
    if (this.denyMembership || requestedTenantId !== 'tenant-a') throw new IdentityDeniedError();
    if (this.consumed.has(options.ticketJtiSha256)) throw new IdentityDeniedError();
    this.consumed.add(options.ticketJtiSha256);
    this.issueCount += 1;
    this.assertions.push(assertion);
    this.requestedTenants.push(requestedTenantId);
    this.options.push(options);
    const roles: readonly MembershipRole[] = ['viewer'];
    return {
      sessionId: 'internal-session-id-never-public',
      sessionCookie: SESSION_COOKIE,
      csrfToken: CSRF_TOKEN,
      contextRef: CONTEXT_REF,
      tenantId: requestedTenantId,
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
      publicContext: {
        sessionRef: this.sessionRef as string,
        principalRef: 'principal-reference-pseudonymous',
        tenantRef: requestedTenantId,
        roles,
        tenantContextRef: CONTEXT_REF,
        contextVersion: 1,
      },
    };
  }
}

class FakeSessionVerifier implements PortalSessionVerifierPort {
  readonly seen: (string | undefined)[] = [];
  readonly verificationOptions: ({ readonly touchLastSeen?: boolean } | undefined)[] = [];
  result?: VerifiedPortalSession;
  async verify(cookie: string | undefined, options?: { readonly touchLastSeen?: boolean }): Promise<VerifiedPortalSession | undefined> {
    this.seen.push(cookie);
    this.verificationOptions.push(options);
    return this.result;
  }
}

class FakeAbuseLimit implements PortalExchangeAbuseLimitPort {
  readonly calls: (
    | { bucket: 'PORTAL_EXCHANGE_ATTEMPT'; ip: string }
    | { bucket: 'PORTAL_EXCHANGE'; ip: string; actor: string }
  )[] = [];
  deny = false;
  denyAttempt = false;
  failure: unknown;

  consume(bucket: 'PORTAL_EXCHANGE_ATTEMPT', dimensions: { readonly ip: string }): Promise<void>;
  consume(bucket: 'PORTAL_EXCHANGE', dimensions: { readonly ip: string; readonly actor: string }): Promise<void>;
  async consume(
    bucket: 'PORTAL_EXCHANGE_ATTEMPT' | 'PORTAL_EXCHANGE',
    dimensions: { readonly ip: string; readonly actor?: string },
  ): Promise<void> {
    if (bucket === 'PORTAL_EXCHANGE_ATTEMPT') this.calls.push({ bucket, ip: dimensions.ip });
    else this.calls.push({ bucket, ip: dimensions.ip, actor: dimensions.actor ?? '' });
    if (this.failure !== undefined) throw this.failure;
    if ((bucket === 'PORTAL_EXCHANGE_ATTEMPT' && this.denyAttempt) || (bucket === 'PORTAL_EXCHANGE' && this.deny)) {
      throw new PortalExchangeRateLimitedError();
    }
  }
}

class FakeCookieWriter implements AuthExchangeCookieWriter {
  setCalls = 0;
  set(response: Response, issued: IssuedPortalSession): void {
    this.setCalls += 1;
    response.setHeader('Set-Cookie', [
      `${PORTAL_SESSION_COOKIE_NAME}=${issued.sessionCookie}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      `__Host-ca_meta_csrf=${issued.csrfToken}; Path=/; Secure; SameSite=Lax`,
      `__Host-ca_meta_context=${issued.contextRef}; Path=/; Secure; SameSite=Lax`,
    ]);
  }
}

function makeResponse(): { response: Response; headers: Map<string, string | readonly string[]> } {
  const headers = new Map<string, string | readonly string[]>();
  const response = {
    setHeader(name: string, value: string | readonly string[]) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
  } as unknown as Response;
  return { response, headers };
}

function context(overrides: Partial<Record<string, string>> = {}) {
  return {
    requestId: 'request-123',
    clientIp: '192.0.2.44',
    headers: {
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      cookie: `${PRE_AUTH_COOKIE_NAME}=${PREAUTH_COOKIE}`,
      ...overrides,
    },
  };
}

function makeService(options: {
  readonly sessions?: FakeSessions;
  readonly preAuth?: FakePreAuth;
  readonly keySet?: MemoryKeySet;
  readonly abuseLimit?: FakeAbuseLimit;
  readonly sessionVerifier?: FakeSessionVerifier;
} = {}) {
  const sessions = options.sessions ?? new FakeSessions();
  const preAuth = options.preAuth ?? new FakePreAuth();
  const keySet = options.keySet ?? new MemoryKeySet();
  const sessionVerifier = options.sessionVerifier ?? new FakeSessionVerifier();
  const abuseLimit = options.abuseLimit ?? new FakeAbuseLimit();
  const cookieWriter = new FakeCookieWriter();
  const service = new TicketExchangeService(
    configuration,
    keySet,
    [ORIGIN],
    preAuth,
    sessions,
    sessionVerifier,
    abuseLimit,
    cookieWriter,
    () => NOW,
  );
  return { service, sessions, preAuth, keySet, sessionVerifier, abuseLimit, cookieWriter };
}

test('valid signed ticket creates a session with only server membership roles in the DTO', async () => {
  const { service, sessions, preAuth, abuseLimit, cookieWriter } = makeService();
  const ticket = makeTicket();
  const { response, headers } = makeResponse();
  const result = await service.exchange(
    { ticket, challengeRef: 'preauth-reference-123' },
    context(),
    response,
  );

  assert.equal(result.tenantRef, 'tenant-a');
  assert.equal(result.sessionRef, '91b2ef8b-2763-4dca-b3d4-845f7223949d');
  assert.deepEqual(result.roles, ['viewer']);
  assert.equal(result.principalRef, 'principal-reference-pseudonymous');
  assert.equal(result.requestId, 'request-123');
  assert.deepEqual(Object.keys(result).sort(), ['contextVersion', 'principalRef', 'requestId', 'roles', 'sessionRef', 'tenantContextRef', 'tenantRef']);
  assert.equal(JSON.stringify(result).includes(SESSION_COOKIE), false);
  assert.equal(JSON.stringify(result).includes(RAW_JTI), false);
  assert.equal(JSON.stringify(result).includes(RAW_CHALLENGE), false);
  assert.equal(sessions.requestedTenants[0], 'tenant-a');
  assert.equal(isVerifiedIdentityAssertion(sessions.assertions[0]), true);
  assert.equal(sessions.options[0].preAuth, verifiedPreAuth);
  assert.equal(Object.keys(sessions.options[0]).some((key) => /ticket|roles/i.test(key) && ![
    'ticketJtiSha256', 'ticketSha256', 'ticketExpiresAt', 'ticketChallengeSha256',
  ].includes(key)), false);
  assert.match(sessions.options[0].ticketJtiSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(sessions.options[0].ticketJtiSha256, RAW_JTI);
  assert.equal(sessions.options[0].ticketSha256, createHash('sha256').update(ticket, 'utf8').digest('hex'));
  assert.notEqual(sessions.options[0].ticketSha256, ticket);
  assert.equal(sessions.options[0].ticketChallengeSha256.length, 64);
  assert.equal(preAuth.calls.length, 1);
  assert.equal(preAuth.calls[0].cookie, PREAUTH_COOKIE);
  assert.deepEqual(abuseLimit.calls, [
    { bucket: 'PORTAL_EXCHANGE_ATTEMPT', ip: '192.0.2.44' },
    { bucket: 'PORTAL_EXCHANGE', ip: '192.0.2.44', actor: `${ISSUER}\0suite4-user-123` },
  ]);
  assert.equal(cookieWriter.setCalls, 1);
  const setCookie = headers.get('set-cookie');
  assert.ok(Array.isArray(setCookie));
  assert.ok(setCookie.some((value) => value.includes(`${PORTAL_SESSION_COOKIE_NAME}=${SESSION_COOKIE}`)));
});

test('ticket configuration allows five seconds of clock skew and rejects six', () => {
  assert.doesNotThrow(() => new SignedEntryTicketVerifier(
    { ...configuration, clockSkewSeconds: 5 }, new MemoryKeySet(), () => NOW,
  ));
  assert.throws(() => new SignedEntryTicketVerifier(
    { ...configuration, clockSkewSeconds: 6 }, new MemoryKeySet(), () => NOW,
  ), /Ticket exchange configuration is invalid/);
});

test('two concurrent exchanges of one ticket produce at most one session', async () => {
  const { service, sessions, cookieWriter } = makeService();
  const ticket = makeTicket();
  const attempts = await Promise.allSettled([
    service.exchange({ ticket, challengeRef: 'preauth-reference-123' }, context(), makeResponse().response),
    service.exchange({ ticket, challengeRef: 'preauth-reference-123' }, context(), makeResponse().response),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
  assert.equal(sessions.issueCount, 1);
  assert.equal(cookieWriter.setCalls, 1);
});

test('a valid existing session proof is passed only as a rotation capability', async () => {
  const verifier = new PortalSessionVerifier({
    async findActiveBySecretHash() {
      return {
        sessionId: 'session-id-internal',
        principalId: 'principal-id-internal',
        tenantId: 'tenant-a',
        contextVersion: 4,
        contextRefHash: 'd'.repeat(64),
        csrfTokenHash: 'e'.repeat(64),
      };
    },
  });
  const prior = await verifier.verify(SESSION_COOKIE);
  assert.ok(prior);
  const sessionVerifier = new FakeSessionVerifier();
  sessionVerifier.result = prior;
  const { service, sessions } = makeService({ sessionVerifier });
  await service.exchange(
    { ticket: makeTicket(), challengeRef: 'preauth-reference-123' },
    context({ cookie: `${PRE_AUTH_COOKIE_NAME}=${PREAUTH_COOKIE}; ${PORTAL_SESSION_COOKIE_NAME}=${SESSION_COOKIE}` }),
    makeResponse().response,
  );
  assert.equal(sessionVerifier.seen[0], SESSION_COOKIE);
  assert.deepEqual(sessionVerifier.verificationOptions[0], { touchLastSeen: false });
  assert.equal(sessions.options[0].priorSession, prior);
});

test('exchange abuse limit uses request IP and the verified issuer/subject, and denies before session creation', async () => {
  const abuseLimit = new FakeAbuseLimit();
  const { service, sessions, cookieWriter } = makeService({ abuseLimit });
  const { response, headers } = makeResponse();
  await service.exchange({ ticket: makeTicket(), challengeRef: 'preauth-reference-123' }, context(), response);
  assert.deepEqual(abuseLimit.calls, [
    { bucket: 'PORTAL_EXCHANGE_ATTEMPT', ip: '192.0.2.44' },
    { bucket: 'PORTAL_EXCHANGE', ip: '192.0.2.44', actor: `${ISSUER}\0suite4-user-123` },
  ]);

  abuseLimit.deny = true;
  const deniedResponse = makeResponse();
  await assert.rejects(
    service.exchange({ ticket: makeTicket({ claims: { jti: 'another-synthetic-jti-value' } }), challengeRef: 'preauth-reference-123' }, context(), deniedResponse.response),
    (error: unknown) => {
      assert.equal(typeof error === 'object' && error !== null && 'getStatus' in error && typeof error.getStatus === 'function' && error.getStatus(), 429);
      return true;
    },
  );
  assert.equal(sessions.issueCount, 1);
  assert.equal(cookieWriter.setCalls, 1);
  assert.equal(deniedResponse.headers.get('retry-after'), '60');
  assert.deepEqual(abuseLimit.calls.slice(2), [
    { bucket: 'PORTAL_EXCHANGE_ATTEMPT', ip: '192.0.2.44' },
    { bucket: 'PORTAL_EXCHANGE', ip: '192.0.2.44', actor: `${ISSUER}\0suite4-user-123` },
  ]);
});

test('invalid client IP is rejected before distributed attempt quota or key lookup', async () => {
  const abuseLimit = new FakeAbuseLimit();
  const { service, keySet } = makeService({ abuseLimit });
  await assert.rejects(
    service.exchange(
      { ticket: makeTicket(), challengeRef: 'preauth-reference-123' },
      { ...context(), clientIp: 'not-an-ip' },
      makeResponse().response,
    ),
    ServiceUnavailableException,
  );
  assert.deepEqual(abuseLimit.calls, []);
  assert.deepEqual(keySet.lookups, []);
});

test('stable rate-limit boundary code maps to 429 with a safe Retry-After', async () => {
  const abuseLimit = new FakeAbuseLimit();
  abuseLimit.failure = Object.assign(new Error('safe boundary detail'), { code: 'RATE_LIMITED' });
  const { service, sessions, preAuth, keySet, cookieWriter } = makeService({ abuseLimit });
  const deniedResponse = makeResponse();

  await assert.rejects(
    service.exchange({ ticket: makeTicket(), challengeRef: 'preauth-reference-123' }, context(), deniedResponse.response),
    (error: unknown) => {
      assert.equal(typeof error === 'object' && error !== null && 'getStatus' in error && typeof error.getStatus === 'function' && error.getStatus(), 429);
      assert.equal(JSON.stringify(error).includes('safe boundary detail'), false);
      return true;
    },
  );

  assert.equal(deniedResponse.headers.get('retry-after'), '60');
  assert.deepEqual(abuseLimit.calls, [{ bucket: 'PORTAL_EXCHANGE_ATTEMPT', ip: '192.0.2.44' }]);
  assert.deepEqual(keySet.lookups, [], 'a rate-limited attempt stops before trusted key lookup and RSA verification');
  assert.equal(preAuth.calls.length, 0);
  assert.equal(sessions.issueCount, 0);
  assert.equal(cookieWriter.setCalls, 0);
});

test('sessionRef is required and malformed values fail before cookies are written', async () => {
  const withoutSessionRef = new FakeSessions();
  withoutSessionRef.sessionRef = undefined;
  const noRef = makeService({ sessions: withoutSessionRef });
  await assert.rejects(
    noRef.service.exchange(
      { ticket: makeTicket(), challengeRef: 'preauth-reference-123' },
      context(),
      makeResponse().response,
    ),
    (error: unknown) => error instanceof ServiceUnavailableException,
  );
  assert.equal(noRef.cookieWriter.setCalls, 0);

  const malformedSessions = new FakeSessions();
  malformedSessions.sessionRef = 'not-an-opaque-session-uuid';
  const malformed = makeService({ sessions: malformedSessions });
  await assert.rejects(
    malformed.service.exchange(
      { ticket: makeTicket(), challengeRef: 'preauth-reference-123' },
      context(),
      makeResponse().response,
    ),
    (error: unknown) => typeof error === 'object' && error !== null && 'getStatus' in error && typeof error.getStatus === 'function' && error.getStatus() === 503,
  );
  assert.equal(malformed.cookieWriter.setCalls, 0);
});

test('unsigned, unsupported, URL-selected, malformed and forged tickets are rejected before session issuance', async (t) => {
  const keySet = new MemoryKeySet();
  const verifier = new SignedEntryTicketVerifier(configuration, keySet, () => NOW);
  const normal = makeTicket();
  const pieces = normal.split('.');
  const damaged = `${pieces[0]}.${pieces[1]}.${pieces[2].slice(0, -1)}${pieces[2].endsWith('A') ? 'B' : 'A'}`;
  const cases: [string, string][] = [
    ['missing typ', makeTicket({ header: { typ: undefined } })],
    ['wrong typ', makeTicket({ header: { typ: 'JWS' } })],
    ['alg none', makeTicket({ header: { alg: 'none' } })],
    ['algorithm substitution', makeTicket({ header: { alg: 'HS256' } })],
    ['token key URL', makeTicket({ header: { jku: 'https://attacker.invalid/keys' } })],
    ['x5u key URL', makeTicket({ header: { x5u: 'https://attacker.invalid/cert' } })],
    ['modified signature', damaged],
    ['malformed compact value', 'not-a-ticket'],
    ['duplicate claim', makeTicket({ rawClaims: `{"iss":"${ISSUER}","iss":"${ISSUER}","aud":"${AUDIENCE}","sub":"subject","tenant":"tenant-a","roles":[],"jti":"${RAW_JTI}","iat":${Math.floor(NOW / 1000) - 3},"exp":${Math.floor(NOW / 1000) + 42},"preauth_challenge":"${RAW_CHALLENGE}"}` })],
  ];
  for (const [name, ticket] of cases) {
    await t.test(name, async () => {
      await assert.rejects(verifier.verify(ticket), RejectedTicketError);
    });
  }
  assert.equal(keySet.lookups.includes('attacker.invalid'), false);
});

test('issuer, audience, tenant, subject, JTI, challenge, role, and time claims are enforced', async (t) => {
  const verifier = new SignedEntryTicketVerifier(configuration, new MemoryKeySet(), () => NOW);
  const now = Math.floor(NOW / 1000);
  const cases: [string, Record<string, unknown>][] = [
    ['wrong issuer', { iss: 'https://other.synthetic.invalid' }],
    ['wrong audience', { aud: 'https://other.synthetic.invalid' }],
    ['missing purpose', { purpose: undefined }],
    ['wrong purpose', { purpose: 'OTHER_PURPOSE' }],
    ['missing profile version', { ver: undefined }],
    ['wrong profile version', { ver: 2 }],
    ['non-integer profile version', { ver: 1.5 }],
    ['missing session issuer', { session_iss: undefined }],
    ['empty session issuer', { session_iss: '' }],
    ['oversized session issuer', { session_iss: 's'.repeat(513) }],
    ['unknown ticket role', { roles: ['platform_admin'] }],
    ['malformed ticket roles', { roles: 'owner' }],
    ['duplicate ticket roles', { roles: ['owner', 'owner'] }],
    ['wrong tenant type', { tenant: 14 }],
    ['oversized subject', { sub: 's'.repeat(129) }],
    ['empty subject', { sub: '' }],
    ['oversized tenant', { tenant: 't'.repeat(49) }],
    ['missing JTI', { jti: undefined }],
    ['short JTI', { jti: 'j'.repeat(15) }],
    ['oversized JTI', { jti: 'j'.repeat(257) }],
    ['non-base64url JTI', { jti: `${'j'.repeat(15)}!` }],
    ['missing challenge', { preauth_challenge: undefined }],
    ['short preauth challenge', { preauth_challenge: 'c'.repeat(31) }],
    ['oversized preauth challenge', { preauth_challenge: 'c'.repeat(129) }],
    ['non-base64url preauth challenge', { preauth_challenge: `${'c'.repeat(31)}!` }],
    ['missing roles claim', { roles: undefined }],
    ['expired ticket beyond skew', { exp: now - 6 }],
    ['future issued-at beyond skew', { iat: now + 6 }],
    ['lifetime above the maximum', { iat: now - 2, exp: now + 59 }],
    ['not-before in the future', { nbf: now + 6 }],
  ];
  for (const [name, claims] of cases) {
    await t.test(name, async () => {
      await assert.rejects(verifier.verify(makeTicket({ claims })), RejectedTicketError);
    });
  }
});

test('session_iss is bounded metadata and does not mint the identity issuer', async () => {
  const verifier = new SignedEntryTicketVerifier(configuration, new MemoryKeySet(), () => NOW);
  const result = await verifier.verify(makeTicket({ claims: { session_iss: 'synthetic-session-authority-01' } }));
  assert.equal(result.assertion.issuer, ISSUER);
  assert.equal(result.assertion.subject, 'suite4-user-123');
});

test('configured trusted key rotation accepts a new key ID without honoring token URLs', async () => {
  const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keySet = new MemoryKeySet();
  keySet.keys.set('key-next', rotated.publicKey);
  const verifier = new SignedEntryTicketVerifier(configuration, keySet, () => NOW);
  const result = await verifier.verify(makeTicket({ header: { kid: 'key-next' }, privateKey: rotated.privateKey }));
  assert.equal(result.requestedTenantId, 'tenant-a');
  assert.equal(keySet.lookups.at(-1), 'key-next');
});

test('pre-auth mismatch, invalid origin, revoked membership, and unavailable keys do not issue cookies', async (t) => {
  await t.test('wrong challenge/browser cookie', async () => {
    const preAuth = new FakePreAuth();
    const { service, sessions, cookieWriter } = makeService({ preAuth });
    await assert.rejects(
      service.exchange({ ticket: makeTicket(), challengeRef: 'wrong-reference-123' }, context(), makeResponse().response),
      UnauthorizedException,
    );
    assert.equal(sessions.issueCount, 0);
    assert.equal(cookieWriter.setCalls, 0);
  });

  await t.test('untrusted origin / fetch metadata', async () => {
    const { service, sessions, cookieWriter } = makeService();
    await assert.rejects(
      service.exchange({ ticket: makeTicket(), challengeRef: 'preauth-reference-123' }, context({ origin: 'https://attacker.invalid' }), makeResponse().response),
      UnauthorizedException,
    );
    assert.equal(sessions.issueCount, 0);
    assert.equal(cookieWriter.setCalls, 0);
  });

  await t.test('revoked current membership', async () => {
    const sessions = new FakeSessions();
    sessions.denyMembership = true;
    const { service, cookieWriter } = makeService({ sessions });
    await assert.rejects(
      service.exchange({ ticket: makeTicket(), challengeRef: 'preauth-reference-123' }, context(), makeResponse().response),
      UnauthorizedException,
    );
    assert.equal(cookieWriter.setCalls, 0);
  });

  await t.test('trusted key store unavailable', async () => {
    const keySet = new MemoryKeySet();
    keySet.unavailable = true;
    const { service, sessions, cookieWriter } = makeService({ keySet });
    await assert.rejects(
      service.exchange({ ticket: makeTicket(), challengeRef: 'preauth-reference-123' }, context(), makeResponse().response),
    );
    assert.equal(sessions.issueCount, 0);
    assert.equal(cookieWriter.setCalls, 0);
  });
});
