import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { IdentityDeniedError } from '../src/identity/identity.errors.js';
import { PortalSessionVerifier, type VerifiedPortalSession } from '../src/identity/identity.trust.js';
import { hashTenantContextReference } from '../src/identity/identity.service.js';
import { MysqlWhatsAppTemplatesAccountDirectory, WhatsAppTemplateIdempotencyConflictError,
  WhatsAppTemplateNotFoundError, WhatsAppTemplatesService, WhatsAppTemplatesUnavailableError } from '../src/whatsapp-templates/whatsapp-templates.service.js';
import { TemplateInputError, parseTemplateCreateRequest } from '../src/whatsapp-templates/template-body.js';
import { submitAndReconcileTemplateCreate, type WhatsAppTemplateDispatchAdapter,
  classifyTemplateReconciliationCandidates, type WhatsAppTemplateDispatchInput } from '../src/whatsapp-templates/template-create.worker.js';
import type { AuthorizedTenantScope } from '../src/identity/identity.types.js';
import type { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import type { DurableJobStore, EnqueueJobInput } from '../src/jobs/job-store.js';
import { canonicalJson, parseJobPayload } from '../src/jobs/event-validation.js';
import type { WhatsAppTemplatesAccount } from '../src/whatsapp-templates/whatsapp-templates.service.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const otherTenantId = '00000000-0000-4000-8000-000000000007';
const assetId = '00000000-0000-4000-8000-000000000002';
const appConfigurationId = '00000000-0000-4000-8000-000000000003';
const contextRef = 'synthetic-template-context-reference-0001';
const account: WhatsAppTemplatesAccount = Object.freeze({ tenantId, assetId, appConfigurationId,
  environment: 'test', providerWabaId: '100000000000001' });

async function sessionFor(tenant: string = tenantId): Promise<VerifiedPortalSession> {
  const verifier = new PortalSessionVerifier({
    async findActiveBySecretHash() {
      return { sessionId: '00000000-0000-4000-8000-000000000004', principalId: '00000000-0000-4000-8000-000000000005',
        tenantId: tenant, contextVersion: 1, contextRefHash: hashTenantContextReference(contextRef), csrfTokenHash: 'a'.repeat(64),
        entryMode: 'PORTAL_TOP_LEVEL' as const };
    },
  });
  const session = await verifier.verify('synthetic-session-secret-value-000000000001');
  assert.ok(session);
  return session;
}

function scope(tenant: string = tenantId): AuthorizedTenantScope {
  return { tenantId: tenant, principalId: '00000000-0000-4000-8000-000000000005',
    sessionId: '00000000-0000-4000-8000-000000000004', roles: ['operator'], membershipVersion: 1,
    contextVersion: 1 } as unknown as AuthorizedTenantScope;
}

function setup(options: { readonly currentTenant?: string; readonly allow?: boolean; readonly provider?: object | null;
  readonly createEnabled?: boolean;
  readonly accountFor?: (tenant: string, assetRef: string) => WhatsAppTemplatesAccount | undefined } = {}) {
  const enqueued = new Map<string, { readonly id: string; readonly input: EnqueueJobInput }>();
  const jobStatuses = new Map<string, string>();
  const queryLog: string[] = [];
  let insertionCount = 0;
  let transactionTail = Promise.resolve();
  const payloadHash = (input: EnqueueJobInput): string => createHash('sha256')
    .update(canonicalJson(parseJobPayload(input.type, input.payload)), 'utf8').digest('hex');
  const rowFor = (job: { readonly id: string; readonly input: EnqueueJobInput }) => ({ id: job.id,
    payload_hash: payloadHash(job.input), correlation_id: job.input.correlationId,
    causation_id: job.input.causationId ?? null, resource_scope_ref: job.input.resourceScopeRef ?? '' });
  const manager = {
    async query(statement: string, parameters: readonly unknown[] = []): Promise<unknown[]> {
      queryLog.push(statement);
      if (statement.includes('SELECT id FROM ca_meta_tenants')) return [{ id: parameters[0] }];
      if (statement.includes('AND idempotency_key = ? FOR UPDATE')) {
        const [tenant, idempotencyKey] = parameters;
        const found = [...enqueued.values()].find(({ input }) => input.tenantId === tenant && input.type === 'TEMPLATE_CREATE' &&
          input.idempotencyKey === idempotencyKey);
        return found ? [rowFor(found)] : [];
      }
      if (statement.includes('payload_hash = ?') && statement.includes('status IN')) {
        const [tenant, resource, hash] = parameters;
        const hashHex = Buffer.isBuffer(hash) ? hash.toString('hex') : String(hash);
        return [...enqueued.values()]
          .filter(({ id, input }) => input.tenantId === tenant && input.type === 'TEMPLATE_CREATE' && input.resourceScopeRef === resource &&
            payloadHash(input) === hashHex && ['QUEUED', 'RUNNING', 'RETRY_PENDING', 'UNKNOWN', 'SUCCEEDED'].includes(jobStatuses.get(id) ?? 'QUEUED'))
          .map(({ id }) => ({ id }));
      }
      throw new Error(`Unexpected synthetic query: ${statement}`);
    },
  };
  const databaseSource = {
    async transaction<T>(work: (transactionManager: object) => Promise<T>): Promise<T> {
      const result = transactionTail.then(() => work(manager));
      transactionTail = result.then(() => undefined, () => undefined);
      return await result;
    },
  };
  const database = { async getDataSource() { return databaseSource; } } as unknown as DurableWorkDatabase;
  const jobs = {
    async enqueueWithin(_manager: object, input: EnqueueJobInput) {
      const key = `${input.tenantId}:${input.type}:${input.idempotencyKey}`;
      const existing = enqueued.get(key);
      if (existing) {
        if (JSON.stringify(existing.input.payload) !== JSON.stringify(input.payload)) {
          throw new Error('Idempotency key conflicts with an existing job.');
        }
        return { id: existing.id, duplicate: true };
      }
      const id = `job_template_${++insertionCount}`;
      enqueued.set(key, { id, input });
      jobStatuses.set(id, 'QUEUED');
      return { id, duplicate: false };
    },
  } as unknown as DurableJobStore;
  const calls: Array<{ readonly account: WhatsAppTemplatesAccount; readonly cursor?: string; readonly limit: number }> = [];
  const provider = options.provider === null ? null : options.provider ?? {
    async list(target: WhatsAppTemplatesAccount, input: { readonly cursor?: string; readonly limit: number }) {
      calls.push({ account: target, ...input });
      return { items: [{ id: 'provider-template-1', name: 'order_update', language: 'en', status: 'APPROVED',
        category: 'UTILITY', components: [{ type: 'BODY', text: 'Hello {{1}}, code {{2}} and again {{1}}',
          example: { body_text: [['PRIVATE PROVIDER EXAMPLE']] } }], updatedAt: '2026-11-10T12:00:00Z' }], nextCursor: null, requestId: 'discarded' };
    },
  };
  const tenant = options.currentTenant ?? tenantId;
  const contexts = { async resolveCurrent(_session: VerifiedPortalSession, ref: string) {
    if (ref !== contextRef) throw new IdentityDeniedError();
    return scope(tenant);
  } } as never;
  const authorization = { async authorize(_scope: AuthorizedTenantScope, operation: string, resourceTenantId: string) {
    assert.equal(operation, 'CONNECT');
    assert.equal(resourceTenantId, tenant);
    if (options.allow === false) throw new IdentityDeniedError();
  } } as never;
  const accounts = { async resolve(authorizedScope: AuthorizedTenantScope, assetRef: string) {
    return options.accountFor ? options.accountFor(authorizedScope.tenantId, assetRef) :
      authorizedScope.tenantId === tenantId && assetRef === assetId ? account : undefined;
  }, async resolveForWorker() { return undefined; } };
  const service = new WhatsAppTemplatesService(contexts, authorization, accounts, provider as never, options.createEnabled ?? true, database, jobs);
  return { service, calls, enqueued, queryLog, jobStatuses, get insertions() { return insertionCount; } };
}

const baseBody = Object.freeze({ name: 'order_update', language: 'en', category: 'UTILITY',
  bodyText: 'Hello {{1}}, code {{2}} and again {{1}}', exampleValues: ['Ana', '1234'] });

test('M5.04 BODY validation accepts empty/reused examples and rejects example count, gap, order and malformed braces', () => {
  assert.deepEqual(parseTemplateCreateRequest({ name: 'receipt', language: 'pt_BR', category: 'UTILITY', bodyText: 'Ready.' }).exampleValues, []);
  assert.deepEqual(parseTemplateCreateRequest(baseBody).exampleValues, ['Ana', '1234']);
  for (const invalid of [
    { ...baseBody, exampleValues: ['Ana'] },
    { ...baseBody, bodyText: 'Hi {{1}} {{3}}', exampleValues: ['a', 'b'] },
    { ...baseBody, bodyText: 'Hi {{2}} {{1}}', exampleValues: ['a', 'b'] },
    { ...baseBody, bodyText: 'Hi {{1', exampleValues: ['a'] },
    { ...baseBody, bodyText: 'Hi {{1}}', exampleValues: [] },
  ]) assert.throws(() => parseTemplateCreateRequest(invalid), TemplateInputError);
});

test('M5.04 account directory constrains lookup to the tenant WABA and active verified EXCLUSIVE grant', async () => {
  let sql = '';
  let values: readonly unknown[] = [];
  const database = { async getDataSource() { return { async query(statement: string, parameters: readonly unknown[]) {
    sql = statement; values = parameters;
    return [{ asset_id: assetId, tenant_id: tenantId, app_configuration_id: appConfigurationId,
      environment: 'test', provider_waba_id: '100000000000001' }];
  } }; } } as unknown as DurableWorkDatabase;
  const directory = new MysqlWhatsAppTemplatesAccountDirectory(database, 'test');
  const found = await directory.resolve(scope(), assetId);
  assert.equal(found?.providerWabaId, '100000000000001');
  assert.deepEqual(values.slice(0, 3), [tenantId, assetId, 'test']);
  assert.match(sql, /a\.tenant_id = \? AND a\.id = \?/);
  assert.match(sql, /a\.asset_kind = 'WHATSAPP_BUSINESS_ACCOUNT'/);
  assert.match(sql, /auth\.flow_variant = 'WHATSAPP_EXCLUSIVE'/);
  assert.match(sql, /auth\.authorization_state IN \('ACTIVE', 'PARTIAL'\)/);
  assert.match(sql, /aa\.verification_state = 'VERIFIED'/);
  assert.match(sql, /g\.grant_name = 'whatsapp_business_management' AND g\.status = 'GRANTED'/);
});

test('M5.04 listing preserves observed labels and sanitized BODY text while omitting examples', async () => {
  const fixture = setup();
  const page = await fixture.service.list(await sessionFor(), contextRef, assetId, { cursor: 'opaque/+cursor=', limit: 23 }, 'req-list-01');
  assert.deepEqual(fixture.calls[0], { account, cursor: 'opaque/+cursor=', limit: 23, requestId: 'req-list-01' });
  assert.equal(page.requestId, 'req-list-01');
  assert.equal(page.items[0]?.status, 'APPROVED');
  assert.equal(page.items[0]?.category, 'UTILITY');
  assert.equal(page.items[0]?.bodyText, 'Hello {{1}}, code {{2}} and again {{1}}');
  assert.equal('components' in (page.items[0] ?? {}), false);
  assert.equal(JSON.stringify(page.items).includes('PRIVATE PROVIDER EXAMPLE'), false);
  const session = await sessionFor();
  await assert.rejects(() => fixture.service.list(session, contextRef, assetId, { cursor: 'bad cursor', limit: 23 }, 'req-list-02'), TemplateInputError);
  assert.equal(fixture.calls.length, 1);
});

test('M5.04 prevents cross-tenant and non-granted asset list access', async () => {
  const fixture = setup({ accountFor: () => undefined });
  const otherTenantSession = await sessionFor(otherTenantId);
  await assert.rejects(() => fixture.service.list(otherTenantSession, contextRef, assetId,
    { limit: 50 }, 'req-tenant-01'), WhatsAppTemplateNotFoundError);
  assert.equal(fixture.calls.length, 0);
  const denied = setup({ allow: false });
  const session = await sessionFor();
  await assert.rejects(() => denied.service.list(session, contextRef, assetId, { limit: 50 }, 'req-grant-01'), IdentityDeniedError);
  assert.equal(denied.calls.length, 0);
});

test('M5.04 fails closed when the real list and create adapters are disabled', async () => {
  const session = await sessionFor();
  const list = setup({ provider: null });
  await assert.rejects(() => list.service.list(session, contextRef, assetId, { limit: 50 }, 'req-list-closed-01'), WhatsAppTemplatesUnavailableError);
  const create = setup({ createEnabled: false });
  await assert.rejects(() => create.service.create(session, contextRef, assetId, 'disabled-template-create-key-01', baseBody,
    'req-create-closed-01'), WhatsAppTemplatesUnavailableError);
  assert.equal(create.enqueued.size, 0);
});

test('M5.04 create uses tenant-scoped durable idempotency sequentially and concurrently', async () => {
  const fixture = setup();
  const session = await sessionFor();
  const submit = () => fixture.service.create(session, contextRef, assetId, 'stable-template-create-key-0001', baseBody, 'req-create-01');
  const first = await submit();
  const repeated = await submit();
  const [concurrentA, concurrentB] = await Promise.all([submit(), submit()]);
  assert.deepEqual([first.jobId, repeated.jobId, concurrentA.jobId, concurrentB.jobId], Array(4).fill(first.jobId));
  const otherTab = await fixture.service.create(session, contextRef, assetId, 'different-tab-template-key-0002', baseBody, 'req-create-tab-02');
  assert.equal(otherTab.jobId, first.jobId);
  assert.equal(fixture.insertions, 1);
  assert.equal(fixture.enqueued.values().next().value?.input.type, 'TEMPLATE_CREATE');
  fixture.queryLog.length = 0;
  await assert.rejects(() => fixture.service.create(session, contextRef, assetId, 'stable-template-create-key-0001',
    { ...baseBody, bodyText: 'Different {{1}} body {{2}}' }, 'req-create-02'), WhatsAppTemplateIdempotencyConflictError);
  assert.equal(fixture.queryLog.some((sql) => sql.includes('payload_hash = ?') && sql.includes('status IN')), false,
    'same-key payload conflicts must be resolved before semantic deduplication');
  await assert.rejects(() => fixture.service.create(session, contextRef, assetId, 'stable-template-create-key-0001',
    { ...baseBody, cUUID: 'forbidden' }, 'req-create-03'), TemplateInputError);
});

test('M5.04 semantic create dedupe is atomic across tabs for active, UNKNOWN and SUCCEEDED jobs', async () => {
  for (const status of ['QUEUED', 'RUNNING', 'RETRY_PENDING', 'UNKNOWN', 'SUCCEEDED']) {
    const fixture = setup();
    const session = await sessionFor();
    const original = await fixture.service.create(session, contextRef, assetId, `template-key-original-${status.toLowerCase()}`, baseBody,
      `req-create-${status.toLowerCase()}-01`);
    fixture.jobStatuses.set(original.jobId, status);
    const [tabA, tabB] = await Promise.all([
      fixture.service.create(session, contextRef, assetId, `template-key-tab-a-${status.toLowerCase()}`, baseBody,
        `req-create-${status.toLowerCase()}-02`),
      fixture.service.create(session, contextRef, assetId, `template-key-tab-b-${status.toLowerCase()}`, baseBody,
        `req-create-${status.toLowerCase()}-03`),
    ]);
    assert.deepEqual([tabA.jobId, tabB.jobId], [original.jobId, original.jobId], `${status} must reuse the existing job`);
    assert.equal(fixture.insertions, 1, `${status} must not enqueue another durable job`);
  }
});

test('M5.04 read-only reconciliation handles accepted, rejected, null and ambiguous outcomes without retry', async () => {
  const input: WhatsAppTemplateDispatchInput = { tenantId, assetId, appConfigurationId, environment: 'test', request: parseTemplateCreateRequest(baseBody),
    serviceScope: {} as WhatsAppTemplateDispatchInput['serviceScope'], correlationId: '00000000-0000-4000-8000-000000000006' };
  const run = async (submit: WhatsAppTemplateDispatchAdapter['submit'], reconcile: WhatsAppTemplateDispatchAdapter['reconcile']) => {
    let submissions = 0;
    let observations = 0;
    const adapter = { async submit(...args: Parameters<WhatsAppTemplateDispatchAdapter['submit']>) { submissions += 1; return submit(...args); },
      async reconcile(...args: Parameters<WhatsAppTemplateDispatchAdapter['reconcile']>) { observations += 1; return reconcile(...args); } };
    const outcome = await submitAndReconcileTemplateCreate(adapter, input, new AbortController().signal);
    return { outcome, submissions, observations };
  };
  assert.deepEqual(await run(async () => ({ kind: 'ACCEPTED' }), async () => ({ kind: 'FOUND' })),
    { outcome: { kind: 'SUCCEEDED' }, submissions: 1, observations: 0 });
  assert.equal((await run(async () => ({ kind: 'REJECTED' }), async () => ({ kind: 'FOUND' }))).outcome.kind, 'PERMANENT_FAILURE');
  assert.deepEqual(await run(async () => null, async () => ({ kind: 'AMBIGUOUS' })),
    { outcome: { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' }, submissions: 1, observations: 1 });
  assert.deepEqual(await run(async () => ({ kind: 'UNKNOWN' }), async () => null),
    { outcome: { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' }, submissions: 1, observations: 1 });
  assert.deepEqual(classifyTemplateReconciliationCandidates([], input.request), { kind: 'NOT_FOUND' });
  assert.deepEqual(classifyTemplateReconciliationCandidates([{ name: input.request.name, language: input.request.language,
    category: input.request.category, components: [{ type: 'BODY', text: input.request.bodyText }] }], input.request),
  { kind: 'AMBIGUOUS' }, 'an identical pre-existing template cannot prove that this job caused the effect');
});
