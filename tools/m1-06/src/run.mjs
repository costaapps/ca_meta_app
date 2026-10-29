import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import {
  APP_ORIGIN,
  EMBED_ORIGIN,
  FAKE_ISSUER,
  SecurityFailure,
  acceptEmbedBootstrap,
  authorizeAndAudit,
  createEmbedChallenge,
  createFakeIssuer,
  createSecurityModel,
  embedCookieFallback,
  issueFakeTicket,
  safeDatabaseConfig,
  sha256,
  verifyFakeTicket,
} from './security-model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = await readFile(path.join(root, 'sql', 'schema.sql'), 'utf8');
const nowMs = Date.parse('2026-10-28T12:00:00.000Z');
const db = mysql.createPool(safeDatabaseConfig());
const fakeIssuer = createFakeIssuer();
const model = createSecurityModel({ pool: db, fakeIssuer, nowMs });
const emailHash = (email) => sha256(email.trim().toLowerCase());

async function expectFailure(promise, code) {
  await assert.rejects(promise, (error) => error instanceof SecurityFailure && error.code === code, `expected ${code}`);
}

async function record(name, fn) {
  await fn();
  console.log(`PASS ${name}`);
}

async function seed() {
  await db.query(schema);
  for (const tenant of ['tenant-a', 'tenant-b', 'tenant-c']) {
    await db.execute('INSERT INTO m106_tenant (id, status) VALUES (?, \'ACTIVE\')', [tenant]);
  }
  const people = [
    ['user-owner-01', 'USER', 'ACTIVE'],
    ['user-operator-01', 'USER', 'ACTIVE'],
    ['user-viewer-01', 'USER', 'ACTIVE'],
    ['user-revoked-01', 'USER', 'ACTIVE'],
    ['user-session-revoked-01', 'USER', 'ACTIVE'],
  ];
  for (const [subject, kind, status] of people) {
    await db.execute('INSERT INTO m106_principal (issuer, subject, kind, status) VALUES (?, ?, ?, ?)', [FAKE_ISSUER, subject, kind, status]);
  }
  const memberships = [
    ['tenant-a', 'user-owner-01', 'owner', 'owner@fake.invalid'],
    ['tenant-b', 'user-owner-01', 'admin', 'owner-b@fake.invalid'],
    ['tenant-c', 'user-owner-01', 'operator', 'owner-c@fake.invalid'],
    ['tenant-a', 'user-operator-01', 'operator', 'operator@fake.invalid'],
    ['tenant-a', 'user-viewer-01', 'viewer', 'viewer@fake.invalid'],
    ['tenant-a', 'user-revoked-01', 'owner', 'revoked@fake.invalid'],
    ['tenant-a', 'user-session-revoked-01', 'owner', 'session-revoked@fake.invalid'],
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
  ]) {
    await db.execute('INSERT INTO m106_asset (tenant_id, id, label) VALUES (?, ?, ?)', [tenant, id, label]);
  }
}

let ownerSession;
let operatorSession;
let onboarding;

