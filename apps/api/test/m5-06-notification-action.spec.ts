import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { EntityManager } from 'typeorm';
import type { CredentialResolverService } from '../src/credentials/credential-resolver.service.js';
import { ServiceTenantAuthorizationService } from '../src/identity/identity.service.js';
import { ServiceCredentialVerifier } from '../src/identity/identity.trust.js';
import type { IdentityRepository } from '../src/identity/identity.repository.js';
import type { ServiceTenantGrant } from '../src/identity/identity.types.js';
import { JOB_POLICIES } from '../src/jobs/event-validation.js';
import type { ClaimedJob, JobOutcome, JobStore } from '../src/jobs/job-store.js';
import { DurableWorker, type JobHandler } from '../src/worker/durable-worker.js';
import type { JobExecutionAuthorizationPort } from '../src/jobs/job-execution-authorization.js';
import type { MetaAppConfigRegistry } from '../src/meta-config/meta-app-config.registry.js';
import type { MetaGraphCallResult } from '../src/meta-graph/meta-graph.types.js';
import {
  MetaGraphNotificationActionAdapter,
  notificationActionFinalizer,
  type NotificationActionDirectory,
  type NotificationActionProvider,
  type NotificationActionTarget,
} from '../src/notifications/notification-action.worker.js';

const tenantId = '90000000-0000-4000-8000-000000000061';
const principalId = '90000000-0000-4000-8000-000000000062';
const notificationId = '90000000-0000-4000-8000-000000000063';
const assetId = '90000000-0000-4000-8000-000000000064';
const appConfigurationId = '90000000-0000-4000-8000-000000000065';
const targetId = 'provider-target-private-synthetic-001';
const providerAssetId = 'provider-asset-private-synthetic-001';

class SyntheticCredentialVerifier extends ServiceCredentialVerifier {
  mint() { return this.issueVerifiedServiceCredential(principalId, tenantId); }
  async verifyCredential() { return undefined; }
}

async function serviceScope() {
  const grant: ServiceTenantGrant = {
    tenantId, principalId, principalKind: 'SERVICE', principalStatus: 'ACTIVE', tenantStatus: 'ACTIVE', scopes: ['CREDENTIAL_USE'],
  };
  const repository = {
    async findServiceTenantGrant(principal: string, tenant: string) {
      return principal === principalId && tenant === tenantId ? grant : undefined;
    },
  } as unknown as IdentityRepository;
  return await new ServiceTenantAuthorizationService(repository).resolveScope(new SyntheticCredentialVerifier().mint());
}

function target(overrides: Partial<NotificationActionTarget> = {}): NotificationActionTarget {
  return {
    tenantId, notificationId, assetId, appConfigurationId, environment: 'test',
    assetKind: 'WHATSAPP_PHONE_NUMBER', providerAssetId, providerTargetRef: targetId,
    flowVariant: 'WHATSAPP_EXCLUSIVE', authVariant: 'WHATSAPP_EMBEDDED_SIGNUP', ...overrides,
  };
}

function successResult(): MetaGraphCallResult {
  return { outcome: 'SUCCEEDED', data: { messages: [{ id: 'synthetic-id' }] }, attempts: 1, retries: 0, retryable: false, ambiguous: false };
}

function failedHttp200(): MetaGraphCallResult {
  return { outcome: 'FAILED', error: { category: 'PROVIDER_ERROR', httpStatus: 200, retryable: false, ambiguous: false },
    httpStatus: 200, attempts: 1, retries: 0, retryable: false, ambiguous: false };
}

test('notification action resolves capability through the internal asset and tenant service scope', async () => {
  const scope = await serviceScope();
  const targetCalls: unknown[] = [];
  const credentialCalls: unknown[] = [];
  const providerCalls: unknown[] = [];
  const directory: NotificationActionDirectory = { async resolve(input) {
    targetCalls.push(input);
    return target();
  } };
  const credentials = { async resolve(context: unknown, actor: unknown) {
    credentialCalls.push({ context, actor });
    return { handle: {}, status: 'READY', capability: 'SEND_MESSAGE', family: 'SYNTHETIC', purpose: 'CUSTOMER_OPERATION' };
  } } as unknown as Pick<CredentialResolverService, 'resolve'>;
  const configurations = { resolve: () => ({ configurationRef: 'synthetic-profile', versions: { graphApi: { status: 'VERIFIED' } } }) } as unknown as MetaAppConfigRegistry;
  const provider: NotificationActionProvider = { async execute(input) { providerCalls.push(input); return successResult(); } };
  const adapter = new MetaGraphNotificationActionAdapter(directory, configurations, credentials, provider);
  const action = { action: 'SEND_TEMPLATE', templateName: 'local-approved-template', language: 'en', parameters: ['synthetic'] } as const;
  const result = await adapter.execute({ tenantId, notificationId, assetId, appConfigurationId, environment: 'test',
    request: action, serviceScope: scope, correlationId: 'req-m5-06-credential-test' }, new AbortController().signal);
  assert.deepEqual(result, { kind: 'SUCCEEDED' });
  assert.equal(targetCalls.length, 1);
  assert.equal(credentialCalls.length, 1);
  const call = credentialCalls[0] as { context: { tenantId: string; assetId: string; operation: string } };
  assert.deepEqual(call.context, { tenantId, provider: 'META', appConfigurationId, environment: 'test', assetId, operation: 'SEND_MESSAGE' });
  assert.equal(providerCalls.length, 1);
  const providerInput = providerCalls[0] as { context: { assetId: string }; targetRef: string };
  assert.equal(providerInput.context.assetId, assetId);
  assert.equal(providerInput.targetRef, targetId);
});

