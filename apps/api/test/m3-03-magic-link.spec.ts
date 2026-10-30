import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import type { Response } from 'express';
import { AbuseLimitService, type AbuseLimitDimensions, type AbuseLimitPolicy } from '../src/common/security/abuse-limits.js';
import type { ApiEnvironment } from '../src/config/environment.js';
import { IdentityDeniedError } from '../src/identity/identity.errors.js';
import type { MembershipRole } from '../src/identity/identity.types.js';
import { MagicLinkController } from '../src/auth/magic-link.controller.js';
import {
  LocalMagicLinkInbox,
  MagicLinkService,
  deriveMagicLinkToken,
  hashMagicLinkEmail,
} from '../src/auth/magic-link.service.js';
import type {
  InvitedIdentityTarget,
  MagicLinkDeliveryClaim,
  MagicLinkIssuedSession,
  MagicLinkSessionMaterial,
  MagicLinkStore,
} from '../src/auth/magic-link.store.js';

const recoveryKey = 'synthetic-magic-link-recovery-key-with-32-bytes';
const invitedEmail = 'invited@example.test';
const invitedHash = hashMagicLinkEmail(invitedEmail, recoveryKey);
const principal = '00000000-0000-4000-8000-000000000101';
const tenantA = '00000000-0000-4000-8000-000000000201';
const tenantB = '00000000-0000-4000-8000-000000000202';

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const environment: ApiEnvironment = {
  nodeEnv: 'test',
  port: 0,
  bindAddress: '127.0.0.1',
  allowedHosts: ['localhost', '127.0.0.1'],
  allowedOrigins: ['https://portal.example.test'],
  trustedProxyCidrs: false,
  portalSessionIdleTimeoutSeconds: 1800,
  portalSessionAbsoluteTimeoutSeconds: 28800,
  portalSessionRecoveryKey: recoveryKey,
  database: {
    host: '127.0.0.1', port: 3306, name: 'synthetic_test', user: 'synthetic_api',
    password: 'synthetic-only-password', connectTimeoutMs: 100,
  },
};

class TestAbuseLimits extends AbuseLimitService {
  readonly calls: Array<{ policy: AbuseLimitPolicy; dimensions: AbuseLimitDimensions }> = [];
  readonly limited = new Set<string>();

  override async consume(policy: AbuseLimitPolicy, dimensions: AbuseLimitDimensions): Promise<void> {
    this.calls.push({ policy, dimensions });
    if (this.limited.has(policy)) {
      const { SafeBoundaryError } = await import('../src/common/security/security.errors.js');
      throw new SafeBoundaryError('RATE_LIMITED');
    }
  }
}

interface FakeLink {
  readonly tokenHash: string;
  readonly linkId: string;
  readonly target: InvitedIdentityTarget;
  expiresAt: number;
  consumed: boolean;
  attempts: number;
}

class FakeMagicLinkStore implements MagicLinkStore {
  readonly associations = new Map<string, InvitedIdentityTarget>();
  readonly links = new Map<string, FakeLink>();
  readonly deliveries: Array<{ readonly queueId: string; readonly linkId: string; readonly recipient: string; claimed: boolean }> = [];
  readonly deliveryFingerprints = new Set<string>();
  readonly requestedEmailHashes: string[] = [];
  readonly recipientStorage: string[] = [];
  readonly membershipActive = new Map<string, boolean>();
  consumeCalls = 0;

  async findEligibleTarget(emailHash: string): Promise<InvitedIdentityTarget | undefined> {
    this.requestedEmailHashes.push(emailHash);
    const target = this.associations.get(emailHash);
    return target && this.membershipActive.get(`${target.principalId}:${target.tenantId}`) !== false ? target : undefined;
  }

  async enqueueForInvitedIdentity(input: {
    readonly emailHash: string;
    readonly recipient: string;
    readonly target: InvitedIdentityTarget;
    readonly linkId: string;
    readonly tokenHash: string;
  }): Promise<boolean> {
    if (this.associations.get(input.emailHash)?.principalId !== input.target.principalId ||
        this.membershipActive.get(`${input.target.principalId}:${input.target.tenantId}`) === false) return false;
    const fingerprint = `${input.target.tenantId}:${input.emailHash}:${Math.floor(Date.now() / 60_000)}`;
    if (this.deliveryFingerprints.has(fingerprint)) return false;
    this.deliveryFingerprints.add(fingerprint);
    this.links.set(input.tokenHash, {
      tokenHash: input.tokenHash,
      linkId: input.linkId,
      target: input.target,
      expiresAt: Date.now() + 10 * 60 * 1000,
      consumed: false,
      attempts: 0,
    });
    this.recipientStorage.push(input.recipient);
    this.deliveries.push({ queueId: `queue-${this.deliveries.length + 1}`, linkId: input.linkId, recipient: input.recipient, claimed: false });
    return true;
  }

