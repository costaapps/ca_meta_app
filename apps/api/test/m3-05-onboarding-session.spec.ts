import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { PortalSessionVerifier, type PortalSessionStore, type StoredPortalSession, type VerifiedPortalSession } from '../src/identity/identity.trust.js';
import { TenantAuthorizationService, TenantContextService } from '../src/identity/identity.service.js';
import {
  hashOnboardingValue,
  OnboardingConfigurationUnavailableError,
  TrustedOnboardingCompletionIssuer,
  type OnboardingNextAction,
  type OnboardingReadiness,
  type OnboardingCreateCommand,
  type OnboardingProviderOutcome,
  type OnboardingSessionStore,
  type OnboardingStatusName,
  type OnboardingStep,
  type OnboardingStoredRecord,
} from '../src/onboarding/onboarding-session.types.js';
import {
  ONBOARDING_STATE_TTL_SECONDS,
  OnboardingCompletionService,
  OnboardingSessionService,
  OnboardingStateSigner,
} from '../src/onboarding/onboarding-session.service.js';

const sessionId = 'a406aaf4-837a-45d7-9f93-4db17920668d';
const principalId = '11de9f8d-efdf-46c9-84b1-9d474a5a35dc';
const initialContext = 'tenant-context-reference-original-01';
const switchedContext = 'tenant-context-reference-switched-02';
const signingKey = Buffer.alloc(32, 0x5a).toString('base64url');
const now = new Date('2026-11-03T12:00:00.000Z');

class MemoryOnboardingStore implements OnboardingSessionStore {
  readonly records = new Map<string, OnboardingStoredRecord>();

  constructor(private readonly clock: () => Date = () => now) {}

  async findByIdempotency(tenantId: string, idempotencyHash: string): Promise<OnboardingStoredRecord | undefined> {
    const record = [...this.records.values()].find((candidate) => candidate.tenantId === tenantId && candidate.idempotencyHash === idempotencyHash);
    if (!record) return undefined;
    if (record.expiresAt <= this.clock() && record.status === 'AWAITING_PROVIDER') {
      const expired = Object.freeze({
        ...record,
        status: 'EXPIRED' as const,
        nextAction: 'NONE' as const,
        stateConsumed: true,
        lastUpdatedAt: this.clock(),
      });
      this.records.set(record.id, expired);
      return expired;
    }
    return record;
  }

  async createOrReplay(command: OnboardingCreateCommand): Promise<OnboardingStoredRecord> {
    const existing = await this.findByIdempotency(command.tenantId, command.idempotencyHash);
    if (existing) return existing;
    const record: OnboardingStoredRecord = Object.freeze({
      ...command,
      status: 'AWAITING_PROVIDER',
      readiness: 'UNKNOWN',
      steps: Object.freeze([
        Object.freeze({ name: 'authorization', status: 'PENDING' as const }),
        Object.freeze({ name: 'asset-verification', status: 'PENDING' as const }),
        Object.freeze({ name: 'subscription', status: 'PENDING' as const }),
        Object.freeze({ name: 'projection', status: 'PENDING' as const }),
      ]),
      nextAction: 'WAIT',
      lastUpdatedAt: now,
      stateConsumed: false,
    });
    this.records.set(record.id, record);
    return record;
  }

  async findForSession(id: string, currentSessionId: string, currentPrincipalId: string): Promise<OnboardingStoredRecord | undefined> {
    const record = this.records.get(id);
    return record?.portalSessionId === currentSessionId && record.principalId === currentPrincipalId ? record : undefined;
  }

  async findByProviderStateHash(providerStateHash: string): Promise<OnboardingStoredRecord | undefined> {
    return [...this.records.values()].find((candidate) => candidate.providerStateHash === providerStateHash);
  }

  async cancelByProviderState(providerStateHash: string): Promise<boolean> {
    const record = [...this.records.values()].find((candidate) => candidate.providerStateHash === providerStateHash);
    if (!record || record.stateConsumed || record.status !== 'AWAITING_PROVIDER') return false;
    this.records.set(record.id, Object.freeze({ ...record, status: 'CANCELLED', nextAction: 'NONE', stateConsumed: true }));
    return true;
  }

