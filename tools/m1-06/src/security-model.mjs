import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';

export const FAKE_ISSUER = 'https://issuer.fake.invalid';
export const FAKE_AUDIENCE = 'urn:synthetic:msg4:meta-portal';
export const APP_ORIGIN = 'https://portal.fake.invalid';
export const EMBED_ORIGIN = 'https://suite4.fake.invalid';
export const SAME_SITE_MUTATION_ORIGIN = 'https://workspace.fake.invalid';
export const MAX_TICKET_TTL_SECONDS = 60;
export const CLOCK_SKEW_SECONDS = 5;

const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const PREAUTH_CHALLENGE_TTL_MS = 60 * 1000;
const MAGIC_LINK_TTL_MS = 10 * 60 * 1000;
const MAGIC_LINK_RATE_LIMIT = 3;
const MAGIC_LINK_RATE_WINDOW_MS = 60 * 1000;
const EMBED_NONCE_TTL_MS = 60 * 1000;
const ALLOWED_ROLES = new Set(['owner', 'admin', 'operator', 'viewer']);
const EXCHANGE_ENTRY_MODES = new Map([
  ['PORTAL_TOP_LEVEL', APP_ORIGIN],
  ['SUITE4_EMBED', EMBED_ORIGIN],
]);
const MUTATION_FETCH_SITE_BY_ORIGIN = new Map([
  [APP_ORIGIN, 'same-origin'],
  [SAME_SITE_MUTATION_ORIGIN, 'same-site'],
]);
const trustedExchangeContexts = new WeakSet();
const ROLE_OPERATIONS = new Map([
  ['owner', new Set(['CONNECT', 'DISCONNECT', 'EVENT_RESEND'])],
  ['admin', new Set(['CONNECT', 'DISCONNECT', 'EVENT_RESEND'])],
  ['operator', new Set(['CONNECT', 'EVENT_RESEND'])],
  ['viewer', new Set()],
]);

export class SecurityFailure extends Error {
  constructor(code) {
    super(code);
    this.name = 'SecurityFailure';
    this.code = code;
  }
}

function assertAllowedEntry({ requestOrigin, hostOrigin, entryMode }) {
  if (requestOrigin !== APP_ORIGIN) reject('EXCHANGE_ORIGIN_DENIED');
  const expectedHostOrigin = EXCHANGE_ENTRY_MODES.get(entryMode);
  if (!expectedHostOrigin) reject('EXCHANGE_FLOW_DENIED');
  if (hostOrigin !== expectedHostOrigin) reject('EXCHANGE_HOST_ORIGIN_DENIED');
}

export function createTrustedExchangeContext({ requestOrigin, hostOrigin, entryMode, preAuthCookie }) {
  assertAllowedEntry({ requestOrigin, hostOrigin, entryMode });
  if (typeof preAuthCookie !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(preAuthCookie)) {
    reject('PREAUTH_COOKIE_REQUIRED');
  }
  const context = Object.freeze({ requestOrigin, hostOrigin, entryMode, preAuthCookie });
  trustedExchangeContexts.add(context);
  return context;
}

function assertTrustedExchangeContext(context) {
  if (!context || !trustedExchangeContexts.has(context)) reject('EXCHANGE_CONTEXT_REQUIRED');
}

function reject(code) {
  throw new SecurityFailure(code);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function randomSecret() {
  return randomBytes(32).toString('base64url');
}

function timestampMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string') return Number.NaN;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  return new Date(normalized.endsWith('Z') ? normalized : `${normalized}Z`).getTime();
}

function equalHash(expected, candidate) {
  if (typeof candidate !== 'string' || !/^[A-Za-z0-9_-]{32,}$/.test(candidate)) return false;
  const actual = Buffer.from(sha256(candidate), 'hex');
  const saved = Buffer.from(expected, 'hex');
  return actual.length === saved.length && timingSafeEqual(actual, saved);
}

export function sqlTime(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 23).replace('T', ' ');
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function parseBase64urlJson(segment) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) reject('TICKET_MALFORMED');
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    reject('TICKET_MALFORMED');
  }
}

export function createFakeIssuer() {
  const pairs = new Map();
  const jwks = new Map();
  for (const kid of ['fake-key-current', 'fake-key-previous']) {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    pairs.set(kid, pair);
    jwks.set(kid, {
      ...pair.publicKey.export({ format: 'jwk' }),
      kid,
      alg: 'RS256',
      use: 'sig',
    });
  }
  return { pairs, jwks };
}

