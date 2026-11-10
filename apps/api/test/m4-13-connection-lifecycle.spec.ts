import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueryRunner } from 'typeorm';
import { CONNECTION_LIFECYCLE_MIGRATION } from '../src/database/migrations/connection-lifecycle.js';
import { PortalSessionVerifier } from '../src/identity/identity.trust.js';
import { ConnectionLifecycleConfigurationUnavailableError, ConnectionLifecycleService,
  ConnectionLifecycleScopeRequiredError } from '../src/meta-lifecycle/connection-lifecycle.service.js';
import { FailClosedMetaLifecycleCallbackVerifier, MetaLifecycleCallbackIngressService,
  MetaLifecycleCallbackSignatureError, MetaLifecycleCallbackUnavailableError } from '../src/meta-lifecycle/meta-lifecycle-callback.service.js';
import { issueTrustedMetaLifecycleCallback, type ConnectionLifecycleCommandRepository,
  MetaLifecycleCallbackReplayConflictError, type ConnectionLifecycleBinding } from '../src/meta-lifecycle/connection-lifecycle.types.js';
import type { TenantContextService, TenantAuthorizationService } from '../src/identity/identity.service.js';
import type { OnboardingSessionService } from '../src/onboarding/onboarding-session.service.js';
import { OnboardingConfigurationUnavailableError } from '../src/onboarding/onboarding-session.types.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const authorizationId = '10000000-0000-4000-8000-000000000002';
const appConfigurationId = '10000000-0000-4000-8000-000000000003';
const assetId = '10000000-0000-4000-8000-000000000004';
const onboardingId = '10000000-0000-4000-8000-000000000005';
const requestId = '10000000-0000-4000-8000-000000000006';

test('M4.13 migration verifier rejects a missing tenant-scoped command foreign key', async () => {
  const step = CONNECTION_LIFECYCLE_MIGRATION.steps[0];
  assert.ok(step && 'verify' in step);
  const shape = JSON.parse(step.definition) as {
    table: string;
    columns: string[];
    indexes: Array<{ name: string; columns: string[]; unique: boolean }>;
    foreignKeys: Array<{ name: string; columns: string[]; table: string; referencedColumns: string[]; updateRule: string; deleteRule: string }>;
  };
  const runner = (foreignKeys = shape.foreignKeys) => ({
    async query(sql: string) {
      if (sql.includes('information_schema.tables')) return [{ name: shape.table }];
      if (sql.includes('information_schema.columns')) return shape.columns.map((name) => ({ name }));
      if (sql.includes('information_schema.statistics')) return shape.indexes.flatMap((index) =>
        index.columns.map((column_name) => ({ name: index.name, column_name, non_unique: index.unique ? 0 : 1 })));
      if (sql.includes('information_schema.key_column_usage')) return foreignKeys.flatMap((foreignKey) =>
        foreignKey.columns.map((column_name, index) => ({ name: foreignKey.name, column_name,
          referenced_table: foreignKey.table, referenced_column: foreignKey.referencedColumns[index],
          update_rule: foreignKey.updateRule, delete_rule: foreignKey.deleteRule })));
      return [];
    },
  }) as unknown as QueryRunner;
  const context = { queryRunner: runner(), migrationId: CONNECTION_LIFECYCLE_MIGRATION.id, stepId: step.id };
  assert.equal(await step.verify(context), true);
  const missingAssetBinding = shape.foreignKeys.filter(({ name }) => name !== 'fk_ca_meta_connection_command_asset');
  await assert.rejects(step.verify({ ...context, queryRunner: runner(missingAssetBinding) }), /incompatible foreign key/);
});

async function verifiedSession() {
  const verifier = new PortalSessionVerifier({
    async findActiveBySecretHash() {
      return {
        sessionId: '10000000-0000-4000-8000-000000000007',
        principalId: '10000000-0000-4000-8000-000000000008',
        tenantId,
        contextVersion: 1,
        contextRefHash: 'a'.repeat(64),
        csrfTokenHash: 'b'.repeat(64),
        entryMode: 'PORTAL_TOP_LEVEL' as const,
      };
    },
  });
  const session = await verifier.verify('synthetic-portal-session-cookie-000000000');
  assert.ok(session);
  return session;
}