  async completeByProviderState(providerStateHash: string, outcome: OnboardingProviderOutcome): Promise<boolean> {
    const record = [...this.records.values()].find((candidate) => candidate.providerStateHash === providerStateHash);
    if (!record || record.stateConsumed || record.status !== 'AWAITING_PROVIDER' || record.expiresAt <= this.clock()) return false;
    this.records.set(record.id, Object.freeze({
      ...record,
      status: outcome.status,
      readiness: outcome.readiness,
      steps: outcome.steps,
      nextAction: outcome.nextAction,
      stateConsumed: true,
      lastUpdatedAt: now,
    }));
    return true;
  }
}

class SyntheticProviderLaunch {
  readonly states: string[] = [];
  async buildAuthorizationUrl(input: { readonly stateRef: string }): Promise<string> {
    this.states.push(input.stateRef);
    const url = new URL('https://provider.synthetic.invalid/authorize');
    url.searchParams.set('state', input.stateRef);
    return url.toString();
  }
}

function makeSession(input: {
  readonly sessionId?: string;
  readonly tenantId?: string;
  readonly contextRef: string;
  readonly contextVersion?: number;
  readonly cookieValue?: string;
}): Promise<VerifiedPortalSession> {
  const row: StoredPortalSession = {
    sessionId: input.sessionId ?? sessionId,
    principalId,
    tenantId: input.tenantId ?? 'tenant-original',
    contextVersion: input.contextVersion ?? 1,
    contextRefHash: hashOnboardingValue(input.contextRef),
    csrfTokenHash: 'b'.repeat(64),
    entryMode: 'SUITE4_EMBED',
  };
  const store = { async findActiveBySecretHash() { return row; } } as unknown as PortalSessionStore;
  return new PortalSessionVerifier(store).verify(input.cookieValue ?? 'synthetic-cookie-value-0123456789').then((session) => {
    assert.ok(session);
    return session;
  });
}

function makeService(
  store: MemoryOnboardingStore,
  launch: SyntheticProviderLaunch,
  authorizationCalls: Array<{ tenantId: string; operation: string }> = [],
  clock: () => Date = () => now,
) {
  const contexts = {
    async resolveCurrent(session: VerifiedPortalSession, contextRef: string) {
      assert.equal(contextRef, initialContext);
      return { principalId: session.principalId, sessionId: session.sessionId, tenantId: session.tenantId };
    },
    async resolveTenantSwitch(session: VerifiedPortalSession, contextRef: string, targetTenantId: string) {
      assert.ok(contextRef === switchedContext || contextRef === initialContext);
      return { principalId: session.principalId, sessionId: session.sessionId, tenantId: targetTenantId };
    },
  } as unknown as TenantContextService;
  const authorization = {
    async authorize(scope: { readonly tenantId: string }, operation: string, targetTenantId: string) {
      assert.equal(scope.tenantId, targetTenantId);
      authorizationCalls.push({ tenantId: targetTenantId, operation });
    },
  } as unknown as TenantAuthorizationService;
  const configurations = {
    resolve(flowVariant: OnboardingCreateCommand['flowVariant']) {
      const authVariant: OnboardingCreateCommand['authVariant'] = flowVariant === 'FACEBOOK_LOGIN' ? 'FACEBOOK_LOGIN_FOR_BUSINESS'
        : flowVariant === 'INSTAGRAM_VIA_FACEBOOK_LOGIN' ? 'INSTAGRAM_VIA_FACEBOOK_LOGIN'
          : flowVariant === 'INSTAGRAM_LOGIN' ? 'INSTAGRAM_LOGIN'
            : flowVariant === 'WHATSAPP_COEXISTENCE' ? 'WHATSAPP_BUSINESS_APP_ONBOARDING' : 'WHATSAPP_EMBEDDED_SIGNUP';
      return { configurationRef: `synthetic-${flowVariant.toLowerCase()}-v1`, providerAppId: 'synthetic-meta-app',
        providerEnvironment: 'test' as const, authVariant,
        capabilityManifestVersion: 'meta-capability-manifest-v1', graphApiVersion: 'v27.0' };
    },
  };
  return new OnboardingSessionService(store, contexts, authorization, new OnboardingStateSigner(signingKey), launch, clock, configurations);
}