export function issueFakeTicket(issuer, overrides = {}, options = {}) {
  const nowMs = options.nowMs ?? Date.parse('2026-10-28T12:00:00.000Z');
  const kid = options.kid ?? 'fake-key-current';
  const pair = issuer.pairs.get(kid);
  if (!pair) reject('FAKE_SIGNING_KEY_UNAVAILABLE');
  const now = Math.floor(nowMs / 1000);
  const claims = {
    iss: FAKE_ISSUER,
    aud: FAKE_AUDIENCE,
    purpose: 'META_PORTAL_ENTRY',
    preauth_challenge: randomSecret(),
    sub: 'user-owner-01',
    tenant: 'tenant-a',
    roles: ['owner'],
    jti: randomBytes(18).toString('base64url'),
    iat: now,
    exp: now + 30,
    ver: 1,
    session_iss: 'suite4-session:synthetic',
    ...overrides,
  };
  const header = { typ: 'JWT', alg: options.alg ?? 'RS256', kid: options.headerKid ?? kid };
  if (options.headerExtras) Object.assign(header, options.headerExtras);
  const encodedHeader = base64urlJson(header);
  const encodedClaims = base64urlJson(claims);
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  let signature;
  if (header.alg === 'RS256') {
    signature = sign('RSA-SHA256', Buffer.from(signingInput), pair.privateKey).toString('base64url');
  } else {
    // Unsupported algorithms are deliberately signed with unrelated bytes so verification must reject alg first.
    signature = randomBytes(32).toString('base64url');
  }
  if (options.tamperSignature) {
    const changed = Buffer.from(signature, 'base64url');
    changed[0] ^= 1;
    signature = changed.toString('base64url');
  }
  return `${signingInput}.${signature}`;
}

export function verifyFakeTicket(token, trustedJwks, nowMs = Date.parse('2026-10-28T12:00:00.000Z')) {
  if (typeof token !== 'string' || token.length > 8192) reject('TICKET_MALFORMED');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) reject('TICKET_MALFORMED');
  if (!/^[A-Za-z0-9_-]+$/.test(parts[2])) reject('TICKET_MALFORMED');
  const header = parseBase64urlJson(parts[0]);
  const claims = parseBase64urlJson(parts[1]);
  if (!header || typeof header !== 'object' || Array.isArray(header)) reject('TICKET_MALFORMED');
  if (header.typ !== 'JWT' || header.alg !== 'RS256') reject('TICKET_ALGORITHM_DENIED');
  if (Object.hasOwn(header, 'jku') || Object.hasOwn(header, 'x5u') || Object.hasOwn(header, 'crit')) reject('TICKET_HEADER_DENIED');
  if (typeof header.kid !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(header.kid)) reject('TICKET_KID_INVALID');
  const jwk = trustedJwks.get(header.kid);
  if (!jwk || jwk.kid !== header.kid || jwk.alg !== 'RS256' || jwk.use !== 'sig' || jwk.kty !== 'RSA') {
    reject('TICKET_KID_UNKNOWN');
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    reject('TICKET_KEY_INVALID');
  }
  const input = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], 'base64url');
  if (!verify('RSA-SHA256', input, publicKey, signature)) reject('TICKET_SIGNATURE_INVALID');
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) reject('TICKET_CLAIMS_INVALID');
  if (claims.iss !== FAKE_ISSUER) reject('TICKET_ISSUER_INVALID');
  if (claims.aud !== FAKE_AUDIENCE) reject('TICKET_AUDIENCE_INVALID');
  if (claims.purpose !== 'META_PORTAL_ENTRY') reject('TICKET_PURPOSE_INVALID');
  if (typeof claims.preauth_challenge !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(claims.preauth_challenge)) reject('TICKET_CHALLENGE_REQUIRED');
  if (claims.ver !== 1) reject('TICKET_VERSION_INVALID');
  if (typeof claims.sub !== 'string' || claims.sub.length < 1 || claims.sub.length > 128) reject('TICKET_SUBJECT_INVALID');
  if (typeof claims.tenant !== 'string' || claims.tenant.length < 1 || claims.tenant.length > 48) reject('TICKET_TENANT_INVALID');
  if (!Array.isArray(claims.roles) || claims.roles.length < 1 || claims.roles.some((role) => typeof role !== 'string')) {
    reject('TICKET_ROLES_INVALID');
  }
  if (claims.roles.some((role) => !ALLOWED_ROLES.has(role))) reject('TICKET_ROLES_INVALID');
  if (typeof claims.jti !== 'string' || claims.jti.length < 16 || claims.jti.length > 256) reject('TICKET_JTI_INVALID');
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.exp <= claims.iat) reject('TICKET_TIME_INVALID');
  if (claims.exp - claims.iat > MAX_TICKET_TTL_SECONDS) reject('TICKET_TTL_TOO_LONG');
  if (claims.iat > Math.floor(nowMs / 1000) + CLOCK_SKEW_SECONDS) reject('TICKET_ISSUED_IN_FUTURE');
  if (Math.floor(nowMs / 1000) > claims.exp + CLOCK_SKEW_SECONDS) reject('TICKET_EXPIRED');
  if (typeof claims.session_iss !== 'string' || claims.session_iss.length < 1 || claims.session_iss.length > 128) {
    reject('TICKET_SESSION_ISSUER_INVALID');
  }
  return claims;
}