  async claimNextMail(_leaseOwner: string): Promise<MagicLinkDeliveryClaim | undefined> {
    const item = this.deliveries.find((candidate) => !candidate.claimed);
    if (!item) return undefined;
    item.claimed = true;
    return { queueId: item.queueId, linkId: item.linkId, recipient: item.recipient };
  }

  async markMailDelivered(_queueId: string, _leaseOwner: string): Promise<void> {}
  async markMailFailed(_queueId: string, _leaseOwner: string): Promise<void> {}

  async consumeAndIssueSession(tokenHash: string, material: MagicLinkSessionMaterial): Promise<MagicLinkIssuedSession> {
    this.consumeCalls += 1;
    const link = this.links.get(tokenHash);
    if (!link) throw new IdentityDeniedError();
    link.attempts += 1;
    if (link.consumed || link.expiresAt <= Date.now() ||
        this.membershipActive.get(`${link.target.principalId}:${link.target.tenantId}`) === false) {
      throw new IdentityDeniedError();
    }
    link.consumed = true;
    const availableTenants = [
      { tenantRef: tenantA, roles: ['operator'] as const },
      { tenantRef: tenantB, roles: ['viewer'] as const },
    ];
    const roles: readonly MembershipRole[] = link.target.tenantId === tenantA ? ['operator'] : ['viewer'];
    return Object.freeze({
      ...material,
      principalId: link.target.principalId,
      tenantId: link.target.tenantId,
      roles,
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
      availableTenants: Object.freeze(availableTenants),
    });
  }
}

function harness(): {
  readonly store: FakeMagicLinkStore;
  readonly inbox: LocalMagicLinkInbox;
  readonly limits: TestAbuseLimits;
  readonly service: MagicLinkService;
} {
  const store = new FakeMagicLinkStore();
  store.associations.set(invitedHash, { principalId: principal, tenantId: tenantA, membershipVersion: 1 });
  store.membershipActive.set(`${principal}:${tenantA}`, true);
  store.membershipActive.set(`${principal}:${tenantB}`, true);
  const inbox = new LocalMagicLinkInbox();
  const limits = new TestAbuseLimits();
  return { store, inbox, limits, service: new MagicLinkService(store, limits, inbox, environment) };
}

function fakeResponse(): { readonly response: Response; readonly headers: Map<string, string>; readonly body: () => string; readonly status: () => number } {
  const headers = new Map<string, string>();
  let body = '';
  let status = 0;
  const response = {
    status(value: number) { status = value; return this; },
    type(value: string) { headers.set('Content-Type', value); return this; },
    setHeader(name: string, value: string) { headers.set(name, value); return this; },
    send(value: string) { body = value; return this; },
    end() { body = ''; return this; },
  } as unknown as Response;
  return { response, headers, body: () => body, status: () => status };
}

test('magic-link request is uniform, scoped to preverified identities, and queues a hash-only token for the local inbox', async () => {
  const { store, inbox, limits, service } = harness();
  const known = await service.request(' Invited@Example.Test ', '127.0.0.1');
  const unknown = await service.request('missing@example.test', '127.0.0.1');
  const duplicateKnown = await service.request(invitedEmail, '127.0.0.1');
  assert.deepEqual(known, unknown);
  assert.deepEqual(known, duplicateKnown);
  assert.deepEqual(known, { accepted: true });
  assert.equal(store.links.size, 1);
  assert.equal(store.requestedEmailHashes[0], invitedHash);
  assert.equal(store.requestedEmailHashes[1], createHmac('sha256', recoveryKey)
    .update('ca-meta-magic-link-email-v1\0missing@example.test', 'utf8').digest('hex'));
  assert.equal(store.requestedEmailHashes[2], invitedHash);
  assert.equal(limits.calls.some((call) => call.policy === 'MAGIC_LINK_IDENTITY_REQUEST' && call.dimensions.actor === invitedHash), true);
  assert.equal(limits.calls.some((call) => call.policy === 'MAGIC_LINK_TENANT_REQUEST' && call.dimensions.tenant === tenantA), true);

  assert.equal(await service.processNextDelivery(), true);
  const message = inbox.list()[0];
  assert.ok(message);
  assert.equal(message.recipient, invitedEmail);
  const token = new URL(message.confirmationUrl).searchParams.get('token');
  assert.ok(token);
  const storedLink = [...store.links.values()][0];
  assert.ok(storedLink);
  assert.equal(storedLink.tokenHash, digest(token));
  assert.notEqual(storedLink.tokenHash, token);
  assert.equal(store.recipientStorage[0], invitedEmail);
});

