import { beforeEach } from 'vitest';
import { Subject } from 'rxjs';
import type { components } from '@ca-meta/contracts';
import { PortalContextStore } from '../../core/portal/portal-context.store';
import { PortalSessionService } from '../../core/portal/portal-session.service';
import { WhatsAppTemplatesService, type TemplateAsset } from '../../core/portal/whatsapp-templates.service';
import { PENDING_WHATSAPP_TEMPLATE_ATTEMPTS_STORAGE_KEY } from '../../core/portal/pending-whatsapp-template-attempts';
import { WhatsAppTemplatesComponent } from './whatsapp-templates.component';

const asset = {
  id: '00000000-0000-4000-8000-000000000002',
  kind: 'WHATSAPP_BUSINESS_ACCOUNT',
  displayLabel: 'Conta de teste',
  status: 'ACTIVE',
  authorizationStatus: 'VERIFIED',
  observedAt: '2026-11-10T12:00:00.000Z',
  lastVerifiedAt: '2026-11-10T12:00:00.000Z',
  verificationSource: 'META_API',
  stale: false,
  capabilities: { canSend: false, canManageTemplates: true, canSubscribe: false, canReauthorize: false, canDisconnect: false },
} as TemplateAsset;
const tenantContextRef = 'synthetic-template-context-reference-0001';

beforeEach(() => sessionStorage.removeItem(PENDING_WHATSAPP_TEMPLATE_ATTEMPTS_STORAGE_KEY));

function acceptedJob(jobId = 'job_template_01'): components['schemas']['JobAccepted'] {
  return { jobId, status: 'PENDING', location: `/api/v1/jobs/${jobId}`, requestId: 'req-template-create-01' };
}