function cookieFor(sessionSecret) {
  return `__Host-meta_portal=${sessionSecret}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

function preAuthCookieFor(secret) {
  return `__Host-meta_pre_auth=${secret}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

function assertMutation({ origin, csrfToken, csrfHash, secFetchSite }) {
  const expectedFetchSite = MUTATION_FETCH_SITE_BY_ORIGIN.get(origin);
  if (!expectedFetchSite) reject('ORIGIN_DENIED');
  if (secFetchSite !== expectedFetchSite) reject('FETCH_METADATA_DENIED');
  if (!equalHash(csrfHash, csrfToken)) reject('CSRF_DENIED');
}

function assertSessionLive(row, nowMs) {
  if (!row || row.revoked_at !== null) reject('AUTH_REQUIRED');
  const issuedAt = timestampMs(row.issued_at);
  const idleAt = timestampMs(row.idle_at);
  const expiresAt = timestampMs(row.expires_at);
  if (Number.isNaN(issuedAt) || Number.isNaN(idleAt) || Number.isNaN(expiresAt)) reject('AUTH_REQUIRED');
  if (nowMs >= expiresAt || nowMs - idleAt >= SESSION_IDLE_MS || nowMs - issuedAt >= SESSION_ABSOLUTE_MS) reject('SESSION_EXPIRED');
}

async function activeMembership(conn, tenantId, issuer, subject, lock = false) {
  const [rows] = await conn.execute(
    `SELECT m.role_name, m.status, p.status AS principal_status, t.status AS tenant_status
     FROM m106_membership m
     JOIN m106_principal p ON p.issuer = m.issuer AND p.subject = m.subject
     JOIN m106_tenant t ON t.id = m.tenant_id
     WHERE m.tenant_id = ? AND m.issuer = ? AND m.subject = ?${lock ? ' FOR UPDATE' : ''}`,
    [tenantId, issuer, subject],
  );
  if (!rows[0] || rows[0].status !== 'ACTIVE' || rows[0].principal_status !== 'ACTIVE') reject('MEMBERSHIP_INVALID');
  if (rows[0].tenant_status !== 'ACTIVE') reject('TENANT_NOT_ACTIVE');
  return rows[0];
}

async function insertSession(conn, { tenantId, issuer, subject, roleName, nowMs }) {
  const sessionSecret = randomSecret();
  const csrfToken = randomSecret();
  const contextRef = randomSecret();
  const issuedAt = sqlTime(nowMs);
  const idleAt = issuedAt;
  const expiresAt = sqlTime(nowMs + SESSION_ABSOLUTE_MS);
  await conn.execute(
    `INSERT INTO m106_portal_session
     (session_hash, issuer, subject, tenant_id, role_name, context_ref_hash, context_version, csrf_hash,
      issued_at, idle_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL)`,
    [sha256(sessionSecret), issuer, subject, tenantId, roleName, sha256(contextRef), sha256(csrfToken), issuedAt, idleAt, expiresAt],
  );
  return {
    sessionSecret,
    csrfToken,
    contextRef,
    tenantId,
    subject,
    role: roleName,
    cookie: cookieFor(sessionSecret),
  };
}

function isDuplicateKey(error) {
  return error && (error.code === 'ER_DUP_ENTRY' || error.errno === 1062);
}

export function createSecurityModel({ pool, fakeIssuer, nowMs }) {
  const magicLinkBuckets = new Map();

  async function beginPreAuth({ requestOrigin, hostOrigin, entryMode, at = nowMs }) {
    assertAllowedEntry({ requestOrigin, hostOrigin, entryMode });
    const preAuthCookie = randomSecret();
    const challenge = randomSecret();
    await pool.execute(
      `INSERT INTO m106_preauth_challenge (challenge_hash, preauth_cookie_hash, expires_at, consumed_at)
       VALUES (?, ?, ?, NULL)`,
      [sha256(challenge), sha256(preAuthCookie), sqlTime(at + PREAUTH_CHALLENGE_TTL_MS)],
    );
    // The cookie represents Set-Cookie; the challenge is returned separately for the trusted issuer handoff.
    return { preAuthCookie, cookie: preAuthCookieFor(preAuthCookie), challenge };
  }

  async function exchangeTicket(token, exchangeContext, at = nowMs) {
    // Validate server-derived Origin/host/flow and the browser's HttpOnly pre-auth cookie before JWT work.
    assertTrustedExchangeContext(exchangeContext);
    const claims = verifyFakeTicket(token, fakeIssuer.jwks, at);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [challengeRows] = await conn.execute(
        `SELECT * FROM m106_preauth_challenge
         WHERE challenge_hash = ? AND preauth_cookie_hash = ? FOR UPDATE`,
        [sha256(claims.preauth_challenge), sha256(exchangeContext.preAuthCookie)],
      );
      const challenge = challengeRows[0];
      if (!challenge || timestampMs(challenge.expires_at) <= at) reject('EXCHANGE_CHALLENGE_INVALID');
      if (challenge.consumed_at !== null) reject('EXCHANGE_CHALLENGE_INVALID');
      const membership = await activeMembership(conn, claims.tenant, FAKE_ISSUER, claims.sub, true);
      try {
        await conn.execute(
          'INSERT INTO m106_consumed_ticket (issuer, jti_hash, expires_at, consumed_at) VALUES (?, ?, ?, ?)',
          [FAKE_ISSUER, sha256(claims.jti), sqlTime(claims.exp * 1000), sqlTime(at)],
        );
      } catch (error) {
        if (isDuplicateKey(error)) reject('TICKET_REPLAY');
        throw error;
      }
      const [challengeConsumed] = await conn.execute(
        `UPDATE m106_preauth_challenge SET consumed_at = ?
         WHERE challenge_hash = ? AND preauth_cookie_hash = ? AND consumed_at IS NULL`,
        [sqlTime(at), sha256(claims.preauth_challenge), sha256(exchangeContext.preAuthCookie)],
      );
      if (challengeConsumed.affectedRows !== 1) reject('EXCHANGE_CHALLENGE_INVALID');
      // Roles in the signed claim are deliberately not used; current membership is authoritative.
      const result = await insertSession(conn, {
        tenantId: claims.tenant,
        issuer: FAKE_ISSUER,
        subject: claims.sub,
        roleName: membership.role_name.toLowerCase(),
        nowMs: at,
      });
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  async function lockLiveSession(conn, sessionSecret, at) {
    if (typeof sessionSecret !== 'string') reject('AUTH_REQUIRED');
    const [rows] = await conn.execute('SELECT * FROM m106_portal_session WHERE session_hash = ? FOR UPDATE', [sha256(sessionSecret)]);
    const row = rows[0];
    assertSessionLive(row, at);
    const membership = await activeMembership(conn, row.tenant_id, row.issuer, row.subject, true);
    return { row, membership };
  }

  async function resolveCurrentContext({ sessionSecret, contextRef, cUUID, at = nowMs }) {
    if (typeof sessionSecret !== 'string') reject('AUTH_REQUIRED');
    const [rows] = await pool.execute('SELECT * FROM m106_portal_session WHERE session_hash = ?', [sha256(sessionSecret)]);
    const row = rows[0];
    assertSessionLive(row, at);
    await activeMembership(pool, row.tenant_id, row.issuer, row.subject);
    if (!equalHash(row.context_ref_hash, contextRef)) reject('CONTEXT_CHANGED');
    if (cUUID !== undefined && cUUID !== row.tenant_id) reject('TENANT_CONTEXT_MISMATCH');
    return row;
  }

  async function readAsset({ sessionSecret, contextRef, assetId, cUUID, at = nowMs }) {
    const session = await resolveCurrentContext({ sessionSecret, contextRef, cUUID, at });
    const [rows] = await pool.execute('SELECT id, label FROM m106_asset WHERE tenant_id = ? AND id = ?', [session.tenant_id, assetId]);
    if (!rows[0]) reject('RESOURCE_NOT_AVAILABLE');
    return rows[0];
  }

  async function startOnboarding({ sessionSecret, contextRef, csrfToken, origin, secFetchSite, id, at = nowMs }) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const { row, membership } = await lockLiveSession(conn, sessionSecret, at);
      assertMutation({ origin, csrfToken, csrfHash: row.csrf_hash, secFetchSite });
      if (!equalHash(row.context_ref_hash, contextRef)) reject('CONTEXT_CHANGED');
      const role = membership.role_name.toLowerCase();
      if (!ROLE_OPERATIONS.get(role)?.has('CONNECT')) reject('AUTHZ_DENIED');
      await conn.execute(
        `INSERT INTO m106_onboarding (id, tenant_id, issuer, subject, status, context_version, started_at)
         VALUES (?, ?, ?, ?, 'CREATED', ?, ?)`,
        [id, row.tenant_id, row.issuer, row.subject, row.context_version, sqlTime(at)],
      );
      await conn.execute(
        'UPDATE m106_portal_session SET role_name = ?, idle_at = ? WHERE session_hash = ?',
        [role, sqlTime(at), row.session_hash],
      );
      await conn.execute(
        `INSERT INTO m106_audit (tenant_id, actor_ref, operation, target_ref, outcome, created_at)
         VALUES (?, ?, 'CONNECT', ?, 'ALLOWED', ?)`,
        [row.tenant_id, row.subject, id, sqlTime(at)],
      );
      await conn.commit();
      return { id, tenantId: row.tenant_id, subject: row.subject, contextVersion: Number(row.context_version) };
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  async function switchTenant({ sessionSecret, expectedContextRef, targetTenantId, csrfToken, origin, secFetchSite, at = nowMs }) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (typeof sessionSecret !== 'string') reject('AUTH_REQUIRED');
      const [sessions] = await conn.execute(
        `SELECT s.*, t.status AS current_tenant_status
         FROM m106_portal_session s JOIN m106_tenant t ON t.id = s.tenant_id
         WHERE s.session_hash = ? FOR UPDATE`,
        [sha256(sessionSecret)],
      );
      const row = sessions[0];
      assertSessionLive(row, at);
      assertMutation({ origin, csrfToken, csrfHash: row.csrf_hash, secFetchSite });
      if (!equalHash(row.context_ref_hash, expectedContextRef)) reject('CONTEXT_CHANGED');
      const [sourceMemberships] = await conn.execute(
        `SELECT m.status AS membership_status, p.status AS principal_status
         FROM m106_membership m
         JOIN m106_principal p ON p.issuer = m.issuer AND p.subject = m.subject
         WHERE m.tenant_id = ? AND m.issuer = ? AND m.subject = ? FOR UPDATE`,
        [row.tenant_id, row.issuer, row.subject],
      );
      const sourceMembership = sourceMemberships[0];
      const recovery = row.current_tenant_status === 'SUSPENDED'
        || (sourceMembership?.membership_status === 'REVOKED' && sourceMembership.principal_status === 'ACTIVE');
      // A suspended tenant or revoked source membership grants no resource access,
      // but a live session may recover to a different active membership.
      if (!recovery) {
        await activeMembership(conn, row.tenant_id, row.issuer, row.subject, true);
      }
      if (recovery && targetTenantId === row.tenant_id) reject('RECOVERY_TARGET_MUST_DIFFER');
      const membership = await activeMembership(conn, targetTenantId, row.issuer, row.subject, true);
      const nextContextRef = randomSecret();
      const nextVersion = Number(row.context_version) + 1;
      await conn.execute(
        `UPDATE m106_portal_session
         SET tenant_id = ?, role_name = ?, context_ref_hash = ?, context_version = ?, idle_at = ?
         WHERE session_hash = ? AND context_version = ?`,
        [targetTenantId, membership.role_name.toLowerCase(), sha256(nextContextRef), nextVersion, sqlTime(at), row.session_hash, row.context_version],
      );
      await conn.execute(
        `INSERT INTO m106_audit (tenant_id, actor_ref, operation, target_ref, outcome, created_at)
         VALUES (?, ?, ?, ?, 'ALLOWED', ?)`,
        [targetTenantId, row.subject, recovery ? 'TENANT_RECOVERY' : 'TENANT_SWITCH', targetTenantId, sqlTime(at)],
      );
      await conn.commit();
      return { sessionSecret, csrfToken, contextRef: nextContextRef, tenantId: targetTenantId, role: membership.role_name.toLowerCase() };
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  async function requestMagicLink(email, tenantId, at = nowMs, rateLimitBucket) {
    const emailHash = sha256(String(email).trim().toLowerCase());
    const publicResponse = {
      status: 202,
      body: { message: 'Se a identidade estiver elegível, enviaremos um link de acesso.' },
    };
    if (typeof rateLimitBucket !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(rateLimitBucket)) {
      reject('RATE_LIMIT_CONTEXT_REQUIRED');
    }
    const bucketKey = sha256(rateLimitBucket);
    let bucket = magicLinkBuckets.get(bucketKey);
    if (!bucket || at < bucket.windowStartedAt || at - bucket.windowStartedAt >= MAGIC_LINK_RATE_WINDOW_MS) {
      bucket = { windowStartedAt: at, count: 0 };
    }
    const permitted = bucket.count < MAGIC_LINK_RATE_LIMIT;
    bucket.count += 1;
    magicLinkBuckets.set(bucketKey, bucket);
    if (!permitted) return { publicResponse, localOutboxToken: null, rateLimited: true };

    const [members] = await pool.execute(
      `SELECT m.issuer, m.subject FROM m106_membership m
       JOIN m106_principal p ON p.issuer = m.issuer AND p.subject = m.subject
       JOIN m106_tenant t ON t.id = m.tenant_id
       WHERE m.tenant_id = ? AND m.email_hash = ? AND m.status = 'ACTIVE'
         AND p.status = 'ACTIVE' AND t.status = 'ACTIVE' LIMIT 1`,
      [tenantId, emailHash],
    );
    if (!members[0]) return { publicResponse, localOutboxToken: null, rateLimited: false };
    const token = randomSecret();
    await pool.execute(
      `INSERT INTO m106_magic_link (token_hash, purpose, tenant_id, issuer, subject, issued_at, expires_at, consumed_at)
       VALUES (?, 'PORTAL_LOGIN', ?, ?, ?, ?, ?, NULL)`,
      [sha256(token), tenantId, members[0].issuer, members[0].subject, sqlTime(at), sqlTime(at + MAGIC_LINK_TTL_MS)],
    );
    // This value models a test-only local outbox. It is never part of publicResponse or a real delivery adapter.
    return { publicResponse, localOutboxToken: token, rateLimited: false };
  }

  async function previewMagicLink(token, method = 'GET', at = nowMs) {
    if (!['GET', 'HEAD'].includes(method)) reject('METHOD_NOT_ALLOWED');
    const [rows] = await pool.execute(
      'SELECT purpose, expires_at, consumed_at FROM m106_magic_link WHERE token_hash = ?',
      [sha256(String(token))],
    );
    const valid = rows[0]
      && rows[0].purpose === 'PORTAL_LOGIN'
      && rows[0].consumed_at === null
      && timestampMs(rows[0].expires_at) > at;
    return { status: valid ? 200 : 404, body: method === 'HEAD' ? null : (valid ? 'CONFIRM_LOGIN' : 'LINK_UNAVAILABLE'), consumes: false };
  }

  async function consumeMagicLink({ token, method, origin, secFetchSite, submittedTenant, at = nowMs }) {
    if (method !== 'POST') reject('METHOD_NOT_ALLOWED');
    if (origin !== APP_ORIGIN || secFetchSite !== 'same-origin') reject('ORIGIN_DENIED');
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [links] = await conn.execute('SELECT * FROM m106_magic_link WHERE token_hash = ? FOR UPDATE', [sha256(String(token))]);
      const link = links[0];
      if (!link || link.purpose !== 'PORTAL_LOGIN' || link.consumed_at !== null) reject('LINK_UNAVAILABLE');
      if (timestampMs(link.expires_at) <= at) reject('LINK_UNAVAILABLE');
      if (submittedTenant !== undefined && submittedTenant !== link.tenant_id) reject('LINK_UNAVAILABLE');
      const membership = await activeMembership(conn, link.tenant_id, link.issuer, link.subject, true);
      await conn.execute('UPDATE m106_magic_link SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL', [sqlTime(at), sha256(String(token))]);
      const session = await insertSession(conn, {
        tenantId: link.tenant_id,
        issuer: link.issuer,
        subject: link.subject,
        roleName: membership.role_name.toLowerCase(),
        nowMs: at,
      });
      await conn.commit();
      return session;
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  async function revokeMembership(tenantId, subject, at = nowMs) {
    await pool.execute(
      `UPDATE m106_membership SET status = 'REVOKED'
       WHERE tenant_id = ? AND issuer = ? AND subject = ?`,
      [tenantId, FAKE_ISSUER, subject],
    );
    return at;
  }

  return { beginPreAuth, exchangeTicket, resolveCurrentContext, readAsset, startOnboarding, switchTenant, requestMagicLink, previewMagicLink, consumeMagicLink, revokeMembership };
}

export function operationAllowed({ role, operation, serviceScopes, tenantId, assetId, resourceTenantId }) {
  if (resourceTenantId !== tenantId) return false;
  if (serviceScopes) {
    return serviceScopes.some((scope) => scope.tenantId === tenantId
      && scope.assetId === assetId
      && scope.operation === operation
      && resourceTenantId === tenantId);
  }
  return ROLE_OPERATIONS.get(role)?.has(operation) ?? false;
}

export async function authorizeAndAudit({ pool, tenantId, actorRef, role, operation, targetRef, at, serviceScopes, resourceTenantId = tenantId }) {
  const allowed = operationAllowed({ role, operation, serviceScopes, tenantId, assetId: targetRef, resourceTenantId });
  const outcome = allowed ? 'ALLOWED' : 'DENIED';
  await pool.execute(
    `INSERT INTO m106_audit (tenant_id, actor_ref, operation, target_ref, outcome, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [tenantId, actorRef, operation, targetRef, outcome, sqlTime(at)],
  );
  if (!allowed) reject('AUTHZ_DENIED');
  return { outcome };
}

export function createEmbedChallenge(parentSource, nowMs) {
  return {
    targetOrigin: EMBED_ORIGIN,
    parentSource,
    issuedAt: nowMs,
    consumed: false,
    ready: {
      type: 'EMBED_READY',
      version: 1,
      nonce: randomBytes(24).toString('base64url'),
      requestId: randomBytes(12).toString('base64url'),
    },
  };
}

export function acceptEmbedBootstrap({ event, challenge, nowMs }) {
  if (event.origin !== EMBED_ORIGIN || event.source !== challenge.parentSource) reject('EMBED_SENDER_DENIED');
  if (nowMs < challenge.issuedAt || nowMs - challenge.issuedAt > EMBED_NONCE_TTL_MS) reject('EMBED_NONCE_EXPIRED');
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) reject('EMBED_SCHEMA_INVALID');
  const keys = Object.keys(data).sort();
  if (keys.join(',') !== 'nonce,ticket,type,version' || data.type !== 'EMBED_BOOTSTRAP' || data.version !== 1) {
    reject('EMBED_SCHEMA_INVALID');
  }
  if (challenge.consumed || data.nonce !== challenge.ready.nonce) reject('EMBED_NONCE_INVALID');
  if (typeof data.ticket !== 'string' || data.ticket.length < 16) reject('EMBED_TICKET_INVALID');
  challenge.consumed = true;
  return { ticket: data.ticket, targetOrigin: EMBED_ORIGIN };
}

export function embedCookieFallback(thirdPartyCookiesAvailable) {
  return thirdPartyCookiesAvailable
    ? { mode: 'EMBED_SESSION', csrfRequired: true }
    : { mode: 'TOP_LEVEL_REQUIRED', csrfRequired: true };
}

export function safeDatabaseConfig(env = process.env) {
  const expected = { host: 'db', port: '3306', user: 'm106_test', database: 'm106_identity' };
  for (const [key, value] of Object.entries(expected)) {
    const variable = { host: 'M106_DB_HOST', port: 'M106_DB_PORT', user: 'M106_DB_USER', database: 'M106_DB_NAME' }[key];
    if (env[variable] !== value) reject(`DATABASE_${key.toUpperCase()}_DENIED`);
  }
  if (!env.M106_DB_PASSWORD) reject('DATABASE_PASSWORD_MISSING');
  return {
    ...expected,
    port: Number(expected.port),
    password: env.M106_DB_PASSWORD,
    multipleStatements: true,
    connectionLimit: 6,
    timezone: 'Z',
    dateStrings: true,
  };
}