test('HTTP 200 error object and null provider results never become success; only exact success may mark READ', async () => {
  const scope = await serviceScope();
  let result: MetaGraphCallResult | null | undefined = failedHttp200();
  const adapter = new MetaGraphNotificationActionAdapter(
    { async resolve() { return target({ assetKind: 'FACEBOOK_PAGE', flowVariant: 'FACEBOOK', authVariant: 'FACEBOOK_LOGIN_FOR_BUSINESS' }); } },
    { resolve: () => ({ configurationRef: 'synthetic-profile', versions: { graphApi: { status: 'VERIFIED' } } }) } as unknown as MetaAppConfigRegistry,
    { async resolve(context: { operation: string }) {
      return { handle: {}, status: 'READY', capability: context.operation, family: 'SYNTHETIC', purpose: 'CUSTOMER_OPERATION' };
    } } as unknown as Pick<CredentialResolverService, 'resolve'>,
    { async execute() { return result; } },
  );
  const input = { tenantId, notificationId, assetId, appConfigurationId, environment: 'test' as const,
    request: { action: 'REPLY_COMMENT', replyText: 'Synthetic response never sent.' } as const,
    serviceScope: scope, correlationId: 'req-m5-06-comment-test' };
  assert.deepEqual(await adapter.execute(input, new AbortController().signal), { kind: 'FAILED_NO_EFFECT' });

  result = null;
  assert.deepEqual(await adapter.execute(input, new AbortController().signal), { kind: 'UNKNOWN' });
  result = undefined;
  assert.deepEqual(await adapter.execute(input, new AbortController().signal), { kind: 'UNKNOWN' });

  const queries: string[] = [];
  const manager = { async query(sql: string) { queries.push(sql); return []; } } as unknown as EntityManager;
  const job = { id: randomUUID(), tenantId, type: 'NOTIFICATION_ACTION',
    payload: { kind: 'NOTIFICATION_ACTION', notificationId, assetId, appConfigurationId, environment: 'test', request: input.request } } as ClaimedJob;
  await notificationActionFinalizer(manager, job, { status: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN', safeErrorAction: 'CHECK_STATUS' });
  assert.equal(queries.some((sql) => sql.includes('UPDATE ca_meta_notifications')), false,
    'UNKNOWN leaves notification unread');
  queries.length = 0;
  await notificationActionFinalizer(manager, job, { status: 'SUCCEEDED', safeErrorCode: null, safeErrorAction: null });
  assert.equal(queries.some((sql) => sql.includes("SET status = 'READ'")), true,
    'only persisted provider success can mark the notification read');
});

test('ambiguous notification worker timeout becomes UNKNOWN once and is not retried', async () => {
  assert.equal(JOB_POLICIES.NOTIFICATION_ACTION.maxAttempts, 1);
  assert.equal(JOB_POLICIES.NOTIFICATION_ACTION.effectMode, 'AMBIGUOUS');
  const job = {
    id: randomUUID(), tenantId, resourceScopeRef: notificationId, type: 'NOTIFICATION_ACTION', lane: 'ONBOARDING',
    effectMode: 'AMBIGUOUS', payload: { kind: 'NOTIFICATION_ACTION', notificationId, assetId, appConfigurationId,
      environment: 'test', request: { action: 'REPLY_COMMENT', replyText: 'Synthetic reply' } },
    idempotencyKey: 'm5-06-worker-key-0001', correlationId: 'req-m5-06-timeout', causationId: null, attempt: 1, maxAttempts: 1,
    claimToken: randomUUID(), workerRef: 'synthetic-worker', budgetStartedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
  } as ClaimedJob;
  let claimed = false;
  const outcomes: JobOutcome[] = [];
  const stop = new AbortController();
  const store: JobStore = {
    async enqueue() { throw new Error('not used'); },
    async enqueueWithin() { throw new Error('not used'); },
    async claimNext() { if (claimed) return null; claimed = true; return job; },
    async renew() { return true; },
    async finish(_job, outcome) { outcomes.push(outcome); stop.abort(); return true; },
  };
  const handler: JobHandler = async (_job, signal) => await new Promise<JobOutcome>((resolve) => {
    signal.addEventListener('abort', () => resolve({ kind: 'SUCCEEDED' }), { once: true });
  });
  const authorization: JobExecutionAuthorizationPort = { async authorize() {
    return { jobId: job.id, tenantId } as never;
  } };
  const worker = new DurableWorker(store, { workerRef: 'm5-06-timeout-worker', leaseMs: 100,
    heartbeatMs: 20, idlePollMs: 1, handlerTimeoutOverrides: { NOTIFICATION_ACTION: 5 }, handlerCancellationGraceMs: 10 },
  new Map([['NOTIFICATION_ACTION', handler]]), authorization);
  await worker.run(stop.signal);
  assert.equal(outcomes.length, 1);
  assert.deepEqual(outcomes[0], { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' });
});