function jobStatus(status: components['schemas']['JobStatus']['status']): components['schemas']['JobStatus'] {
  return { id: 'job_template_01', status, operation: 'TEMPLATE_CREATE', createdAt: '2026-11-10T12:00:00.000Z',
    updatedAt: '2026-11-10T12:01:00.000Z', nextAction: status === 'UNKNOWN' || status === 'FAILED' ? 'CHECK_STATUS' : 'NONE',
    requestId: 'req-template-job-01' };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

async function createFixture(options: {
  readonly capabilities?: boolean;
  readonly create?: (assetId: string, request: components['schemas']['TemplateCreateRequest'], key: string) => Promise<components['schemas']['JobAccepted']>;
  readonly job?: (jobId: string) => Promise<components['schemas']['JobStatus']>;
} = {}) {
  const list = vi.fn().mockResolvedValue({ items: [], nextCursor: null, requestId: 'req-template-list-01' });
  const create = vi.fn(options.create ?? (async () => acceptedJob()));
  const job = vi.fn(options.job ?? (async () => ({ jobId: 'job_template_01', status: 'UNKNOWN', requestId: 'req-template-job-01' })));
  const service = {
    accounts: vi.fn().mockResolvedValue([options.capabilities === false ? {
      ...asset, capabilities: { canSend: false, canManageTemplates: false, canSubscribe: false, canReauthorize: false, canDisconnect: false },
    } : asset]),
    list,
    create,
    job,
  } as unknown as WhatsAppTemplatesService;
  const contextChanged$ = new Subject<void>();
  const sessionExpired$ = new Subject<void>();
  const component = new WhatsAppTemplatesComponent(service,
    { ensureCurrentSession: vi.fn().mockResolvedValue({}) } as unknown as PortalSessionService,
    { contextRef: tenantContextRef, contextChanged$: contextChanged$.asObservable(), sessionExpired$: sessionExpired$.asObservable() } as unknown as PortalContextStore);
  component.ngOnInit();
  await settle();
  return { component, service, list, create, job, contextChanged$, sessionExpired$ };
}

describe('WhatsAppTemplatesComponent', () => {
  it('keeps list and create unavailable when local capability evidence is absent', async () => {
    const state = await createFixture({ capabilities: false });
    expect(state.list).not.toHaveBeenCalled();
    state.component.form = { name: 'order_update', language: 'en', category: 'UTILITY', bodyText: 'Ready.' };
    await state.component.createTemplate();
    expect(state.create).not.toHaveBeenCalled();
    expect(state.component.accountCanManageTemplates).toBe(false);
    state.component.ngOnDestroy();
  });

  it('sends local ordered examples and never describes HTTP acceptance as Meta approval', async () => {
    const state = await createFixture();
    state.component.form = { name: 'order_update', language: 'en', category: 'UTILITY', bodyText: 'Hello {{1}}, code {{2}} and again {{1}}' };
    state.component.examplesText = 'Ana\n1234';
    await state.component.createTemplate();
    expect(state.create).toHaveBeenCalledWith(asset.id, {
      name: 'order_update', language: 'en', category: 'UTILITY', bodyText: 'Hello {{1}}, code {{2}} and again {{1}}', exampleValues: ['Ana', '1234'],
    }, expect.stringMatching(/^[A-Za-z0-9._~-]{16,128}$/));
    expect(state.component.statusMessage).toContain('não confirma aprovação do modelo pela Meta');
    state.component.ngOnDestroy();
  });

  it('reuses the idempotency key after an ambiguous request and treats UNKNOWN as unreconciled', async () => {
    const firstFailure = new Error('synthetic network timeout');
    const create = vi.fn()
      .mockRejectedValueOnce(firstFailure)
      .mockResolvedValueOnce(acceptedJob());
    const state = await createFixture({ create: create as never });
    state.component.form = { name: 'order_update', language: 'en', category: 'UTILITY', bodyText: 'Ready.' };
    await state.component.createTemplate();
    expect(state.component.formError).toContain('Consulte o status');
    await state.component.createTemplate();
    expect(create.mock.calls[0]?.[2]).toBe(create.mock.calls[1]?.[2]);
    await state.component.checkJobStatus();
    expect(state.component.jobStatus?.status).toBe('UNKNOWN');
    expect(state.component.statusMessage).toContain('resultado ainda não está confirmado');
    expect(sessionStorage.getItem(PENDING_WHATSAPP_TEMPLATE_ATTEMPTS_STORAGE_KEY)).not.toBeNull();
    state.component.ngOnDestroy();
  });

  it('rejects gaps in BODY examples before calling the API', async () => {
    const state = await createFixture();
    state.component.form = { name: 'order_update', language: 'en', category: 'UTILITY', bodyText: 'Hi {{1}}, then {{3}}' };
    state.component.examplesText = 'Ana\n1234';
    await state.component.createTemplate();
    expect(state.component.formError).toContain('marcadores');
    expect(state.create).not.toHaveBeenCalled();
    state.component.ngOnDestroy();
  });

  it('clears the old tenant draft and ignores an in-flight create after context changes', async () => {
    let resolveCreate!: (value: components['schemas']['JobAccepted']) => void;
    const create = vi.fn(() => new Promise<components['schemas']['JobAccepted']>((resolve) => { resolveCreate = resolve; }));
    const state = await createFixture({ create: create as never });
    state.component.form = { name: 'order_update', language: 'en', category: 'UTILITY', bodyText: 'Private draft.' };
    const pendingCreate = state.component.createTemplate();
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    state.contextChanged$.next();
    await settle();
    expect(sessionStorage.getItem(PENDING_WHATSAPP_TEMPLATE_ATTEMPTS_STORAGE_KEY)).toBeNull();
    expect(state.component.form.name).toBe('');
    expect(state.component.jobId).toBeNull();
    resolveCreate(acceptedJob());
    await pendingCreate;
    expect(state.component.jobId).toBeNull();
    expect(state.component.statusMessage).not.toContain('Pedido enviado');
    state.component.ngOnDestroy();
  });

  it('reuses the persisted key after remount when the first accepted response was lost', async () => {
    const jobs = new Map<string, string>();
    let calls = 0;
    const create = vi.fn(async (_assetId: string, _request: components['schemas']['TemplateCreateRequest'], key: string) => {
      let jobId = jobs.get(key);
      if (!jobId) {
        jobId = 'job_template_01';
        jobs.set(key, jobId);
      }
      calls += 1;
      if (calls === 1) throw new Error('synthetic lost response after durable enqueue');
      return acceptedJob(jobId);
    });

    const firstMount = await createFixture({ create: create as never });
    firstMount.component.form = { name: 'order_update', language: 'en', category: 'UTILITY', bodyText: 'Ready.' };
    await firstMount.component.createTemplate();
    const firstKey = create.mock.calls[0]?.[2];
    expect(sessionStorage.getItem(PENDING_WHATSAPP_TEMPLATE_ATTEMPTS_STORAGE_KEY)).not.toBeNull();
    expect(sessionStorage.getItem(PENDING_WHATSAPP_TEMPLATE_ATTEMPTS_STORAGE_KEY)).not.toContain('Ready.');
    firstMount.sessionExpired$.next();
    expect(sessionStorage.getItem(PENDING_WHATSAPP_TEMPLATE_ATTEMPTS_STORAGE_KEY)).not.toBeNull();
    firstMount.component.ngOnDestroy();

    const secondMount = await createFixture({ create: create as never,
      job: async () => jobStatus('SUCCEEDED') });
    secondMount.component.form = { name: 'order_update', language: 'en', category: 'UTILITY', bodyText: 'Ready.' };
    await secondMount.component.createTemplate();

    expect(create.mock.calls[1]?.[2]).toBe(firstKey);
    expect(jobs.size).toBe(1);
    expect(secondMount.component.jobId).toBe('job_template_01');
    const persisted = sessionStorage.getItem(PENDING_WHATSAPP_TEMPLATE_ATTEMPTS_STORAGE_KEY);
    expect(persisted).not.toBeNull();
    const currentScope = (secondMount.component as unknown as { currentAttemptScope: string | null }).currentAttemptScope;
    expect(currentScope).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(persisted ?? '{}')[currentScope ?? '']?.jobId).toBe('job_template_01');
    await secondMount.component.checkJobStatus();
    expect(secondMount.component.jobStatus?.status).toBe('SUCCEEDED');
    expect(sessionStorage.getItem(PENDING_WHATSAPP_TEMPLATE_ATTEMPTS_STORAGE_KEY)).toBeNull();
    secondMount.component.ngOnDestroy();
  });
});