test('confirmation GET and HEAD only render a deliberate POST and never consume a link', async () => {
  const { store, service } = harness();
  const controller = new MagicLinkController(service, environment);
  const token = 'A'.repeat(43);
  const get = fakeResponse();
  controller.confirmationPage(token, get.response);
  assert.equal(get.status(), 200);
  assert.equal(get.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(get.body(), /method="post"/);
  assert.match(get.body(), /Continue to the portal/);
  assert.match(get.body(), /history\.replaceState\(null, '', location\.pathname\)/);
  assert.doesNotMatch(get.body(), /onload|form\.submit\(/i);
  assert.equal(store.consumeCalls, 0);

  const head = fakeResponse();
  controller.confirmationHead(head.response);
  assert.equal(head.status(), 200);
  assert.equal(head.body(), '');
  assert.equal(store.consumeCalls, 0);
});

test('one-use consume is atomic, ignores tenant input, and returns only current membership choices', async () => {
  const { inbox, store, service } = harness();
  await service.request(invitedEmail, '127.0.0.1');
  await service.processNextDelivery();
  const link = new URL(inbox.list()[0]!.confirmationUrl);
  const token = link.searchParams.get('token')!;
  const outcomes = await Promise.allSettled([
    service.consume(token, '127.0.0.1'),
    service.consume(token, '127.0.0.1'),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  const issued = outcomes.find((outcome) => outcome.status === 'fulfilled');
  assert.ok(issued && issued.status === 'fulfilled');
  assert.equal(issued.value.session.tenantId, tenantA);
  assert.deepEqual(issued.value.availableTenants.map((option) => option.tenantRef), [tenantA, tenantB]);
  assert.equal(issued.value.session.sessionCookie.length >= 43, true);
  assert.equal(store.links.get(digest(token))?.consumed, true);
  await assert.rejects(service.consume(token, '127.0.0.1'), IdentityDeniedError);
});

test('expiry and current membership revocation deny session creation with the same safe error', async () => {
  const expired = harness();
  await expired.service.request(invitedEmail, '127.0.0.1');
  await expired.service.processNextDelivery();
  const expiredToken = new URL(expired.inbox.list()[0]!.confirmationUrl).searchParams.get('token')!;
  expired.store.links.get(digest(expiredToken))!.expiresAt = Date.now() - 1;
  await assert.rejects(expired.service.consume(expiredToken, '127.0.0.1'), IdentityDeniedError);

  const revoked = harness();
  await revoked.service.request(invitedEmail, '127.0.0.1');
  await revoked.service.processNextDelivery();
  const revokedToken = new URL(revoked.inbox.list()[0]!.confirmationUrl).searchParams.get('token')!;
  revoked.store.membershipActive.set(`${principal}:${tenantA}`, false);
  await assert.rejects(revoked.service.consume(revokedToken, '127.0.0.1'), IdentityDeniedError);
});

test('tenant quotas suppress delivery without changing the public acceptance result', async () => {
  const { limits, store, service } = harness();
  limits.limited.add('MAGIC_LINK_TENANT_REQUEST');
  const response = await service.request(invitedEmail, '127.0.0.1');
  assert.deepEqual(response, { accepted: true });
  assert.equal(store.links.size, 0);
});

test('derived link token has URL-safe high entropy and a tenant cannot be selected by the browser', async () => {
  const linkId = 'a'.repeat(64);
  const token = deriveMagicLinkToken(linkId, recoveryKey);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(token.length, 43);
  const { inbox, service } = harness();
  await service.request(invitedEmail, '127.0.0.1');
  await service.processNextDelivery();
  const issued = await service.consume(new URL(inbox.list()[0]!.confirmationUrl).searchParams.get('token')!, '127.0.0.1');
  assert.equal(issued.session.tenantId, tenantA);
});
