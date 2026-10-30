import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import {
  APP_ORIGIN,
  EMBED_ORIGIN,
  FAKE_ISSUER,
  SAME_SITE_MUTATION_ORIGIN,
  SecurityFailure,
  acceptEmbedBootstrap,
  authorizeAndAudit,
  createEmbedChallenge,
  createFakeIssuer,
  createSecurityModel,
  createTrustedExchangeContext,
  embedCookieFallback,
  issueFakeTicket,
  safeDatabaseConfig,
  sha256,
  verifyFakeTicket,
} from './security-model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = await readFile(path.join(root, 'sql', 'schema.sql'), 'utf8');
const endpointMatrixText = await readFile('/workspace/input/endpoint-matrix.csv', 'utf8');
const crosswalkText = await readFile('/workspace/input/endpoint-security-crosswalk.csv', 'utf8');
const nowMs = Date.parse('2026-10-28T12:00:00.000Z');
const db = mysql.createPool(safeDatabaseConfig());
const fakeIssuer = createFakeIssuer();
const model = createSecurityModel({ pool: db, fakeIssuer, nowMs });
const emailHash = (email) => sha256(email.trim().toLowerCase());

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error('Unclosed quote in CSV input');
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length < 2) throw new Error('CSV must have a header and data rows');
  const [headers, ...data] = rows;
  if (new Set(headers).size !== headers.length) throw new Error('CSV headers must be unique');
  return data.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`CSV row ${index + 1} has ${values.length} fields; expected ${headers.length}`);
    return Object.fromEntries(headers.map((header, headerIndex) => [header, values[headerIndex]]));
  });
}