function binding(overrides: Partial<ConnectionLifecycleBinding> = {}): ConnectionLifecycleBinding {
  return Object.freeze({
    tenantId, authorizationId, appConfigurationId, environment: 'test', providerAuthorizationId: 'synthetic-provider-id',
    flowVariant: 'FACEBOOK', authVariant: 'FACEBOOK_LOGIN_FOR_BUSINESS', authorizationState: 'ACTIVE',
    authorizationVersion: 2, assetBindings: 4, ...overrides,
  });
}

function service(overrides: {
  readonly repo?: Partial<ConnectionLifecycleCommandRepository>;
  readonly onboarding?: Partial<OnboardingSessionService>;
} = {}) {
  const calls: unknown[] = [];
  const repo = Object.assign({
    async findBinding() { return binding(); },
    async disconnect(input: Parameters<ConnectionLifecycleCommandRepository['disconnect']>[0]) {
      calls.push(input);
      return Object.freeze({ commandRef: '10000000-0000-4000-8000-000000000009', localState: 'DISCONNECTED',
        cleanupState: 'BLOCKED', safeReasonCode: 'PROVIDER_OFFBOARDING_NOT_CONFIRMED' });
    },
    async associateReauthorization(input: Parameters<ConnectionLifecycleCommandRepository['associateReauthorization']>[0]) { calls.push(input); },
  }, overrides.repo) as ConnectionLifecycleCommandRepository;
  const contexts = { async resolveCurrent() { return { tenantId, principalId: 'actor', roles: ['owner'] }; } };
  const authorization = { async authorize(_scope: unknown, operation: string) { calls.push(operation); } };
  const onboarding = {
    async create() {
      calls.push('ONBOARDING_CREATE');
      return { id: onboardingId, status: 'AWAITING_PROVIDER' as const, expiresAt: '2026-11-10T12:10:00.000Z',
        launchUrl: 'https://provider.invalid/authorize?state=synthetic', };
    },
    ...overrides.onboarding,
  };
  return {
    calls,
    instance: new ConnectionLifecycleService(repo,
      contexts as unknown as TenantContextService,
      authorization as unknown as TenantAuthorizationService,
      onboarding as unknown as OnboardingSessionService),
  };
}

test('M4.13 requires resource scope for a shared authorization and disconnects only the selected asset binding', async () => {
  const { instance, calls } = service();
  const session = await verifiedSession();
  await assert.rejects(instance.disconnect({ session, tenantContextRef: 'synthetic-context-reference-0001',
    authorizationRef: authorizationId, idempotencyKey: 'm4-13-shared-scope-01', correlationId: requestId }),
  ConnectionLifecycleScopeRequiredError);
  assert.equal(calls.filter((call) => typeof call === 'object').length, 0, 'broad request makes no lifecycle write');

  const result = await instance.disconnect({ session, tenantContextRef: 'synthetic-context-reference-0001',
    authorizationRef: authorizationId, assetRef: assetId, idempotencyKey: 'm4-13-asset-scope-01', correlationId: requestId });
  assert.equal(result.localState, 'DISCONNECTED');
  assert.equal(result.cleanupState, 'BLOCKED');
  assert.equal(result.safeReasonCode, 'PROVIDER_OFFBOARDING_NOT_CONFIRMED');
  const write = calls.find((call): call is { assetId: string } => typeof call === 'object' && call !== null && 'assetId' in call);
  assert.equal(write?.assetId, assetId, 'repository receives only the explicit asset reference');
});