const createInput = {
  flowVariant: 'WHATSAPP_CLOUD_API' as const,
  requestedCapabilities: ['SEND_MESSAGE', 'READ_STATUS'],
  returnRoute: 'connections' as const,
};

test('server creates a tenant-bound opaque onboarding ID and idempotent HMAC state without persisting the state value', async () => {
  const store = new MemoryOnboardingStore();
  const launch = new SyntheticProviderLaunch();
  const service = makeService(store, launch);
  const session = await makeSession({ contextRef: initialContext });
  const first = await service.create(session, initialContext, 'onboarding-idem-key-0001', createInput);
  const replay = await service.create(session, initialContext, 'onboarding-idem-key-0001', createInput);

  assert.match(first.id, /^[0-9a-f-]{36}$/i);
  assert.equal(first.status, 'AWAITING_PROVIDER');
  assert.equal(first.expiresAt, new Date(now.getTime() + ONBOARDING_STATE_TTL_SECONDS * 1000).toISOString());
  assert.equal(new URL(first.launchUrl).searchParams.get('state'), launch.states[0]);
  assert.equal(launch.states[0], launch.states[1]);
  assert.equal(replay.id, first.id);
  assert.equal(replay.launchUrl, first.launchUrl);
  assert.equal(store.records.size, 1);
  const record = [...store.records.values()][0];
  assert.ok(record);
  assert.equal(record.tenantId, 'tenant-original');
  assert.equal(record.portalSessionId, session.sessionId);
  assert.equal(record.principalId, session.principalId);
  assert.equal(record.providerStateHash, hashOnboardingValue(launch.states[0] ?? ''));
  assert.equal(JSON.stringify(record).includes(launch.states[0] ?? ''), false);
  assert.equal('tenantId' in first, false);
});

test('missing state-signing configuration fails before creating an onboarding row', async () => {
  const store = new MemoryOnboardingStore();
  const launch = new SyntheticProviderLaunch();
  const contexts = {
    async resolveCurrent(session: VerifiedPortalSession) {
      return { principalId: session.principalId, sessionId: session.sessionId, tenantId: session.tenantId };
    },
  } as unknown as TenantContextService;
  const authorization = { async authorize() {} } as unknown as TenantAuthorizationService;
  const service = new OnboardingSessionService(
    store, contexts, authorization, new OnboardingStateSigner(undefined), launch, () => now,
    { resolve: () => ({ configurationRef: 'synthetic-config-v1', providerAppId: 'synthetic-meta-app',
      providerEnvironment: 'test', authVariant: 'WHATSAPP_EMBEDDED_SIGNUP',
      capabilityManifestVersion: 'meta-capability-manifest-v1', graphApiVersion: 'v27.0' }) },
  );
  const session = await makeSession({ contextRef: initialContext });

  await assert.rejects(
    service.create(session, initialContext, 'onboarding-idem-key-0005', createInput),
    OnboardingConfigurationUnavailableError,
  );
  assert.equal(store.records.size, 0);
  assert.equal(launch.states.length, 0);
});

test('status stays attached to the starting tenant after a valid session tenant switch and is hidden from other sessions', async () => {
  const store = new MemoryOnboardingStore();
  const launch = new SyntheticProviderLaunch();
  const authorizationCalls: Array<{ tenantId: string; operation: string }> = [];
  const service = makeService(store, launch, authorizationCalls);
  const originalSession = await makeSession({ contextRef: initialContext });
  const created = await service.create(originalSession, initialContext, 'onboarding-idem-key-0002', createInput);
  const switchedSession = await makeSession({ tenantId: 'tenant-switched', contextRef: switchedContext, contextVersion: 2 });

  const status = await service.read(switchedSession, created.id, switchedContext);
  assert.equal(status?.status, 'AWAITING_PROVIDER');
  assert.equal(status?.readiness, 'UNKNOWN');
  assert.equal(authorizationCalls.at(-1)?.tenantId, 'tenant-original');
  assert.equal(authorizationCalls.at(-1)?.operation, 'CONNECT');

  const otherSession = await makeSession({ sessionId: '5be3f2f7-ff8b-4440-aad5-5e560c871324', contextRef: initialContext });
  assert.equal(await service.read(otherSession, created.id, initialContext), undefined);
});