function verifyEndpointCrosswalk() {
  const endpoints = parseCsv(endpointMatrixText);
  const crosswalk = parseCsv(crosswalkText);
  assert.equal(endpoints.length, 53, 'refresh the expected source row count when endpoint-matrix.csv changes');
  assert.equal(crosswalk.length, endpoints.length, 'each endpoint matrix row needs one crosswalk row');
  const dimensionPatterns = {
    identity: /^I(?:0|1|2|3|4|5|9)$/,
    tenant: /^T(?:0|1|2|3|4|9)$/,
    origin_csrf: /^O(?:0|1|2|3|4|5|6|9)$/,
    role_scope: /^R(?:0|1|2|4|5|6|7|8|9|10)$/,
    external_side_effect: /^X(?:0|1|2|3|4|5|6|7|8|9|10|11)$/,
  };
  const allowedGates = new Set(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']);
  const seen = new Set();
  const keyFields = ['kind', 'method', 'path_or_symbol', 'source_file', 'source_symbol'];
  crosswalk.forEach((mapped, index) => {
    const rowNumber = Number(mapped.matrix_row);
    assert.equal(rowNumber, index + 1, `crosswalk row ${index + 1} must have its unique source row number`);
    assert.equal(seen.has(rowNumber), false, `matrix row ${rowNumber} is duplicated`);
    seen.add(rowNumber);
    const endpoint = endpoints[rowNumber - 1];
    for (const field of keyFields) assert.equal(mapped[field], endpoint[field], `matrix row ${rowNumber} identity mismatch at ${field}`);
    for (const [field, pattern] of Object.entries(dimensionPatterns)) {
      assert.match(mapped[field], pattern, `matrix row ${rowNumber} needs a valid ${field} mapping`);
    }
    assert.ok(mapped.next_gate, `matrix row ${rowNumber} needs a next gate`);
    for (const gate of mapped.next_gate.split(';')) assert.equal(allowedGates.has(gate), true, `matrix row ${rowNumber} has unknown gate ${gate}`);
    if (endpoint.kind === 'documentation_drift') {
      assert.ok(mapped.exception_reason, `matrix row ${rowNumber} needs an explicit drift exception`);
    } else {
      assert.equal(mapped.exception_reason, '', `matrix row ${rowNumber} must not have an exception`);
    }
  });
  assert.equal(seen.size, endpoints.length, 'all source rows must be covered exactly once');
  console.log(`PASS AC00.endpoint-security-crosswalk rows=${seen.size} exact-once=1 exceptions=1`);
}

async function expectFailure(promise, code) {
  await assert.rejects(promise, (error) => error instanceof SecurityFailure && error.code === code, `expected ${code}`);
}

async function expectTicketUnused(ticket) {
  const { jti } = verifyFakeTicket(ticket, fakeIssuer.jwks, nowMs);
  await expectJtiUnused(jti);
}

async function expectJtiUnused(jti) {
  const [rows] = await db.execute('SELECT jti_hash FROM m106_consumed_ticket WHERE issuer = ? AND jti_hash = ?', [FAKE_ISSUER, sha256(jti)]);
  assert.equal(rows.length, 0, 'rejected exchange context leaves the ticket unused');
}

async function expectJtiConsumed(jti) {
  const [rows] = await db.execute('SELECT jti_hash FROM m106_consumed_ticket WHERE issuer = ? AND jti_hash = ?', [FAKE_ISSUER, sha256(jti)]);
  assert.equal(rows.length, 1, 'successful exchange consumes the ticket jti exactly once');
}

async function expectChallengeUnused(challenge) {
  const [rows] = await db.execute('SELECT consumed_at FROM m106_preauth_challenge WHERE challenge_hash = ?', [sha256(challenge)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].consumed_at, null, 'failed exchange leaves the browser challenge unused');
}

async function beginBrowserEntry({ hostOrigin = APP_ORIGIN, entryMode = 'PORTAL_TOP_LEVEL' } = {}) {
  const preAuth = await model.beginPreAuth({
    requestOrigin: APP_ORIGIN,
    hostOrigin,
    entryMode,
    at: nowMs,
  });
  return {
    ...preAuth,
    context: createTrustedExchangeContext({
      requestOrigin: APP_ORIGIN,
      hostOrigin,
      entryMode,
      preAuthCookie: preAuth.preAuthCookie,
    }),
  };
}

async function issueBrowserTicket(claims, entryOptions = {}, ticketOptions = {}) {
  const browser = await beginBrowserEntry(entryOptions);
  const ticket = issueFakeTicket(fakeIssuer, {
    ...claims,
    preauth_challenge: browser.challenge,
  }, { nowMs, ...ticketOptions });
  return { ...browser, ticket };
}

async function record(name, fn) {
  await fn();
  console.log(`PASS ${name}`);
}

async function seed() {
  await db.query(schema);
  for (const tenant of ['tenant-a', 'tenant-b', 'tenant-c', 'tenant-d']) {
    await db.execute('INSERT INTO m106_tenant (id, status) VALUES (?, \'ACTIVE\')', [tenant]);
  }
  const people = [
    ['user-owner-01', 'USER', 'ACTIVE'],
    ['user-operator-01', 'USER', 'ACTIVE'],
    ['user-viewer-01', 'USER', 'ACTIVE'],
    ['user-revoked-01', 'USER', 'ACTIVE'],
    ['user-session-revoked-01', 'USER', 'ACTIVE'],
    ['user-cross-tenant-revocation-01', 'USER', 'ACTIVE'],
  ];
  for (const [subject, kind, status] of people) {
    await db.execute('INSERT INTO m106_principal (issuer, subject, kind, status) VALUES (?, ?, ?, ?)', [FAKE_ISSUER, subject, kind, status]);
  }
  const memberships = [
    ['tenant-a', 'user-owner-01', 'owner', 'owner@fake.invalid'],
    ['tenant-b', 'user-owner-01', 'admin', 'owner-b@fake.invalid'],
    ['tenant-c', 'user-owner-01', 'operator', 'owner-c@fake.invalid'],
    ['tenant-d', 'user-owner-01', 'owner', 'suspended@fake.invalid'],
    ['tenant-a', 'user-operator-01', 'operator', 'operator@fake.invalid'],
    ['tenant-a', 'user-viewer-01', 'viewer', 'viewer@fake.invalid'],
    ['tenant-a', 'user-revoked-01', 'owner', 'revoked@fake.invalid'],
    ['tenant-a', 'user-session-revoked-01', 'owner', 'session-revoked@fake.invalid'],
    ['tenant-a', 'user-cross-tenant-revocation-01', 'owner', 'cross-tenant-a@fake.invalid'],
    ['tenant-b', 'user-cross-tenant-revocation-01', 'admin', 'cross-tenant-b@fake.invalid'],
  ];
  for (const [tenant, subject, role, email] of memberships) {
    await db.execute(
      `INSERT INTO m106_membership (tenant_id, issuer, subject, role_name, status, email_hash)
       VALUES (?, ?, ?, ?, 'ACTIVE', ?)`,
      [tenant, FAKE_ISSUER, subject, role, emailHash(email)],
    );
  }
  for (const [tenant, id, label] of [
    ['tenant-a', 'asset-a-1', 'Synthetic asset A1'],
    ['tenant-a', 'asset-a-2', 'Synthetic asset A2'],
    ['tenant-b', 'asset-b-1', 'Synthetic asset B1'],
    ['tenant-d', 'asset-d-1', 'Synthetic asset D1'],
  ]) {
    await db.execute('INSERT INTO m106_asset (tenant_id, id, label) VALUES (?, ?, ?)', [tenant, id, label]);
  }
}

let ownerSession;
let operatorSession;
let onboarding;

try {
  verifyEndpointCrosswalk();
  await seed();

  await record('AC01.cUUID-is-not-auth-and-preauth-challenge-blocks-login-CSRF', async () => {
    const [before] = await db.execute('SELECT COUNT(*) AS total FROM m106_portal_session');
    await expectFailure(model.readAsset({ sessionSecret: undefined, contextRef: undefined, assetId: 'asset-a-1', cUUID: 'tenant-a' }), 'AUTH_REQUIRED');
    assert.equal(await db.execute('SELECT COUNT(*) AS total FROM m106_portal_session').then(([rows]) => Number(rows[0].total)), Number(before[0].total));

    const ownerEntry = await issueBrowserTicket({ sub: 'user-owner-01', tenant: 'tenant-a', roles: ['owner'] });
    await expectFailure(model.exchangeTicket(ownerEntry.ticket, undefined, nowMs), 'EXCHANGE_CONTEXT_REQUIRED');
    await expectTicketUnused(ownerEntry.ticket);
    await expectFailure(Promise.resolve().then(() => model.exchangeTicket(ownerEntry.ticket, createTrustedExchangeContext({
      requestOrigin: 'https://attacker.fake.invalid',
      hostOrigin: APP_ORIGIN,
      entryMode: 'PORTAL_TOP_LEVEL',
      preAuthCookie: ownerEntry.preAuthCookie,
    }), nowMs)), 'EXCHANGE_ORIGIN_DENIED');
    await expectTicketUnused(ownerEntry.ticket);
    await expectFailure(Promise.resolve().then(() => model.exchangeTicket(ownerEntry.ticket, createTrustedExchangeContext({
      requestOrigin: APP_ORIGIN,
      hostOrigin: 'https://suite4.fake.invalid.attacker.test',
      entryMode: 'SUITE4_EMBED',
      preAuthCookie: ownerEntry.preAuthCookie,
    }), nowMs)), 'EXCHANGE_HOST_ORIGIN_DENIED');
    await expectTicketUnused(ownerEntry.ticket);
    await expectFailure(Promise.resolve().then(() => model.exchangeTicket(ownerEntry.ticket, createTrustedExchangeContext({
      requestOrigin: APP_ORIGIN,
      hostOrigin: APP_ORIGIN,
      entryMode: 'MAGIC_LINK',
      preAuthCookie: ownerEntry.preAuthCookie,
    }), nowMs)), 'EXCHANGE_FLOW_DENIED');
    await expectTicketUnused(ownerEntry.ticket);
    await expectFailure(Promise.resolve().then(() => model.exchangeTicket(ownerEntry.ticket, createTrustedExchangeContext({
      requestOrigin: APP_ORIGIN,
      hostOrigin: APP_ORIGIN,
      entryMode: 'PORTAL_TOP_LEVEL',
    }), nowMs)), 'PREAUTH_COOKIE_REQUIRED');
    await expectTicketUnused(ownerEntry.ticket);

    const missingChallengeJti = 'missing-preauth-challenge-jti-001';
    const missingChallenge = issueFakeTicket(fakeIssuer, {
      sub: 'user-owner-01', tenant: 'tenant-a', jti: missingChallengeJti, preauth_challenge: '',
    }, { nowMs });
    await expectFailure(model.exchangeTicket(missingChallenge, ownerEntry.context, nowMs), 'TICKET_CHALLENGE_REQUIRED');
    await expectJtiUnused(missingChallengeJti);

    const attackerEntry = await issueBrowserTicket({ sub: 'user-owner-01', tenant: 'tenant-a', roles: ['owner'] });
    const victimEntry = await beginBrowserEntry();
    await expectFailure(model.exchangeTicket(attackerEntry.ticket, victimEntry.context, nowMs), 'EXCHANGE_CHALLENGE_INVALID');
    await expectTicketUnused(attackerEntry.ticket);
    const victimTicket = issueFakeTicket(fakeIssuer, {
      sub: 'user-owner-01', tenant: 'tenant-a', roles: ['owner'], preauth_challenge: victimEntry.challenge,
    }, { nowMs });
    ownerSession = await model.exchangeTicket(victimTicket, victimEntry.context, nowMs);
    const replayedChallengeJti = 'replayed-preauth-challenge-jti-001';
    const replayedChallengeTicket = issueFakeTicket(fakeIssuer, {
      sub: 'user-owner-01', tenant: 'tenant-a', preauth_challenge: victimEntry.challenge, jti: replayedChallengeJti,
    }, { nowMs });
    await expectFailure(model.exchangeTicket(replayedChallengeTicket, victimEntry.context, nowMs), 'EXCHANGE_CHALLENGE_INVALID');
    await expectJtiUnused(replayedChallengeJti);
    const victimJti = verifyFakeTicket(victimTicket, fakeIssuer.jwks, nowMs).jti;
    const attackerReplayContext = createTrustedExchangeContext({
      requestOrigin: APP_ORIGIN,
      hostOrigin: APP_ORIGIN,
      entryMode: 'PORTAL_TOP_LEVEL',
      preAuthCookie: attackerEntry.preAuthCookie,
    });
    await expectFailure(model.exchangeTicket(victimTicket, attackerReplayContext, nowMs), 'EXCHANGE_CHALLENGE_INVALID');
    await expectJtiConsumed(victimJti);
    const [sessionCountBeforeRetry] = await db.execute('SELECT COUNT(*) AS total FROM m106_portal_session');
    const recoveredSession = await model.exchangeTicket(victimTicket, victimEntry.context, nowMs);
    assert.equal(recoveredSession.sessionSecret, ownerSession.sessionSecret, 'exact same-browser retry returns the original active session');
    assert.equal(recoveredSession.cookie, ownerSession.cookie);
    assert.equal(recoveredSession.csrfToken, ownerSession.csrfToken);
    const [sessionCountAfterRetry] = await db.execute('SELECT COUNT(*) AS total FROM m106_portal_session');
    assert.equal(Number(sessionCountAfterRetry[0].total), Number(sessionCountBeforeRetry[0].total), 'exact retry creates no session');
    const [storedTicketRows] = await db.execute(
      'SELECT ticket_hash FROM m106_consumed_ticket WHERE issuer = ? AND jti_hash = ?',
      [FAKE_ISSUER, sha256(victimJti)],
    );
    assert.equal(storedTicketRows.length, 1);
    assert.equal(storedTicketRows[0].ticket_hash, sha256(victimTicket), 'only the exact compact ticket digest is persisted');
    assert.notEqual(storedTicketRows[0].ticket_hash, victimTicket, 'the compact ticket is not persisted');
    const changedSignedTicket = issueFakeTicket(fakeIssuer, {
      sub: 'user-owner-01',
      tenant: 'tenant-a',
      roles: ['owner'],
      jti: victimJti,
      preauth_challenge: victimEntry.challenge,
      session_iss: 'suite4-session:alternate-signed-token',
    }, { nowMs });
    assert.notEqual(changedSignedTicket, victimTicket);
    await expectFailure(model.exchangeTicket(changedSignedTicket, victimEntry.context, nowMs), 'TICKET_REPLAY');
    const [sessionCountAfterChangedTicket] = await db.execute('SELECT COUNT(*) AS total FROM m106_portal_session');
    assert.equal(Number(sessionCountAfterChangedTicket[0].total), Number(sessionCountAfterRetry[0].total),
      'a different signed token with the same JTI/browser/challenge cannot recover or create a session');
    const duplicateJtiEntry = await beginBrowserEntry();
    const duplicateJtiTicket = issueFakeTicket(fakeIssuer, {
      sub: 'user-owner-01', tenant: 'tenant-a', jti: victimJti, preauth_challenge: duplicateJtiEntry.challenge,
    }, { nowMs });
    await expectFailure(model.exchangeTicket(duplicateJtiTicket, duplicateJtiEntry.context, nowMs), 'TICKET_REPLAY');
    await expectJtiConsumed(victimJti);
    await expectChallengeUnused(duplicateJtiEntry.challenge);
    assert.match(victimEntry.cookie, /^__Host-meta_pre_auth=[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
    assert.equal(victimEntry.cookie.includes('Domain='), false);
    const [storedChallenge] = await db.execute(
      'SELECT challenge_hash, preauth_cookie_hash, consumed_at FROM m106_preauth_challenge WHERE challenge_hash = ?',
      [sha256(victimEntry.challenge)],
    );
    assert.equal(storedChallenge.length, 1);
    assert.equal(storedChallenge[0].preauth_cookie_hash, sha256(victimEntry.preAuthCookie), 'pre-auth cookie is bound by hash');
    assert.notEqual(storedChallenge[0].challenge_hash, victimEntry.challenge, 'challenge is stored only as a hash');
    assert.notEqual(storedChallenge[0].consumed_at, null, 'successful exchange consumes the challenge');
    assert.equal((await model.readAsset({ ...ownerSession, assetId: 'asset-a-1', cUUID: 'tenant-a', at: nowMs })).id, 'asset-a-1');
    await expectFailure(model.readAsset({ ...ownerSession, assetId: 'asset-b-1', cUUID: 'tenant-a', at: nowMs }), 'RESOURCE_NOT_AVAILABLE');
    await expectFailure(model.readAsset({ ...ownerSession, assetId: 'asset-b-1', cUUID: 'tenant-b', at: nowMs }), 'TENANT_CONTEXT_MISMATCH');
    assert.match(ownerSession.cookie, /^__Host-meta_portal=[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
    assert.equal(ownerSession.cookie.includes('Domain='), false);
    const [stored] = await db.execute('SELECT session_hash FROM m106_portal_session WHERE session_hash = ?', [sha256(ownerSession.sessionSecret)]);
    assert.equal(stored.length, 1, 'only the session hash is persisted');
  });

  await record('AC02.ticket-profile-signature-rotation-jti-replay-and-revocation', async () => {
    const operatorEntry = await issueBrowserTicket(
      { sub: 'user-operator-01', tenant: 'tenant-a', roles: ['owner'] },
      { hostOrigin: EMBED_ORIGIN, entryMode: 'SUITE4_EMBED' },
    );
    const valid = operatorEntry.ticket;
    operatorSession = await model.exchangeTicket(valid, operatorEntry.context, nowMs);
    assert.equal(operatorSession.role, 'operator', 'current membership overrides signed role claims');
    assert.equal(verifyFakeTicket(valid, fakeIssuer.jwks, nowMs).aud, 'urn:synthetic:msg4:meta-portal');

    const expired = issueFakeTicket(fakeIssuer, { iat: Math.floor(nowMs / 1000) - 120, exp: Math.floor(nowMs / 1000) - 90 }, { nowMs });
    const future = issueFakeTicket(fakeIssuer, { iat: Math.floor(nowMs / 1000) + 30, exp: Math.floor(nowMs / 1000) + 60 }, { nowMs });
    const longTtl = issueFakeTicket(fakeIssuer, { iat: Math.floor(nowMs / 1000), exp: Math.floor(nowMs / 1000) + 61 }, { nowMs });
    const wrongIssuer = issueFakeTicket(fakeIssuer, { iss: 'https://attacker.fake.invalid' }, { nowMs });
    const wrongAudience = issueFakeTicket(fakeIssuer, { aud: 'urn:synthetic:other-service' }, { nowMs });
    const badAlgorithm = issueFakeTicket(fakeIssuer, {}, { nowMs, alg: 'none' });
    const confusedAlgorithm = issueFakeTicket(fakeIssuer, {}, { nowMs, alg: 'HS256' });
    const badSignature = issueFakeTicket(fakeIssuer, {}, { nowMs, tamperSignature: true });
    const remoteKey = issueFakeTicket(fakeIssuer, {}, { nowMs, headerExtras: { jku: 'https://attacker.invalid/jwks.json' } });
    const unknownKid = issueFakeTicket(fakeIssuer, {}, { nowMs, headerKid: 'untrusted-kid' });
    for (const [token, code] of [
      [expired, 'TICKET_EXPIRED'],
      [future, 'TICKET_ISSUED_IN_FUTURE'],
      [longTtl, 'TICKET_TTL_TOO_LONG'],
      [wrongIssuer, 'TICKET_ISSUER_INVALID'],
      [wrongAudience, 'TICKET_AUDIENCE_INVALID'],
      [badAlgorithm, 'TICKET_ALGORITHM_DENIED'],
      [confusedAlgorithm, 'TICKET_ALGORITHM_DENIED'],
      [badSignature, 'TICKET_SIGNATURE_INVALID'],
      [remoteKey, 'TICKET_HEADER_DENIED'],
      [unknownKid, 'TICKET_KID_UNKNOWN'],
    ]) {
      assert.throws(() => verifyFakeTicket(token, fakeIssuer.jwks, nowMs), (error) => error.code === code);
    }

    const oldKeyToken = issueFakeTicket(fakeIssuer, { jti: 'old-key-rotation-ticket-001' }, { nowMs, kid: 'fake-key-previous' });
    const currentOnly = new Map([['fake-key-current', fakeIssuer.jwks.get('fake-key-current')]]);
    assert.throws(() => verifyFakeTicket(oldKeyToken, currentOnly, nowMs), (error) => error.code === 'TICKET_KID_UNKNOWN');
    currentOnly.set('fake-key-previous', fakeIssuer.jwks.get('fake-key-previous'));
    assert.equal(verifyFakeTicket(oldKeyToken, currentOnly, nowMs).jti, 'old-key-rotation-ticket-001', 'overlap permits a configured old key');
    currentOnly.delete('fake-key-previous');
    assert.throws(() => verifyFakeTicket(oldKeyToken, currentOnly, nowMs), (error) => error.code === 'TICKET_KID_UNKNOWN', 'removing a key revokes its tickets');

    const concurrentEntry = await issueBrowserTicket({ sub: 'user-owner-01', tenant: 'tenant-a' });
    const race = await Promise.allSettled([
      model.exchangeTicket(concurrentEntry.ticket, concurrentEntry.context, nowMs),
      model.exchangeTicket(concurrentEntry.ticket, concurrentEntry.context, nowMs),
    ]);
    assert.equal(race.filter((entry) => entry.status === 'fulfilled').length, 1);
    assert.equal(race.filter((entry) => entry.status === 'rejected' && entry.reason.code === 'EXCHANGE_CHALLENGE_INVALID').length, 1);

    const revokedEntry = await issueBrowserTicket({ sub: 'user-revoked-01', tenant: 'tenant-a' });
    await model.revokeMembership('tenant-a', 'user-revoked-01', nowMs);
    await expectFailure(model.exchangeTicket(revokedEntry.ticket, revokedEntry.context, nowMs), 'MEMBERSHIP_INVALID');
    const revokeSessionEntry = await issueBrowserTicket({ sub: 'user-session-revoked-01', tenant: 'tenant-a' });
    const revokedSession = await model.exchangeTicket(revokeSessionEntry.ticket, revokeSessionEntry.context, nowMs);
    await model.revokeMembership('tenant-a', 'user-session-revoked-01', nowMs);
    await expectFailure(model.readAsset({ ...revokedSession, assetId: 'asset-a-1', cUUID: 'tenant-a', at: nowMs }), 'MEMBERSHIP_INVALID');

    const crossTenantAEntry = await issueBrowserTicket({ sub: 'user-cross-tenant-revocation-01', tenant: 'tenant-a' });
    const crossTenantASession = await model.exchangeTicket(crossTenantAEntry.ticket, crossTenantAEntry.context, nowMs);
    const crossTenantBEntry = await issueBrowserTicket({ sub: 'user-cross-tenant-revocation-01', tenant: 'tenant-b' });
    const crossTenantBSession = await model.exchangeTicket(crossTenantBEntry.ticket, crossTenantBEntry.context, nowMs);
    await model.revokeMembership('tenant-a', 'user-cross-tenant-revocation-01', nowMs);
    await expectFailure(model.readAsset({ ...crossTenantASession, assetId: 'asset-a-1', cUUID: 'tenant-a', at: nowMs }), 'MEMBERSHIP_INVALID');
    const [onboardingsBeforeRevokedWrite] = await db.execute('SELECT COUNT(*) AS total FROM m106_onboarding');
    await expectFailure(model.startOnboarding({
      sessionSecret: crossTenantASession.sessionSecret,
      contextRef: crossTenantASession.contextRef,
      csrfToken: crossTenantASession.csrfToken,
      origin: APP_ORIGIN,
      secFetchSite: 'same-origin',
      id: 'revoked-membership-write-denied',
      at: nowMs,
    }), 'MEMBERSHIP_INVALID');
    const [onboardingsAfterRevokedWrite] = await db.execute('SELECT COUNT(*) AS total FROM m106_onboarding');
    assert.equal(Number(onboardingsAfterRevokedWrite[0].total), Number(onboardingsBeforeRevokedWrite[0].total), 'revoked membership cannot write in tenant A');
    await expectFailure(model.switchTenant({
      sessionSecret: crossTenantASession.sessionSecret,
      expectedContextRef: crossTenantASession.contextRef,
      targetTenantId: 'tenant-c',
      csrfToken: crossTenantASession.csrfToken,
      origin: APP_ORIGIN,
      secFetchSite: 'same-origin',
      at: nowMs,
    }), 'MEMBERSHIP_INVALID');
    await expectFailure(model.readAsset({ ...crossTenantASession, assetId: 'asset-a-1', cUUID: 'tenant-a', at: nowMs }), 'MEMBERSHIP_INVALID');
    const recoveredCrossTenantSession = await model.switchTenant({
      sessionSecret: crossTenantASession.sessionSecret,
      expectedContextRef: crossTenantASession.contextRef,
      targetTenantId: 'tenant-b',
      csrfToken: crossTenantASession.csrfToken,
      origin: APP_ORIGIN,
      secFetchSite: 'same-origin',
      at: nowMs,
    });
    assert.equal(recoveredCrossTenantSession.tenantId, 'tenant-b');
    assert.notEqual(recoveredCrossTenantSession.contextRef, crossTenantASession.contextRef, 'recovery rotates contextRef');
    assert.equal((await model.readAsset({ ...recoveredCrossTenantSession, assetId: 'asset-b-1', cUUID: 'tenant-b', at: nowMs })).id, 'asset-b-1');
    await expectFailure(model.switchTenant({
      sessionSecret: recoveredCrossTenantSession.sessionSecret,
      expectedContextRef: crossTenantASession.contextRef,
      targetTenantId: 'tenant-b',
      csrfToken: recoveredCrossTenantSession.csrfToken,
      origin: APP_ORIGIN,
      secFetchSite: 'same-origin',
      at: nowMs,
    }), 'CONTEXT_CHANGED');
    await expectFailure(model.readAsset({ ...recoveredCrossTenantSession, assetId: 'asset-a-1', cUUID: 'tenant-a', at: nowMs }), 'TENANT_CONTEXT_MISMATCH');
    assert.equal((await model.readAsset({ ...crossTenantBSession, assetId: 'asset-b-1', cUUID: 'tenant-b', at: nowMs })).id, 'asset-b-1', 'revoking tenant A membership preserves tenant B access');

    const tenantSessionEntry = await issueBrowserTicket({ sub: 'user-owner-01', tenant: 'tenant-d' });
    let tenantSession = await model.exchangeTicket(tenantSessionEntry.ticket, tenantSessionEntry.context, nowMs);
    await db.execute("UPDATE m106_tenant SET status = 'SUSPENDED' WHERE id = 'tenant-d'");
    await expectFailure(model.readAsset({ ...tenantSession, assetId: 'asset-d-1', cUUID: 'tenant-d', at: nowMs }), 'TENANT_NOT_ACTIVE');
    await expectFailure(model.switchTenant({
      sessionSecret: tenantSession.sessionSecret,
      expectedContextRef: tenantSession.contextRef,
      targetTenantId: 'tenant-d',
      csrfToken: tenantSession.csrfToken,
      origin: APP_ORIGIN,
      secFetchSite: 'same-origin',
      at: nowMs,
    }), 'RECOVERY_TARGET_MUST_DIFFER');
    tenantSession = await model.switchTenant({
      sessionSecret: tenantSession.sessionSecret,
      expectedContextRef: tenantSession.contextRef,
      targetTenantId: 'tenant-a',
      csrfToken: tenantSession.csrfToken,
      origin: APP_ORIGIN,
      secFetchSite: 'same-origin',
      at: nowMs,
    });
    assert.equal(tenantSession.tenantId, 'tenant-a', 'suspended tenant permits only recovery to a different active membership');
    assert.equal((await model.readAsset({ ...tenantSession, assetId: 'asset-a-1', cUUID: 'tenant-a', at: nowMs })).id, 'asset-a-1');
    await expectFailure(model.readAsset({ ...tenantSession, assetId: 'asset-d-1', at: nowMs }), 'RESOURCE_NOT_AVAILABLE');
    const suspendedEntry = await issueBrowserTicket({ sub: 'user-owner-01', tenant: 'tenant-d' });
    await expectFailure(model.exchangeTicket(suspendedEntry.ticket, suspendedEntry.context, nowMs), 'TENANT_NOT_ACTIVE');
    await expectTicketUnused(suspendedEntry.ticket);
    const suspendedLink = await model.requestMagicLink('suspended@fake.invalid', 'tenant-d', nowMs, 'suspended-tenant');
    assert.equal(suspendedLink.localOutboxToken, null, 'a suspended tenant cannot initiate direct access');

    await expectFailure(model.startOnboarding({
      sessionSecret: operatorSession.sessionSecret,
      contextRef: operatorSession.contextRef,
      csrfToken: operatorSession.csrfToken,
      origin: 'https://attacker.fake.invalid',
      secFetchSite: 'cross-site',
      id: 'onboarding-csrf-origin-denied',
      at: nowMs,
    }), 'ORIGIN_DENIED');
    await expectFailure(model.startOnboarding({
      sessionSecret: operatorSession.sessionSecret,
      contextRef: operatorSession.contextRef,
      csrfToken: 'csrf-token-from-another-session',
      origin: APP_ORIGIN,
      secFetchSite: 'same-origin',
      id: 'onboarding-csrf-token-denied',
      at: nowMs,
    }), 'CSRF_DENIED');
    for (const [index, secFetchSite] of ['cross-site', 'none', undefined, 'invalid'].entries()) {
      await expectFailure(model.startOnboarding({
        sessionSecret: operatorSession.sessionSecret,
        contextRef: operatorSession.contextRef,
        csrfToken: operatorSession.csrfToken,
        origin: APP_ORIGIN,
        secFetchSite,
        id: `onboarding-fetch-site-denied-${index}`,
        at: nowMs,
      }), 'FETCH_METADATA_DENIED');
    }
    await expectFailure(model.startOnboarding({
      sessionSecret: operatorSession.sessionSecret,
      contextRef: operatorSession.contextRef,
      csrfToken: 'csrf-from-other-session',
      origin: SAME_SITE_MUTATION_ORIGIN,
      secFetchSite: 'same-site',
      id: 'onboarding-same-site-csrf-denied',
      at: nowMs,
    }), 'CSRF_DENIED');
    await expectFailure(model.startOnboarding({
      sessionSecret: operatorSession.sessionSecret,
      contextRef: operatorSession.contextRef,
      csrfToken: operatorSession.csrfToken,
      origin: APP_ORIGIN,
      secFetchSite: 'same-site',
      id: 'onboarding-fetch-site-mismatch-denied',
      at: nowMs,
    }), 'FETCH_METADATA_DENIED');
    await expectFailure(model.startOnboarding({
      sessionSecret: operatorSession.sessionSecret,
      contextRef: operatorSession.contextRef,
      csrfToken: operatorSession.csrfToken,
      origin: SAME_SITE_MUTATION_ORIGIN,
      secFetchSite: 'same-origin',
      id: 'onboarding-same-site-origin-mismatch-denied',
      at: nowMs,
    }), 'FETCH_METADATA_DENIED');
    const sameSiteOnboarding = await model.startOnboarding({
      sessionSecret: operatorSession.sessionSecret,
      contextRef: operatorSession.contextRef,
      csrfToken: operatorSession.csrfToken,
      origin: SAME_SITE_MUTATION_ORIGIN,
      secFetchSite: 'same-site',
      id: 'onboarding-same-site-allowed',
      at: nowMs,
    });
    assert.equal(sameSiteOnboarding.tenantId, 'tenant-a', 'configured same-site origin is allowed only with same-site metadata and CSRF');
    await expectFailure(model.readAsset({ ...ownerSession, assetId: 'asset-a-1', cUUID: 'tenant-a', at: nowMs + 31 * 60 * 1000 }), 'SESSION_EXPIRED');
    const count = await db.execute('SELECT COUNT(*) AS total FROM m106_portal_session');
    assert.ok(Number(count[0][0].total) >= 3);
  });

  await record('AC03.magic-link-enumeration-scanner-replay-expiry-and-tenant-tampering', async () => {
    const quotaBucket = 'synthetic-enumeration-bucket';
    const known = await model.requestMagicLink('owner@fake.invalid', 'tenant-a', nowMs, quotaBucket);
    const unknown = await model.requestMagicLink('not-invited@fake.invalid', 'tenant-a', nowMs, quotaBucket);
    assert.deepEqual(known.publicResponse, unknown.publicResponse, 'known and unknown email status/body is identical');
    assert.equal(known.localOutboxToken === null, false, 'test-only outbox contains the fake delivery token');
    assert.equal(unknown.localOutboxToken, null);
    const lastAllowed = await model.requestMagicLink('owner@fake.invalid', 'tenant-a', nowMs, quotaBucket);
    const rateLimited = await model.requestMagicLink('not-invited@fake.invalid', 'tenant-a', nowMs, quotaBucket);
    assert.equal(lastAllowed.rateLimited, false);
    assert.equal(rateLimited.rateLimited, true);
    assert.equal(rateLimited.localOutboxToken, null);
    assert.deepEqual(rateLimited.publicResponse, known.publicResponse, 'synthetic quota does not reveal whether the address is known');
    const nextWindow = await model.requestMagicLink('owner@fake.invalid', 'tenant-a', nowMs + 60 * 1000, quotaBucket);
    assert.equal(nextWindow.rateLimited, false, 'the synthetic one-minute quota window resets');

    const getPreview = await model.previewMagicLink(known.localOutboxToken, 'GET', nowMs);
    const headPreview = await model.previewMagicLink(known.localOutboxToken, 'HEAD', nowMs);
    assert.deepEqual(getPreview, { status: 200, body: 'CONFIRM_LOGIN', consumes: false });
    assert.deepEqual(headPreview, { status: 200, body: null, consumes: false });
    const [unused] = await db.execute('SELECT consumed_at FROM m106_magic_link WHERE token_hash = ?', [sha256(known.localOutboxToken)]);
    assert.equal(unused[0].consumed_at, null, 'scanner-safe GET and HEAD leave the token unused');
    await expectFailure(model.consumeMagicLink({ token: known.localOutboxToken, method: 'GET', origin: APP_ORIGIN, secFetchSite: 'same-origin', at: nowMs }), 'METHOD_NOT_ALLOWED');
    await expectFailure(model.consumeMagicLink({ token: known.localOutboxToken, method: 'POST', origin: 'https://attacker.fake.invalid', secFetchSite: 'cross-site', at: nowMs }), 'ORIGIN_DENIED');
    await expectFailure(model.consumeMagicLink({ token: known.localOutboxToken, method: 'POST', origin: APP_ORIGIN, secFetchSite: 'same-origin', submittedTenant: 'tenant-b', at: nowMs }), 'LINK_UNAVAILABLE');

    const linkedSession = await model.consumeMagicLink({
      token: known.localOutboxToken,
      method: 'POST',
      origin: APP_ORIGIN,
      secFetchSite: 'same-origin',
      at: nowMs,
    });
    assert.equal(linkedSession.tenantId, 'tenant-a', 'tenant is loaded from the link record');
    await expectFailure(model.consumeMagicLink({ token: known.localOutboxToken, method: 'POST', origin: APP_ORIGIN, secFetchSite: 'same-origin', at: nowMs }), 'LINK_UNAVAILABLE');

    const concurrentLink = await model.requestMagicLink('viewer@fake.invalid', 'tenant-a', nowMs, 'synthetic-concurrent-link');
    const linkRace = await Promise.allSettled([
      model.consumeMagicLink({ token: concurrentLink.localOutboxToken, method: 'POST', origin: APP_ORIGIN, secFetchSite: 'same-origin', at: nowMs }),
      model.consumeMagicLink({ token: concurrentLink.localOutboxToken, method: 'POST', origin: APP_ORIGIN, secFetchSite: 'same-origin', at: nowMs }),
    ]);
    assert.equal(linkRace.filter((entry) => entry.status === 'fulfilled').length, 1);
    assert.equal(linkRace.filter((entry) => entry.status === 'rejected' && entry.reason.code === 'LINK_UNAVAILABLE').length, 1);

    const expiring = await model.requestMagicLink('operator@fake.invalid', 'tenant-a', nowMs, 'synthetic-expiring-link');
    assert.equal((await model.previewMagicLink(expiring.localOutboxToken, 'GET', nowMs + 11 * 60 * 1000)).status, 404);
    await expectFailure(model.consumeMagicLink({ token: expiring.localOutboxToken, method: 'POST', origin: APP_ORIGIN, secFetchSite: 'same-origin', at: nowMs + 11 * 60 * 1000 }), 'LINK_UNAVAILABLE');
  });

  await record('AC04.tenant-switch-concurrency-onboarding-binding-and-embed-handshake', async () => {
    onboarding = await model.startOnboarding({
      sessionSecret: ownerSession.sessionSecret,
      contextRef: ownerSession.contextRef,
      csrfToken: ownerSession.csrfToken,
      origin: APP_ORIGIN,
      secFetchSite: 'same-origin',
      id: 'onboarding-bound-to-tenant-a',
      at: nowMs,
    });
    assert.equal(onboarding.tenantId, 'tenant-a');

    const switches = await Promise.allSettled([
      model.switchTenant({
        sessionSecret: ownerSession.sessionSecret,
        expectedContextRef: ownerSession.contextRef,
        targetTenantId: 'tenant-b',
        csrfToken: ownerSession.csrfToken,
        origin: APP_ORIGIN,
        secFetchSite: 'same-origin',
        at: nowMs,
      }),
      model.switchTenant({
        sessionSecret: ownerSession.sessionSecret,
        expectedContextRef: ownerSession.contextRef,
        targetTenantId: 'tenant-c',
        csrfToken: ownerSession.csrfToken,
        origin: APP_ORIGIN,
        secFetchSite: 'same-origin',
        at: nowMs,
      }),
    ]);
    assert.equal(switches.filter((entry) => entry.status === 'fulfilled').length, 1);
    assert.equal(switches.filter((entry) => entry.status === 'rejected' && entry.reason.code === 'CONTEXT_CHANGED').length, 1);
    const active = switches.find((entry) => entry.status === 'fulfilled').value;
    await expectFailure(model.resolveCurrentContext({ sessionSecret: ownerSession.sessionSecret, contextRef: ownerSession.contextRef, at: nowMs }), 'CONTEXT_CHANGED');
    await expectFailure(model.readAsset({ ...active, assetId: 'asset-a-1', cUUID: active.tenantId, at: nowMs }), 'RESOURCE_NOT_AVAILABLE');
    await expectFailure(model.readAsset({ ...active, assetId: 'asset-a-1', cUUID: 'tenant-a', at: nowMs }), 'TENANT_CONTEXT_MISMATCH');
    const [savedOnboarding] = await db.execute('SELECT tenant_id, subject, context_version, status FROM m106_onboarding WHERE id = ?', [onboarding.id]);
    assert.deepEqual(savedOnboarding[0], {
      tenant_id: 'tenant-a',
      subject: 'user-owner-01',
      context_version: 1,
      status: 'CREATED',
    });

    const parent = { synthetic: 'expected-parent-window' };
    const challenge = createEmbedChallenge(parent, nowMs);
    assert.equal(challenge.targetOrigin, EMBED_ORIGIN);
    assert.notEqual(challenge.targetOrigin, '*');
    const validEvent = {
      origin: EMBED_ORIGIN,
      source: parent,
      data: { type: 'EMBED_BOOTSTRAP', version: 1, nonce: challenge.ready.nonce, ticket: 'synthetic-short-lived-ticket' },
    };
    assert.equal(acceptEmbedBootstrap({ event: validEvent, challenge, nowMs }).ticket, 'synthetic-short-lived-ticket');
    assert.throws(() => acceptEmbedBootstrap({ event: validEvent, challenge, nowMs }), (error) => error.code === 'EMBED_NONCE_INVALID');

    const wrongOriginChallenge = createEmbedChallenge(parent, nowMs);
    await assert.rejects(
      async () => acceptEmbedBootstrap({ event: { ...validEvent, origin: 'https://suite4.fake.invalid.attacker.test' }, challenge: wrongOriginChallenge, nowMs }),
      (error) => error.code === 'EMBED_SENDER_DENIED',
    );
    const wrongSourceChallenge = createEmbedChallenge(parent, nowMs);
    await assert.rejects(
      async () => acceptEmbedBootstrap({ event: { ...validEvent, source: {} }, challenge: wrongSourceChallenge, nowMs }),
      (error) => error.code === 'EMBED_SENDER_DENIED',
    );
    const wrongVersionChallenge = createEmbedChallenge(parent, nowMs);
    await assert.rejects(
      async () => acceptEmbedBootstrap({
        event: { ...validEvent, data: { ...validEvent.data, nonce: wrongVersionChallenge.ready.nonce, version: 2 } },
        challenge: wrongVersionChallenge,
        nowMs,
      }),
      (error) => error.code === 'EMBED_SCHEMA_INVALID',
    );
    const extraFieldChallenge = createEmbedChallenge(parent, nowMs);
    await assert.rejects(
      async () => acceptEmbedBootstrap({
        event: { ...validEvent, data: { ...validEvent.data, nonce: extraFieldChallenge.ready.nonce, tenant: 'tenant-a' } },
        challenge: extraFieldChallenge,
        nowMs,
      }),
      (error) => error.code === 'EMBED_SCHEMA_INVALID',
    );
    const wrongNonceChallenge = createEmbedChallenge(parent, nowMs);
    await assert.rejects(
      async () => acceptEmbedBootstrap({ event: validEvent, challenge: wrongNonceChallenge, nowMs }),
      (error) => error.code === 'EMBED_NONCE_INVALID',
    );
    const staleChallenge = createEmbedChallenge(parent, nowMs);
    await assert.rejects(
      async () => acceptEmbedBootstrap({ event: { ...validEvent, data: { ...validEvent.data, nonce: staleChallenge.ready.nonce } }, challenge: staleChallenge, nowMs: nowMs + 61 * 1000 }),
      (error) => error.code === 'EMBED_NONCE_EXPIRED',
    );
    assert.deepEqual(embedCookieFallback(false), { mode: 'TOP_LEVEL_REQUIRED', csrfRequired: true });
    assert.deepEqual(embedCookieFallback(true), { mode: 'EMBED_SESSION', csrfRequired: true });
  });

  await record('AC05.role-operation-scope-and-audit-policy', async () => {
    assert.deepEqual(await authorizeAndAudit({ pool: db, tenantId: 'tenant-a', actorRef: 'user-operator-01', role: 'operator', operation: 'CONNECT', targetRef: 'asset-a-1', at: nowMs }), { outcome: 'ALLOWED' });
    await expectFailure(authorizeAndAudit({ pool: db, tenantId: 'tenant-a', actorRef: 'user-operator-01', role: 'operator', operation: 'DISCONNECT', targetRef: 'asset-a-1', at: nowMs }), 'AUTHZ_DENIED');
    await expectFailure(authorizeAndAudit({ pool: db, tenantId: 'tenant-a', actorRef: 'user-operator-01', role: 'operator', operation: 'CONNECT', targetRef: 'asset-b-1', resourceTenantId: 'tenant-b', at: nowMs }), 'AUTHZ_DENIED');
    await expectFailure(authorizeAndAudit({ pool: db, tenantId: 'tenant-a', actorRef: 'user-viewer-01', role: 'viewer', operation: 'CONNECT', targetRef: 'asset-a-1', at: nowMs }), 'AUTHZ_DENIED');
    assert.deepEqual(await authorizeAndAudit({ pool: db, tenantId: 'tenant-a', actorRef: 'user-owner-01', role: 'owner', operation: 'DISCONNECT', targetRef: 'asset-a-1', at: nowMs }), { outcome: 'ALLOWED' });
    assert.deepEqual(await authorizeAndAudit({ pool: db, tenantId: 'tenant-a', actorRef: 'user-operator-01', role: 'operator', operation: 'EVENT_RESEND', targetRef: 'asset-a-1', at: nowMs }), { outcome: 'ALLOWED' });

    const serviceScopes = [{ tenantId: 'tenant-a', assetId: 'asset-a-1', operation: 'EVENT_RESEND' }];
    assert.deepEqual(await authorizeAndAudit({ pool: db, tenantId: 'tenant-a', actorRef: 'svc-event-relay', operation: 'EVENT_RESEND', targetRef: 'asset-a-1', at: nowMs, serviceScopes }), { outcome: 'ALLOWED' });
    await expectFailure(authorizeAndAudit({ pool: db, tenantId: 'tenant-a', actorRef: 'svc-event-relay', operation: 'EVENT_RESEND', targetRef: 'asset-a-2', at: nowMs, serviceScopes }), 'AUTHZ_DENIED');
    await expectFailure(authorizeAndAudit({ pool: db, tenantId: 'tenant-b', actorRef: 'svc-event-relay', operation: 'EVENT_RESEND', targetRef: 'asset-a-1', at: nowMs, resourceTenantId: 'tenant-a', serviceScopes }), 'AUTHZ_DENIED');

    const [auditRows] = await db.execute(
      `SELECT actor_ref, operation, target_ref, outcome FROM m106_audit
       WHERE actor_ref IN ('user-operator-01', 'user-viewer-01', 'user-owner-01', 'svc-event-relay')
       ORDER BY id`,
    );
    assert.ok(auditRows.some((row) => row.actor_ref === 'user-operator-01' && row.operation === 'DISCONNECT' && row.outcome === 'DENIED'));
    assert.ok(auditRows.some((row) => row.actor_ref === 'user-viewer-01' && row.operation === 'CONNECT' && row.outcome === 'DENIED'));
    assert.ok(auditRows.some((row) => row.actor_ref === 'svc-event-relay' && row.target_ref === 'asset-a-1' && row.outcome === 'ALLOWED'));
    const serialized = JSON.stringify(auditRows);
    assert.equal(serialized.includes(ownerSession.sessionSecret), false);
    assert.equal(serialized.includes(ownerSession.csrfToken), false);
    assert.equal(serialized.includes('synthetic-short-lived-ticket'), false);
  });

  const [[counts]] = await db.query(
    `SELECT
      (SELECT COUNT(*) FROM m106_tenant) AS tenants,
      (SELECT COUNT(*) FROM m106_membership) AS memberships,
      (SELECT COUNT(*) FROM m106_portal_session) AS sessions,
      (SELECT COUNT(*) FROM m106_consumed_ticket) AS consumed_tickets,
      (SELECT COUNT(*) FROM m106_magic_link) AS magic_links,
      (SELECT COUNT(*) FROM m106_onboarding) AS onboardings,
      (SELECT COUNT(*) FROM m106_audit) AS audit_events`,
  );
  console.log(`SUMMARY tenants=${counts.tenants} memberships=${counts.memberships} sessions=${counts.sessions} consumed-tickets=${counts.consumed_tickets} magic-links=${counts.magic_links} onboardings=${counts.onboardings} audit-events=${counts.audit_events} real-issuer=0 real-email=0 meta-calls=0 production-writes=0`);
  console.log('M1.06 MariaDB identity/security harness PASS');
} catch (error) {
  console.error(`M1.06 MariaDB identity/security harness FAIL: ${error.code ?? error.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