test('M4.13 creates a flow-matched reauthorization session and preserves the existing grant', async () => {
  const calls: unknown[] = [];
  const { instance } = service({
    repo: {
      async findBinding() { return binding({ assetBindings: 2, flowVariant: 'WHATSAPP_COEXISTENCE',
        authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING' }); },
      async associateReauthorization(input) { calls.push(input); },
    },
    onboarding: {
      async create(_session, _context, _key, input) { calls.push(input); return {
        id: onboardingId, status: 'AWAITING_PROVIDER', expiresAt: '2026-11-10T12:10:00.000Z',
        launchUrl: 'https://provider.invalid/authorize?state=synthetic',
      }; },
    },
  });
  const session = await verifiedSession();
  const result = await instance.reauthorize({ session, tenantContextRef: 'synthetic-context-reference-0001',
    authorizationRef: authorizationId, idempotencyKey: 'm4-13-reauthorize-01', requestId });
  assert.equal(result.id, onboardingId);
  assert.equal(result.status, 'AWAITING_PROVIDER');
  assert.equal(calls[0] && typeof calls[0] === 'object' && 'flowVariant' in calls[0] ? calls[0].flowVariant : '', 'WHATSAPP_COEXISTENCE');
  assert.equal(calls[1] && typeof calls[1] === 'object' && 'authorizationId' in calls[1] ? calls[1].authorizationId : '', authorizationId);
  assert.equal(calls[1] && typeof calls[1] === 'object' && 'onboardingSessionId' in calls[1] ? calls[1].onboardingSessionId : '', onboardingId);
});

test('M4.13 reports an unavailable provider-launch configuration without changing the prior grant', async () => {
  const { instance, calls } = service({
    onboarding: { async create() { throw new OnboardingConfigurationUnavailableError(); } },
  });
  const session = await verifiedSession();
  await assert.rejects(instance.reauthorize({ session, tenantContextRef: 'synthetic-context-reference-0001',
    authorizationRef: authorizationId, idempotencyKey: 'm4-13-launch-unavailable-01', requestId }),
  ConnectionLifecycleConfigurationUnavailableError);
  assert.equal(calls.some((call) => typeof call === 'object' && call !== null && 'onboardingSessionId' in call), false,
    'no reauthorization association is written when session launch is unavailable');
});

test('M4.13 fail-closed lifecycle callback rejects unverifiable input before processor effects', async () => {
  let processed = 0;
  const ingress = new MetaLifecycleCallbackIngressService(new FailClosedMetaLifecycleCallbackVerifier(), {
    async process() { processed += 1; return 'APPLIED'; },
  });
  await assert.rejects(ingress.receive({ appConfigurationRef: 'synthetic-meta-app', rawBody: Buffer.from('synthetic') }),
    MetaLifecycleCallbackSignatureError);
  assert.equal(processed, 0);
});

test('M4.13 transient verifier failure remains retryable instead of being reported as a forged signature', async () => {
  const ingress = new MetaLifecycleCallbackIngressService({
    async verify() { throw new Error('synthetic verifier configuration unavailable'); },
  }, { async process() { return 'APPLIED'; } });
  await assert.rejects(ingress.receive({ appConfigurationRef: 'synthetic-meta-app', rawBody: Buffer.from('synthetic') }),
    MetaLifecycleCallbackUnavailableError);
});

test('M4.13 callback capability contains only hashes and duplicate event identity is locally idempotent', async () => {
  const callback = issueTrustedMetaLifecycleCallback({
    eventRefHash: 'c'.repeat(64), subjectRefHash: 'd'.repeat(64), appConfigurationRef: 'synthetic-meta-app',
    kind: 'DEAUTHORIZATION', verifiedAt: '2026-11-10T12:00:00.000Z',
  });
  assert.equal('tenantId' in callback, false);
  assert.equal('authorizationId' in callback, false);
  const applied = new Set<string>();
  const ingress = new MetaLifecycleCallbackIngressService({ async verify() { return callback; } }, {
    async process(value) {
      if (applied.has(value.eventRefHash)) return 'DUPLICATE';
      applied.add(value.eventRefHash);
      return 'APPLIED';
    },
  });
  assert.deepEqual(await ingress.receive({ appConfigurationRef: 'synthetic-meta-app', rawBody: Buffer.from('synthetic fixture') }),
    { accepted: true, result: 'APPLIED' });
  assert.deepEqual(await ingress.receive({ appConfigurationRef: 'synthetic-meta-app', rawBody: Buffer.from('synthetic fixture') }),
    { accepted: true, result: 'DUPLICATE' });
  assert.equal(applied.size, 1);
});

test('M4.13 changed payload under a replayed callback identity remains a permanent conflict', async () => {
  const callback = issueTrustedMetaLifecycleCallback({
    eventRefHash: 'e'.repeat(64), subjectRefHash: 'f'.repeat(64), appConfigurationRef: 'synthetic-meta-app',
    kind: 'DEAUTHORIZATION', verifiedAt: '2026-11-10T12:00:00.000Z',
  });
  const ingress = new MetaLifecycleCallbackIngressService({ async verify() { return callback; } }, {
    async process() { throw new MetaLifecycleCallbackReplayConflictError(); },
  });
  await assert.rejects(ingress.receive({ appConfigurationRef: 'synthetic-meta-app', rawBody: Buffer.from('changed synthetic fixture') }),
    MetaLifecycleCallbackReplayConflictError);
});