test('expired onboarding idempotency replay cannot reissue provider state', async () => {
  let currentTime = now;
  const store = new MemoryOnboardingStore(() => currentTime);
  const launch = new SyntheticProviderLaunch();
  const service = makeService(store, launch, [], () => currentTime);
  const session = await makeSession({ contextRef: initialContext });
  const created = await service.create(session, initialContext, 'onboarding-idem-key-0004', createInput);
  currentTime = new Date(now.getTime() + ONBOARDING_STATE_TTL_SECONDS * 1000 + 1);

  await assert.rejects(service.create(session, initialContext, 'onboarding-idem-key-0004', createInput));
  assert.equal(launch.states.length, 1);
  assert.equal(store.records.get(created.id)?.status, 'EXPIRED');
});

class SyntheticVerifiedProvider extends TrustedOnboardingCompletionIssuer {
  issue(input: {
    readonly stateRef: string;
    readonly status: OnboardingStatusName;
    readonly readiness: OnboardingReadiness;
    readonly steps: readonly OnboardingStep[];
    readonly nextAction: OnboardingNextAction;
    readonly verifiedAssetRefs?: readonly string[];
    readonly subscriptionVerified?: boolean;
    readonly projectionVerified?: boolean;
  }): OnboardingProviderOutcome {
    return this.issueVerifiedOutcome(input);
  }
}

test('only trusted provider evidence can complete onboarding; READY requires nonempty assets plus subscription and projection evidence and is one-use', async () => {
  const store = new MemoryOnboardingStore();
  const launch = new SyntheticProviderLaunch();
  const service = makeService(store, launch);
  const session = await makeSession({ contextRef: initialContext });
  const created = await service.create(session, initialContext, 'onboarding-idem-key-0003', createInput);
  const completion = new OnboardingCompletionService(store);
  const stateRef = launch.states[0] ?? '';

  await assert.rejects(completion.complete({
    stateRef,
    status: 'READY',
    readiness: 'READY',
    steps: [{ name: 'authorization', status: 'SUCCEEDED' }],
    nextAction: 'NONE',
  } as unknown as OnboardingProviderOutcome), ForbiddenException);

  const issuer = new SyntheticVerifiedProvider();
  const incompleteEvidence = issuer.issue({
    stateRef,
    status: 'READY',
    readiness: 'READY',
    steps: [{ name: 'authorization', status: 'SUCCEEDED' }],
    nextAction: 'NONE',
  });
  await assert.rejects(completion.complete(incompleteEvidence), ForbiddenException);

  const verified = issuer.issue({
    stateRef,
    status: 'READY',
    readiness: 'READY',
    steps: [
      { name: 'authorization', status: 'SUCCEEDED', providerPayload: 'never-persist-this' } as unknown as OnboardingStep,
      { name: 'asset-verification', status: 'SUCCEEDED' },
      { name: 'subscription', status: 'SUCCEEDED' },
      { name: 'projection', status: 'SUCCEEDED' },
    ],
    nextAction: 'NONE',
    verifiedAssetRefs: ['asset-catalog-opaque-ref'],
    subscriptionVerified: true,
    projectionVerified: true,
  });
  assert.equal(await completion.complete(verified), true);
  assert.equal(await completion.complete(verified), false);
  const final = await service.read(session, created.id, initialContext);
  assert.equal(final?.status, 'READY');
  assert.equal(final?.readiness, 'READY');
  assert.deepEqual(final?.steps, [
    { name: 'authorization', status: 'SUCCEEDED' },
    { name: 'asset-verification', status: 'SUCCEEDED' },
    { name: 'subscription', status: 'SUCCEEDED' },
    { name: 'projection', status: 'SUCCEEDED' },
  ]);
  assert.equal(JSON.stringify(final).includes('never-persist-this'), false);
});