try {
  await seed();

  await record('AC01.arbitrary-cUUID-no-session-or-cross-tenant-asset', async () => {
    const [before] = await db.execute('SELECT COUNT(*) AS total FROM m106_portal_session');
    await expectFailure(model.readAsset({ sessionSecret: undefined, contextRef: undefined, assetId: 'asset-a-1', cUUID: 'tenant-a' }), 'AUTH_REQUIRED');
    assert.equal(await db.execute('SELECT COUNT(*) AS total FROM m106_portal_session').then(([rows]) => Number(rows[0].total)), Number(before[0].total));

    const ticket = issueFakeTicket(fakeIssuer, { sub: 'user-owner-01', tenant: 'tenant-a', roles: ['owner'] }, { nowMs });
    ownerSession = await model.exchangeTicket(ticket, nowMs);
    assert.equal((await model.readAsset({ ...ownerSession, assetId: 'asset-a-1', cUUID: 'tenant-a', at: nowMs })).id, 'asset-a-1');
    await expectFailure(model.readAsset({ ...ownerSession, assetId: 'asset-b-1', cUUID: 'tenant-a', at: nowMs }), 'RESOURCE_NOT_AVAILABLE');
    await expectFailure(model.readAsset({ ...ownerSession, assetId: 'asset-b-1', cUUID: 'tenant-b', at: nowMs }), 'TENANT_CONTEXT_MISMATCH');
    assert.match(ownerSession.cookie, /^__Host-meta_portal=[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
    assert.equal(ownerSession.cookie.includes('Domain='), false);
    const [stored] = await db.execute('SELECT session_hash FROM m106_portal_session WHERE session_hash = ?', [sha256(ownerSession.sessionSecret)]);
    assert.equal(stored.length, 1, 'only the session hash is persisted');
  });

  await record('AC02.ticket-profile-signature-rotation-jti-replay-and-revocation', async () => {
    const valid = issueFakeTicket(fakeIssuer, { sub: 'user-operator-01', tenant: 'tenant-a', roles: ['owner'] }, { nowMs });
    operatorSession = await model.exchangeTicket(valid, nowMs);
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

    const concurrentTicket = issueFakeTicket(fakeIssuer, { sub: 'user-owner-01', tenant: 'tenant-a' }, { nowMs });
    const race = await Promise.allSettled([
      model.exchangeTicket(concurrentTicket, nowMs),
      model.exchangeTicket(concurrentTicket, nowMs),
    ]);
    assert.equal(race.filter((entry) => entry.status === 'fulfilled').length, 1);
    assert.equal(race.filter((entry) => entry.status === 'rejected' && entry.reason.code === 'TICKET_REPLAY').length, 1);

    const revokedTicket = issueFakeTicket(fakeIssuer, { sub: 'user-revoked-01', tenant: 'tenant-a' }, { nowMs });
    await model.revokeMembership('tenant-a', 'user-revoked-01', nowMs);
    await expectFailure(model.exchangeTicket(revokedTicket, nowMs), 'MEMBERSHIP_INVALID');
    const revokeSessionTicket = issueFakeTicket(fakeIssuer, { sub: 'user-session-revoked-01', tenant: 'tenant-a' }, { nowMs });
    const revokedSession = await model.exchangeTicket(revokeSessionTicket, nowMs);
    await model.revokeMembership('tenant-a', 'user-session-revoked-01', nowMs);
    await expectFailure(model.readAsset({ ...revokedSession, assetId: 'asset-a-1', cUUID: 'tenant-a', at: nowMs }), 'MEMBERSHIP_INVALID');

    await expectFailure(model.startOnboarding({
      sessionSecret: operatorSession.sessionSecret,
      contextRef: operatorSession.contextRef,
      csrfToken: operatorSession.csrfToken,
      origin: 'https://attacker.fake.invalid',
      id: 'onboarding-csrf-origin-denied',
      at: nowMs,
    }), 'ORIGIN_DENIED');
    await expectFailure(model.startOnboarding({
      sessionSecret: operatorSession.sessionSecret,
      contextRef: operatorSession.contextRef,
      csrfToken: 'csrf-token-from-another-session',
      origin: APP_ORIGIN,
      id: 'onboarding-csrf-token-denied',
      at: nowMs,
    }), 'CSRF_DENIED');
    await expectFailure(model.readAsset({ ...ownerSession, assetId: 'asset-a-1', cUUID: 'tenant-a', at: nowMs + 31 * 60 * 1000 }), 'SESSION_EXPIRED');
    const count = await db.execute('SELECT COUNT(*) AS total FROM m106_portal_session');
    assert.ok(Number(count[0][0].total) >= 3);
  });

  await record('AC03.magic-link-enumeration-scanner-replay-expiry-and-tenant-tampering', async () => {
    const known = await model.requestMagicLink('owner@fake.invalid', 'tenant-a', nowMs);
    const unknown = await model.requestMagicLink('not-invited@fake.invalid', 'tenant-a', nowMs);
    assert.deepEqual(known.publicResponse, unknown.publicResponse, 'known and unknown email response is identical');
    assert.equal(known.localOutboxToken === null, false, 'test-only outbox contains the fake delivery token');
    assert.equal(unknown.localOutboxToken, null);

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

    const concurrentLink = await model.requestMagicLink('viewer@fake.invalid', 'tenant-a', nowMs);
    const linkRace = await Promise.allSettled([
      model.consumeMagicLink({ token: concurrentLink.localOutboxToken, method: 'POST', origin: APP_ORIGIN, secFetchSite: 'same-origin', at: nowMs }),
      model.consumeMagicLink({ token: concurrentLink.localOutboxToken, method: 'POST', origin: APP_ORIGIN, secFetchSite: 'same-origin', at: nowMs }),
    ]);
    assert.equal(linkRace.filter((entry) => entry.status === 'fulfilled').length, 1);
    assert.equal(linkRace.filter((entry) => entry.status === 'rejected' && entry.reason.code === 'LINK_UNAVAILABLE').length, 1);

    const expiring = await model.requestMagicLink('operator@fake.invalid', 'tenant-a', nowMs);
    assert.equal((await model.previewMagicLink(expiring.localOutboxToken, 'GET', nowMs + 11 * 60 * 1000)).status, 404);
    await expectFailure(model.consumeMagicLink({ token: expiring.localOutboxToken, method: 'POST', origin: APP_ORIGIN, secFetchSite: 'same-origin', at: nowMs + 11 * 60 * 1000 }), 'LINK_UNAVAILABLE');
  });

  await record('AC04.tenant-switch-concurrency-onboarding-binding-and-embed-handshake', async () => {
    onboarding = await model.startOnboarding({
      sessionSecret: ownerSession.sessionSecret,
      contextRef: ownerSession.contextRef,
      csrfToken: ownerSession.csrfToken,
      origin: APP_ORIGIN,
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
        at: nowMs,
      }),
      model.switchTenant({
        sessionSecret: ownerSession.sessionSecret,
        expectedContextRef: ownerSession.contextRef,
        targetTenantId: 'tenant-c',
        csrfToken: ownerSession.csrfToken,
        origin: APP_ORIGIN,
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
