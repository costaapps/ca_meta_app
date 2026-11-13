import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { DOCUMENT } from '@angular/common';
import { Inject, Injectable } from '@angular/core';
import { BehaviorSubject, firstValueFrom, type Observable } from 'rxjs';
import { META_API_BASE_URL } from '../config/public-runtime-config';
import { isOpaqueOnboardingRef, validateOAuthReturnEvent } from '../embed/embed-contract';
import { ONBOARDING_PROVIDER_ACTIVATION_ENABLED, ONBOARDING_PROVIDER_LAUNCH, type OnboardingProviderLaunchAdapter, type PreparedOnboardingPopup } from './onboarding-provider-launch';
import { OnboardingSessionStore, type StoredOnboardingReference, type StoredPendingOnboardingCreate } from './onboarding-session-store';
import { ONBOARDING_TENANT_IDENTITY, ONBOARDING_TENANT_IDENTITY_WARNING, type OnboardingTenantIdentityReader } from './onboarding-tenant-identity';
import { parseOnboardingFlowCatalog, type OnboardingFlowProfile, type OnboardingFlowVariant } from './onboarding-flow-catalog';

const FLOW_CATALOG_APP_OFFSETS = [0, 6, 12] as const;

export type OnboardingServerStatusName = 'CREATED' | 'AWAITING_PROVIDER' | 'CODE_RECEIVED' | 'EXCHANGING' |
  'ASSETS_VERIFIED' | 'PROVISIONING' | 'READY' | 'PARTIAL' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
export type OnboardingReadiness = 'READY' | 'PARTIAL' | 'UNKNOWN';
export type OnboardingNextAction = 'WAIT' | 'CHECK_STATUS' | 'REAUTHORIZE' | 'RECONCILE' | 'RESUME' | 'RESOLVE_CONFLICT' | 'NONE';
export type OnboardingStage = 'authorization' | 'asset-verification' | 'subscription' | 'projection';
export type OnboardingRecoveryOption =
  | { readonly action: 'RESUME' | 'RECONCILE'; readonly stage: OnboardingStage; readonly label: string }
  | { readonly action: 'REAUTHORIZE'; readonly label: string };

export interface OnboardingStep {
  readonly name: string;
  readonly status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'RETRY_PENDING' | 'FAILED' | 'UNKNOWN' | 'SKIPPED';
}

export interface OnboardingServerStatus {
  readonly id: string;
  readonly flowVariant: OnboardingFlowVariant;
  readonly status: OnboardingServerStatusName;
  readonly readiness: OnboardingReadiness;
  readonly steps: readonly OnboardingStep[];
  readonly nextAction: OnboardingNextAction;
  readonly lastUpdatedAt: string;
  readonly requestId: string;
}

export interface OnboardingAttemptView {
  readonly id: string;
  readonly expiresAt: string;
  readonly flowVariant?: OnboardingFlowVariant;
  readonly status?: OnboardingServerStatus;
  readonly message: string;
  readonly popupAttached: boolean;
  readonly jobStatus?: string;
  readonly recoveryOptions: readonly OnboardingRecoveryOption[];
}

export interface PortalOnboardingSnapshot {
  readonly catalogState: 'idle' | 'loading' | 'loaded' | 'error';
  readonly profiles: readonly OnboardingFlowProfile[];
  readonly attempts: readonly OnboardingAttemptView[];
  readonly notice: string;
  readonly busy: boolean;
  readonly tenantDisplayName: string | null;
  readonly tenantMutationAllowed: boolean;
  readonly providerActivationEnabled: boolean;
  readonly pendingCreateFlowVariant?: OnboardingFlowVariant;
}

interface MutableAttempt {
  readonly ref: StoredOnboardingReference;
  tenantContextRef?: string;
  flowVariant?: OnboardingFlowVariant;
  status?: OnboardingServerStatus;
  message: string;
  popup?: PreparedOnboardingPopup;
  popupTimer?: number;
  statusTimer?: number;
  statusReadSequence: number;
  statusReadInFlight: boolean;
  statusPollCount: number;
  recoveryInFlight?: boolean;
  locallyDetached?: boolean;
  jobId?: string;
  jobLocation?: string;
  jobStatus?: string;
  jobTimer?: number;
  jobPollCount: number;
  readonly actionKeys: Map<string, string>;
}

interface PortalRequestContext {
  readonly tenantContextRef: string;
  readonly csrfToken: string;
}

class TenantContextChangedError extends Error {
  constructor() { super('The active tenant context no longer matches this onboarding session.'); }
}

interface CreatedSession {
  readonly id: string;
  readonly expiresAt: string;
  readonly launchUrl?: URL;
}

interface AcceptedJob {
  readonly id: string;
  readonly location: string;
}

const STATUS_NAMES = new Set<string>([
  'CREATED', 'AWAITING_PROVIDER', 'CODE_RECEIVED', 'EXCHANGING', 'ASSETS_VERIFIED', 'PROVISIONING',
  'READY', 'PARTIAL', 'CANCELLED', 'EXPIRED', 'FAILED',
]);
const READINESS_NAMES = new Set<string>(['READY', 'PARTIAL', 'UNKNOWN']);
const NEXT_ACTIONS = new Set<string>(['WAIT', 'CHECK_STATUS', 'REAUTHORIZE', 'RECONCILE', 'RESUME', 'RESOLVE_CONFLICT', 'NONE']);
const STEP_STATUSES = new Set<string>(['PENDING', 'RUNNING', 'SUCCEEDED', 'RETRY_PENDING', 'FAILED', 'UNKNOWN', 'SKIPPED']);
const STAGES = new Set<string>(['authorization', 'asset-verification', 'subscription', 'projection']);
const RESUMABLE_STAGES = new Set<string>(['asset-verification', 'subscription', 'projection']);
const TERMINAL_STATUSES = new Set<string>(['READY', 'CANCELLED', 'EXPIRED', 'FAILED']);
const MAX_STATUS_POLLS = 8;
const MAX_JOB_POLLS = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128;
}

function isAuthoritativeReady(status: OnboardingServerStatus): boolean {
  return status.status === 'READY' && status.readiness === 'READY' && status.nextAction === 'NONE' &&
    (['authorization', 'asset-verification', 'subscription', 'projection'] as const).every((stage) =>
      status.steps.some((step) => step.name === stage && step.status === 'SUCCEEDED'));
}

export function parseOnboardingServerStatus(value: unknown, expectedId: string): OnboardingServerStatus | undefined {
  const allowedKeys = ['id', 'flowVariant', 'status', 'readiness', 'steps', 'phoneReadiness', 'nextAction', 'lastUpdatedAt', 'requestId'];
  if (!isRecord(value) || !exactKeys(value, allowedKeys) || value['id'] !== expectedId ||
      !isOpaqueOnboardingRef(value['id']) ||
      !['FACEBOOK_LOGIN', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN', 'WHATSAPP_CLOUD_API', 'WHATSAPP_COEXISTENCE'].includes(String(value['flowVariant'])) ||
      !STATUS_NAMES.has(String(value['status'])) || !READINESS_NAMES.has(String(value['readiness'])) ||
      !NEXT_ACTIONS.has(String(value['nextAction'])) || !Array.isArray(value['steps']) || value['steps'].length > 32 ||
      typeof value['lastUpdatedAt'] !== 'string' || Number.isNaN(Date.parse(value['lastUpdatedAt'])) || !validRequestId(value['requestId'])) return undefined;
  if (value['phoneReadiness'] !== undefined && (!Array.isArray(value['phoneReadiness']) || value['phoneReadiness'].length > 100 ||
      !value['phoneReadiness'].every((item) => isRecord(item) && exactKeys(item, ['assetRef', 'state', 'reasonCode', 'observedAt']) &&
        typeof item['assetRef'] === 'string' && /^[0-9a-f-]{36}$/i.test(item['assetRef']) &&
        ['READY', 'ACTION_REQUIRED', 'UNKNOWN'].includes(String(item['state'])) &&
        typeof item['reasonCode'] === 'string' && item['reasonCode'].length <= 96 &&
        typeof item['observedAt'] === 'string' && !Number.isNaN(Date.parse(item['observedAt']))))) return undefined;

  const steps: OnboardingStep[] = [];
  for (const step of value['steps']) {
    if (!isRecord(step) || !exactKeys(step, ['name', 'status']) || typeof step['name'] !== 'string' ||
        step['name'].length < 1 || step['name'].length > 64 || !STEP_STATUSES.has(String(step['status']))) return undefined;
    steps.push(Object.freeze({ name: step['name'], status: step['status'] as OnboardingStep['status'] }));
  }
  const status: OnboardingServerStatus = Object.freeze({
    id: expectedId,
    flowVariant: value['flowVariant'] as OnboardingFlowVariant,
    status: value['status'] as OnboardingServerStatusName,
    readiness: value['readiness'] as OnboardingReadiness,
    steps: Object.freeze(steps),
    nextAction: value['nextAction'] as OnboardingNextAction,
    lastUpdatedAt: value['lastUpdatedAt'],
    requestId: value['requestId'],
  });
  if ((status.status === 'READY' && !isAuthoritativeReady(status)) ||
      (status.status === 'PARTIAL' && status.readiness !== 'PARTIAL')) return undefined;
  return status;
}

function parseCreatedSession(value: unknown, launch: OnboardingProviderLaunchAdapter, now: number): CreatedSession | undefined {
  if (!isRecord(value) || !exactKeys(value, ['id', 'status', 'expiresAt', 'launchUrl', 'requestId']) ||
      !isOpaqueOnboardingRef(value['id']) || value['status'] !== 'AWAITING_PROVIDER' ||
      typeof value['expiresAt'] !== 'string' || !validRequestId(value['requestId']) ||
      typeof value['launchUrl'] !== 'string' || value['launchUrl'].length > 4096) return undefined;
  const expiry = Date.parse(value['expiresAt']);
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 15 * 60_000) return undefined;
  try {
    const url = new URL(value['launchUrl']);
    return Object.freeze({ id: value['id'], expiresAt: value['expiresAt'], ...(launch.isAllowed(url) ? { launchUrl: url } : {}) });
  } catch {
    return Object.freeze({ id: value['id'], expiresAt: value['expiresAt'] });
  }
}

function parseAcceptedJob(value: unknown): AcceptedJob | undefined {
  if (!isRecord(value) || !exactKeys(value, ['jobId', 'status', 'location', 'requestId']) ||
      typeof value['jobId'] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value['jobId']) ||
      value['status'] !== 'PENDING' || typeof value['location'] !== 'string' ||
      !/^\/api\/v1\/jobs\/[A-Za-z0-9_-]+$/.test(value['location']) || !validRequestId(value['requestId'])) return undefined;
  return Object.freeze({ id: value['jobId'], location: value['location'] });
}

function parseJobStatus(value: unknown, expectedId: string): string | undefined {
  const allowed = ['PENDING', 'RUNNING', 'RETRY_PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED'];
  if (!isRecord(value) || !exactKeys(value, ['id', 'status', 'operation', 'createdAt', 'updatedAt', 'nextAction', 'safeError', 'requestId']) ||
      value['id'] !== expectedId || typeof value['status'] !== 'string' || !allowed.includes(value['status']) ||
      typeof value['operation'] !== 'string' || value['operation'].length < 1 || value['operation'].length > 64 ||
      typeof value['createdAt'] !== 'string' || Number.isNaN(Date.parse(value['createdAt'])) ||
      typeof value['updatedAt'] !== 'string' || Number.isNaN(Date.parse(value['updatedAt'])) ||
      typeof value['nextAction'] !== 'string' || value['nextAction'].length > 64 || !validRequestId(value['requestId'])) return undefined;
  return value['status'];
}

function readCsrfToken(documentRef: Document): string | undefined {
  const matches = documentRef.cookie.split(';').map((part) => part.trim()).filter((part) => part.startsWith('__Host-ca_meta_csrf='));
  if (matches.length !== 1) return undefined;
  const token = matches[0].slice('__Host-ca_meta_csrf='.length);
  return /^[A-Za-z0-9._~-]{16,512}$/.test(token) ? token : undefined;
}

function requestIdempotencyKey(documentRef: Document): string | undefined {
  const id = documentRef.defaultView?.crypto?.randomUUID?.();
  return typeof id === 'string' && /^[A-Fa-f0-9-]{36}$/.test(id) ? id : undefined;
}

function sameRequestedCapabilities(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isFinalStatus(status: OnboardingServerStatus | undefined): boolean {
  return status !== undefined && TERMINAL_STATUSES.has(status.status);
}

function stageLabel(stage: string): string {
  const labels: Readonly<Record<string, string>> = Object.freeze({
    authorization: 'autorização',
    'asset-verification': 'verificação dos recursos',
    subscription: 'assinaturas',
    projection: 'atualização da conexão',
  });
  return labels[stage] ?? 'etapa pendente';
}

function statusMessage(status: OnboardingServerStatus): string {
  if (isAuthoritativeReady(status)) return 'O servidor confirmou esta conexão.';
  if (status.status === 'PARTIAL') return 'A conexão está parcial. Siga somente a ação de recuperação indicada pelo servidor.';
  if (status.status === 'CANCELLED') return 'Esta autorização foi cancelada. As conexões anteriores continuam disponíveis.';
  if (status.status === 'EXPIRED') return 'A autorização expirou. Inicie uma nova autorização para continuar.';
  if (status.status === 'FAILED') return 'Esta tentativa falhou. As conexões anteriores foram preservadas.';
  return 'Aguardando a confirmação do servidor. A janela do provedor não confirma a conexão.';
}

@Injectable({ providedIn: 'root' })
export class PortalOnboardingService {
  private readonly baseUrl: string;
  private readonly attempts = new Map<string, MutableAttempt>();
  private readonly stateSubject: BehaviorSubject<PortalOnboardingSnapshot>;
  private initialized?: Promise<void>;
  private catalogLoadSequence = 0;
  private busy = false;
  private pendingCreate?: StoredPendingOnboardingCreate;
  private catalogTenantContextRef?: string;
  private currentTenantContextRef?: string;

  readonly state$: Observable<PortalOnboardingSnapshot>;

  constructor(
    private readonly http: HttpClient,
    @Inject(META_API_BASE_URL) baseUrl: string,
    @Inject(DOCUMENT) private readonly documentRef: Document,
    private readonly store: OnboardingSessionStore,
    @Inject(ONBOARDING_TENANT_IDENTITY) private readonly tenantIdentity: OnboardingTenantIdentityReader,
    @Inject(ONBOARDING_PROVIDER_LAUNCH) private readonly providerLaunch: OnboardingProviderLaunchAdapter,
    @Inject(ONBOARDING_PROVIDER_ACTIVATION_ENABLED) private readonly providerActivationEnabled: boolean,
  ) {
    const normalized = baseUrl.replace(/\/+$/, '');
    this.baseUrl = normalized.endsWith('/v1') ? normalized : `${normalized || '/api'}/v1`;
    this.stateSubject = new BehaviorSubject<PortalOnboardingSnapshot>(this.buildSnapshot({
      catalogState: 'idle', profiles: Object.freeze([]), notice: '', busy: false,
    }));
    this.state$ = this.stateSubject.asObservable();
    this.documentRef.defaultView?.addEventListener('message', this.onProviderMessage);
  }

  getSnapshot(): PortalOnboardingSnapshot { return this.stateSubject.value; }

  async initialize(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = Promise.all([this.loadCatalog(), this.restoreSessions()]).then(() => undefined).finally(() => {
      if (this.tenantIdentity.current().confirmed !== true && this.stateSubject.value.notice === '') this.setNotice(ONBOARDING_TENANT_IDENTITY_WARNING);
    });
    return this.initialized;
  }

  async loadCatalog(): Promise<void> {
    const sequence = ++this.catalogLoadSequence;
    this.update({ catalogState: 'loading' });
    try {
      const context = await this.readRequestContext(false);
      const [bootstrap, firstFlowPage]: [unknown, unknown] = await Promise.all([
        firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/meta/bootstrap`, { withCredentials: true })),
        this.readFlowCatalogPage(context, 0),
      ]);
      if (sequence !== this.catalogLoadSequence) return;
      if (this.currentTenantContextRef !== context.tenantContextRef) throw new Error('catalog-tenant-context-changed');
      const flowList = await this.readCompleteFlowCatalog(context, firstFlowPage);
      if (sequence !== this.catalogLoadSequence) return;
      if (this.currentTenantContextRef !== context.tenantContextRef) throw new Error('catalog-tenant-context-changed');
      const profiles = parseOnboardingFlowCatalog(bootstrap, flowList);
      if (!profiles) throw new Error('invalid catalog');
      this.catalogTenantContextRef = context.tenantContextRef;
      this.update({ catalogState: 'loaded', profiles });
    } catch {
      if (sequence !== this.catalogLoadSequence) return;
      this.catalogTenantContextRef = undefined;
      this.update({ catalogState: 'error', profiles: Object.freeze([]), notice: 'Não foi possível carregar as opções de conexão.' });
    }
  }

  private readFlowCatalogPage(context: PortalRequestContext, appOffset: 0 | 6 | 12): Promise<unknown> {
    return firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/integrations/flows`, {
      withCredentials: true,
      headers: new HttpHeaders({ 'X-Tenant-Context': context.tenantContextRef }),
      ...(appOffset === 0 ? {} : { params: { appOffset } }),
    }));
  }

  private async readCompleteFlowCatalog(context: PortalRequestContext, firstPage: unknown): Promise<unknown> {
    const items: unknown[] = [];
    let page: unknown = firstPage;
    for (const [index, appOffset] of FLOW_CATALOG_APP_OFFSETS.entries()) {
      if (index > 0) {
        if (this.currentTenantContextRef !== context.tenantContextRef) throw new Error('catalog-tenant-context-changed');
        page = await this.readFlowCatalogPage(context, appOffset);
      }
      if (!isRecord(page) || Object.keys(page).some((key) => !['items', 'truncated', 'requestId'].includes(key)) ||
          !Array.isArray(page['items']) || page['items'].length > (appOffset === 12 ? 20 : 30) ||
          page['items'].length > 32 || page['items'].length % 5 !== 0 ||
          typeof page['truncated'] !== 'boolean' || typeof page['requestId'] !== 'string' ||
          page['requestId'].length < 1 || page['requestId'].length > 128) return undefined;
      items.push(...page['items']);
      if (items.length > 80) return undefined;
      if (page['truncated'] === false) {
        return Object.freeze({ items: Object.freeze(items), truncated: false, requestId: page['requestId'] });
      }
    }
    return undefined;
  }

  async restoreSessions(): Promise<void> {
    let context: PortalRequestContext;
    try {
      context = await this.readRequestContext(false);
    } catch {
      this.setNotice('Não foi possível confirmar o contexto atual para retomar autorizações.');
      return;
    }
    const references = this.store.read(context.tenantContextRef);
    this.pendingCreate = this.store.pendingCreate(context.tenantContextRef);
    if (this.pendingCreate) {
      this.setNotice('Uma tentativa anterior pode ter sido aceita pelo servidor. Escolha novamente o mesmo fluxo para consultar a sessão existente com segurança.');
    }
    for (const ref of references) {
      if (!this.attempts.has(ref.id)) {
        this.attempts.set(ref.id, {
          ref,
          tenantContextRef: context.tenantContextRef,
          message: 'Consultando a sessão persistida no servidor…',
          statusReadSequence: 0,
          statusReadInFlight: false,
          statusPollCount: 0,
          jobPollCount: 0,
          actionKeys: new Map(),
        });
      }
    }
    this.publish();
    await Promise.all(references.map((ref) => this.refreshStatus(ref.id, false)));
  }

  canStart(profile: OnboardingFlowProfile): boolean {
    const capability = this.tenantIdentity.current();
    if (!capability.confirmed || !capability.tenantDisplayName.trim() || !this.providerActivationEnabled ||
        this.busy || !profile.enabled || profile.blockedReason !== null ||
        this.getSnapshot().catalogState !== 'loaded' || this.catalogTenantContextRef !== this.currentTenantContextRef) return false;
    if (this.pendingCreate && (profile.flowVariant !== this.pendingCreate.flowVariant ||
        !sameRequestedCapabilities(profile.requestedCapabilities, this.pendingCreate.requestedCapabilities))) return false;
    if (profile.flowVariant === 'WHATSAPP_COEXISTENCE' && this.hasActiveCoexistence()) return false;
    return true;
  }

  async start(profileChoice: OnboardingFlowProfile): Promise<boolean> {
    const capability = this.tenantIdentity.current();
    if (!capability.confirmed || !capability.tenantDisplayName.trim()) {
      this.setNotice(ONBOARDING_TENANT_IDENTITY_WARNING);
      return false;
    }
    if (!this.providerActivationEnabled) {
      this.setNotice('Os fluxos Meta permanecem desativados até a evidência externa de segurança e elegibilidade ser confirmada.');
      return false;
    }
    if (this.busy) return false;
    if (!this.store.ensureAvailable()) {
      this.setNotice('O armazenamento desta aba está indisponível; não é seguro iniciar uma autorização que não poderá ser retomada após recarregar.');
      return false;
    }
    if (this.getSnapshot().catalogState !== 'loaded') {
      this.setNotice('Aguarde o catálogo autorizado ser carregado antes de iniciar uma conexão.');
      return false;
    }
    const selected = this.getSnapshot().profiles.find((item) => item.flowVariant === profileChoice.flowVariant && item.authVariant === profileChoice.authVariant);
    if (!selected || !selected.enabled || selected.blockedReason) {
      this.setNotice(selected?.blockedReason ?? 'Este fluxo não está habilitado pelo servidor.');
      return false;
    }
    if (this.pendingCreate && (selected.flowVariant !== this.pendingCreate.flowVariant ||
        !sameRequestedCapabilities(selected.requestedCapabilities, this.pendingCreate.requestedCapabilities))) {
      this.setNotice('Retome a tentativa pendente pelo mesmo fluxo antes de iniciar outra autorização.');
      return false;
    }

    // Open the blank popup synchronously in the click handler; catalog/session work can resume afterward.
    const popup = this.providerLaunch.prepare();
    if (!popup) {
      this.setNotice('A janela de autorização foi bloqueada ou não está disponível. Permita pop-ups e tente novamente.');
      return false;
    }
    this.busy = true;
    this.update({ busy: true, notice: '' });
    let requestSent = false;
    let popupTransferred = false;
    let requestContextForCreate: PortalRequestContext | undefined;
    let createIdempotencyKey: string | undefined;
    try {
      await this.initialize();
      if (!this.assertTenantMutationAllowed()) throw new Error('tenant-identity-unconfirmed');
      if (!this.providerActivationEnabled) throw new Error('provider-activation-disabled');
      const profile = this.getSnapshot().profiles.find((item) => item.flowVariant === profileChoice.flowVariant && item.authVariant === profileChoice.authVariant);
      if (!profile || !profile.enabled || profile.blockedReason) {
        throw new Error(profile?.blockedReason ?? 'flow-disabled');
      }
      if (profile.flowVariant === 'WHATSAPP_COEXISTENCE' && this.hasActiveCoexistence()) {
        throw new Error('coexistence-session-active');
      }
      if (!this.store.ensureAvailable()) throw new Error('session-storage-unavailable');
      const requestContext = await this.readRequestContext(true);
      requestContextForCreate = requestContext;
      if (!this.store.ensureAvailable(requestContext.tenantContextRef)) throw new Error('session-storage-unavailable');
      if (!this.assertTenantMutationAllowed()) throw new Error('tenant-identity-unconfirmed');
      const currentProfile = this.getSnapshot().profiles.find((item) =>
        item.flowVariant === profile.flowVariant && item.authVariant === profile.authVariant);
      if (!this.catalogTenantContextRef || this.catalogTenantContextRef !== requestContext.tenantContextRef || currentProfile !== profile) {
        throw new Error('catalog-tenant-context-changed');
      }
      const storedPending = this.store.pendingCreate(requestContext.tenantContextRef);
      if (storedPending && (storedPending.flowVariant !== profile.flowVariant ||
          !sameRequestedCapabilities(storedPending.requestedCapabilities, profile.requestedCapabilities))) {
        throw new Error('pending-create-profile-mismatch');
      }
      let idempotencyKey = storedPending?.idempotencyKey;
      if (!idempotencyKey) {
        idempotencyKey = requestIdempotencyKey(this.documentRef);
        if (!idempotencyKey) throw new Error('idempotency-key-unavailable');
        if (!this.store.rememberPendingCreate(idempotencyKey, profile.flowVariant, profile.requestedCapabilities, requestContext.tenantContextRef)) {
          throw new Error('pending-create-storage-failed');
        }
      }
      createIdempotencyKey = idempotencyKey;
      this.pendingCreate = this.store.pendingCreate(requestContext.tenantContextRef);
      requestSent = true;
      const response: unknown = await firstValueFrom(this.http.post<unknown>(`${this.baseUrl}/onboarding-sessions`, {
        flowVariant: profile.flowVariant,
        requestedCapabilities: [...profile.requestedCapabilities],
        returnRoute: 'connections',
      }, {
        withCredentials: true,
        headers: new HttpHeaders({
          'X-Tenant-Context': requestContext.tenantContextRef,
          'X-CSRF-Token': requestContext.csrfToken,
          'Idempotency-Key': idempotencyKey,
        }),
      }));
      const created = parseCreatedSession(response, this.providerLaunch, Date.now());
      if (!created || this.attempts.has(created.id)) throw new Error('invalid-onboarding-creation');
      if (!this.store.completePendingCreate(created.id, created.expiresAt, requestContext.tenantContextRef, idempotencyKey)) {
        throw new Error('session-storage-write-failed');
      }
      this.pendingCreate = undefined;
      const attempt: MutableAttempt = {
        ref: Object.freeze({ id: created.id, expiresAt: created.expiresAt }),
        tenantContextRef: requestContext.tenantContextRef,
        flowVariant: profile.flowVariant,
        message: 'Sessão criada. Consultando a confirmação do servidor…',
        popup,
        statusReadSequence: 0,
        statusReadInFlight: false,
        statusPollCount: 0,
        jobPollCount: 0,
        actionKeys: new Map(),
      };
      this.attempts.set(created.id, attempt);
      popupTransferred = true;
      this.publish();
      if (!created.launchUrl || !popup.navigate(created.launchUrl)) {
        popup.close();
        attempt.popup = undefined;
        attempt.locallyDetached = true;
        attempt.message = 'A autorização não pôde ser aberta. O estado permanece no servidor; consulte-o antes de tentar novamente.';
      } else {
        this.watchPopup(created.id, attempt);
      }
      await this.refreshStatus(created.id, false);
      return true;
    } catch (error) {
      if (!popupTransferred) popup.close();
      if (requestSent) {
        if (this.isActiveCoexistenceConflict(error)) {
          if (requestContextForCreate && createIdempotencyKey) {
            this.store.forgetPendingCreate(requestContextForCreate.tenantContextRef, createIdempotencyKey);
          }
          if (this.pendingCreate?.idempotencyKey === createIdempotencyKey) this.pendingCreate = undefined;
          this.setNotice('Já existe uma autorização WhatsApp Coexistence em andamento para esta empresa. Consulte ou conclua a sessão atual antes de iniciar outro número.');
        } else {
          // Keep the pre-send key so only an explicit same-flow retry can replay the create safely.
          this.setNotice('O resultado da abertura da sessão não foi confirmado. Escolha novamente o mesmo fluxo para retomar com a chave já reservada.');
        }
      } else if (error instanceof Error && error.message === 'tenant-identity-unconfirmed') {
        this.setNotice(ONBOARDING_TENANT_IDENTITY_WARNING);
      } else if (error instanceof Error && error.message === 'coexistence-session-active') {
        this.setNotice('Conclua ou recupere a sessão atual antes de autorizar outro número Coexistence.');
      } else if (error instanceof Error && error.message === 'provider-activation-disabled') {
        this.setNotice('Os fluxos Meta permanecem desativados até a evidência externa de segurança e elegibilidade ser confirmada.');
      } else if (error instanceof Error && error.message === 'catalog-tenant-context-changed') {
        this.setNotice('O contexto da empresa mudou. Atualize as opções de autorização antes de continuar.');
        if (this.getSnapshot().catalogState !== 'loading') void this.loadCatalog();
      } else if (error instanceof Error && error.message === 'pending-create-profile-mismatch') {
        this.setNotice('Retome a tentativa pendente pelo mesmo fluxo e capacidades antes de iniciar outra autorização.');
      } else {
        this.setNotice('Não foi possível preparar uma sessão de autorização. Nenhum código ou token foi reenviado.');
      }
      return false;
    } finally {
      this.busy = false;
      this.update({ busy: false });
    }
  }

  async refreshStatus(id: string, resetBackoff = true): Promise<void> {
    const attempt = this.attempts.get(id);
    if (!attempt || Date.parse(attempt.ref.expiresAt) <= Date.now()) {
      if (attempt) {
        this.clearAttemptTimers(attempt);
        if (attempt.tenantContextRef) this.store.forget(id, attempt.tenantContextRef);
        this.attempts.delete(id);
        this.publish();
      }
      return;
    }
    if (attempt.statusReadInFlight) return;
    if (resetBackoff) attempt.statusPollCount = 0;
    attempt.statusReadInFlight = true;
    const sequence = ++attempt.statusReadSequence;
    try {
      const context = await this.readRequestContext(false);
      if (sequence !== attempt.statusReadSequence) return;
      if (!attempt.tenantContextRef) attempt.tenantContextRef = context.tenantContextRef;
      if (attempt.tenantContextRef !== context.tenantContextRef) throw new TenantContextChangedError();
      const response: unknown = await firstValueFrom(this.http.get<unknown>(
        `${this.baseUrl}/onboarding-sessions/${encodeURIComponent(id)}`,
        { withCredentials: true, headers: new HttpHeaders({ 'X-Tenant-Context': context.tenantContextRef }) },
      ));
      if (sequence !== attempt.statusReadSequence) return;
      if (this.currentTenantContextRef !== context.tenantContextRef || attempt.tenantContextRef !== context.tenantContextRef) {
        throw new TenantContextChangedError();
      }
      const status = parseOnboardingServerStatus(response, id);
      if (!status || (attempt.flowVariant !== undefined && status.flowVariant !== attempt.flowVariant)) throw new Error('invalid-status');
      const prior = attempt.status;
      attempt.flowVariant = status.flowVariant;
      attempt.status = status;
      attempt.message = attempt.locallyDetached && !isFinalStatus(status)
        ? `${statusMessage(status)} A janela foi fechada localmente; isso não cancela a sessão do servidor.`
        : statusMessage(status);
      if (!prior || prior.nextAction !== status.nextAction || prior.status !== status.status ||
          prior.steps.map((step) => `${step.name}:${step.status}`).join('|') !== status.steps.map((step) => `${step.name}:${step.status}`).join('|')) {
        attempt.actionKeys.clear();
      }
      if (isFinalStatus(status)) {
        this.clearAttemptTimers(attempt);
        attempt.popup?.close();
        attempt.popup = undefined;
      } else {
        this.scheduleStatusPoll(id, attempt);
      }
    } catch (error) {
      attempt.status = undefined;
      attempt.flowVariant = undefined;
      attempt.actionKeys.clear();
      if (error instanceof TenantContextChangedError) {
        this.clearAttemptTimers(attempt);
        attempt.popup?.close();
        attempt.popup = undefined;
        attempt.jobLocation = undefined;
        attempt.jobStatus = undefined;
        attempt.message = 'O contexto ativo mudou desde esta sessão. Nenhuma leitura ou ação foi enviada; volte ao contexto original para consultar o resultado.';
      } else {
        attempt.message = this.statusReadFailure(error);
      }
      const statusCode = isRecord(error) && typeof error['status'] === 'number' ? error['status'] : 0;
      if (error instanceof TenantContextChangedError || [401, 403, 404].includes(statusCode)) {
        this.clearAttemptTimers(attempt);
        attempt.popup?.close();
        attempt.popup = undefined;
        attempt.jobLocation = undefined;
        attempt.jobStatus = undefined;
      } else {
        this.scheduleStatusPoll(id, attempt);
      }
    } finally {
      if (sequence === attempt.statusReadSequence) attempt.statusReadInFlight = false;
      this.publish();
    }
  }

  async recover(id: string, option: OnboardingRecoveryOption): Promise<boolean> {
    const attempt = this.attempts.get(id);
    if (!attempt?.status || attempt.recoveryInFlight || !this.isAllowedRecovery(attempt.status, option)) return false;
    if (!this.assertTenantMutationAllowed()) return false;
    if (!this.providerActivationEnabled) {
      this.setNotice('A recuperação com efeito externo permanece desativada até as evidências necessárias serem confirmadas.');
      return false;
    }
    if (option.action === 'REAUTHORIZE') {
      const profile = this.getSnapshot().profiles.find((item) => item.flowVariant === attempt.status?.flowVariant && item.enabled);
      if (!profile) {
        this.setNotice('A configuração necessária para reiniciar esta autorização não está disponível.');
        return false;
      }
      return this.start(profile);
    }

    attempt.recoveryInFlight = true;
    this.publish();
    try {
      const context = await this.readRequestContext(true).catch(() => undefined);
      if (!context || !this.assertTenantMutationAllowed()) return false;
      if (!attempt.tenantContextRef || attempt.tenantContextRef !== context.tenantContextRef || !attempt.status) {
        this.setNotice('O contexto ativo mudou desde esta sessão. Volte ao contexto original para solicitar a recuperação.');
        return false;
      }
      const actionKey = `${option.action}:${option.stage}:${attempt.status.nextAction}`;
      let idempotencyKey = attempt.actionKeys.get(actionKey);
      if (!idempotencyKey) {
        idempotencyKey = requestIdempotencyKey(this.documentRef);
        if (!idempotencyKey) {
          this.setNotice('Não foi possível preparar uma chave segura para a recuperação.');
          return false;
        }
        attempt.actionKeys.set(actionKey, idempotencyKey);
      }
      try {
        const response: unknown = await firstValueFrom(this.http.post<unknown>(
          `${this.baseUrl}/onboarding-sessions/${encodeURIComponent(id)}/actions`,
          { action: option.action, stage: option.stage },
          { withCredentials: true, headers: new HttpHeaders({
            'X-Tenant-Context': context.tenantContextRef,
            'X-CSRF-Token': context.csrfToken,
            'Idempotency-Key': idempotencyKey,
          }) },
        ));
        const accepted = parseAcceptedJob(response);
        if (!accepted) throw new Error('invalid-job-acceptance');
        attempt.jobId = accepted.id;
        attempt.jobLocation = accepted.location;
        attempt.jobStatus = 'PENDING';
        attempt.jobPollCount = 0;
        attempt.message = option.action === 'RECONCILE'
          ? 'O servidor iniciou uma verificação somente de leitura.'
          : `O servidor aceitou a retomada da etapa ${stageLabel(option.stage)}.`;
        this.publish();
        this.scheduleJobPoll(id, attempt);
        return true;
      } catch {
        attempt.message = 'A solicitação não foi confirmada. O portal consultará o status antes de oferecer outra ação.';
        this.publish();
        return false;
      }
    } finally {
      attempt.recoveryInFlight = false;
      this.publish();
    }
  }

  detachPopup(id: string): void {
    const attempt = this.attempts.get(id);
    if (!attempt?.popup) return;
    attempt.popup.close();
    attempt.popup = undefined;
    attempt.locallyDetached = true;
    if (attempt.popupTimer !== undefined) this.documentRef.defaultView?.clearTimeout(attempt.popupTimer);
    attempt.popupTimer = undefined;
    attempt.message = 'Janela fechada. A sessão no servidor não foi cancelada; consultando o estado atual.';
    this.publish();
    void this.refreshStatus(id, false);
  }

  recoveryOptions(status: OnboardingServerStatus): readonly OnboardingRecoveryOption[] {
    if (!this.providerActivationEnabled) return Object.freeze([]);
    if (status.nextAction === 'REAUTHORIZE') return Object.freeze([{ action: 'REAUTHORIZE', label: 'Reiniciar autorização' }]);
    if (status.nextAction === 'RESUME' && status.status === 'PARTIAL') {
      const stage = status.steps.find((step) => RESUMABLE_STAGES.has(step.name) && step.status === 'RETRY_PENDING')?.name;
      if (stage && RESUMABLE_STAGES.has(stage)) return Object.freeze([{ action: 'RESUME', stage: stage as OnboardingStage, label: `Retomar ${stageLabel(stage)}` }]);
    }
    if (status.nextAction === 'RECONCILE') {
      const stage = status.steps.find((step) => STAGES.has(step.name) && (step.status === 'UNKNOWN' || step.status === 'RUNNING'))?.name;
      if (stage && STAGES.has(stage)) return Object.freeze([{ action: 'RECONCILE', stage: stage as OnboardingStage, label: `Verificar ${stageLabel(stage)}` }]);
    }
    return Object.freeze([]);
  }

  private isAllowedRecovery(status: OnboardingServerStatus, option: OnboardingRecoveryOption): boolean {
    return this.recoveryOptions(status).some((candidate) => candidate.action === option.action &&
      ('stage' in candidate ? 'stage' in option && candidate.stage === option.stage : !('stage' in option)));
  }

  private async readRequestContext(requireCsrf: boolean): Promise<PortalRequestContext> {
    const session: unknown = await firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/session`, { withCredentials: true }));
    if (!isRecord(session) || typeof session['tenantContextRef'] !== 'string' ||
        !/^[A-Za-z0-9._~-]{16,512}$/.test(session['tenantContextRef'])) throw new Error('portal-session-unavailable');
    this.observeTenantContext(session['tenantContextRef']);
    const csrfToken = readCsrfToken(this.documentRef);
    if (requireCsrf && !csrfToken) throw new Error('csrf-unavailable');
    return Object.freeze({ tenantContextRef: session['tenantContextRef'], csrfToken: csrfToken ?? '' });
  }

  private scheduleStatusPoll(id: string, attempt: MutableAttempt): void {
    if (attempt.statusTimer !== undefined || isFinalStatus(attempt.status) || Date.parse(attempt.ref.expiresAt) <= Date.now()) return;
    if (attempt.statusPollCount >= MAX_STATUS_POLLS) {
      attempt.message = `${attempt.message} Atualize o status manualmente para continuar.`;
      return;
    }
    const windowRef = this.documentRef.defaultView;
    if (!windowRef) return;
    const delay = Math.min(1_500 * (2 ** attempt.statusPollCount), 15_000);
    attempt.statusPollCount += 1;
    attempt.statusTimer = windowRef.setTimeout(() => {
      attempt.statusTimer = undefined;
      void this.refreshStatus(id, false);
    }, delay);
  }

  private scheduleJobPoll(id: string, attempt: MutableAttempt): void {
    if (!attempt.jobLocation || !attempt.jobId || attempt.jobTimer !== undefined) return;
    if (attempt.jobPollCount >= MAX_JOB_POLLS) {
      attempt.jobStatus = 'UNKNOWN';
      attempt.jobLocation = undefined;
      attempt.message = 'O resultado do trabalho não foi confirmado. Consulte o estado da sessão antes de agir novamente.';
      this.publish();
      void this.refreshStatus(id, false);
      return;
    }
    const windowRef = this.documentRef.defaultView;
    if (!windowRef) return;
    const delay = Math.min(1_500 * (2 ** attempt.jobPollCount), 15_000);
    attempt.jobPollCount += 1;
    attempt.jobTimer = windowRef.setTimeout(() => {
      attempt.jobTimer = undefined;
      void this.readJob(id, attempt);
    }, delay);
  }

  private async readJob(id: string, attempt: MutableAttempt): Promise<void> {
    if (!attempt.jobLocation || !attempt.jobId || !this.attempts.has(id)) return;
    const location = attempt.jobLocation;
    const jobId = attempt.jobId;
    try {
      const context = await this.readRequestContext(false);
      if (attempt.tenantContextRef !== context.tenantContextRef || attempt.jobLocation !== location || attempt.jobId !== jobId) {
        throw new TenantContextChangedError();
      }
      const response: unknown = await firstValueFrom(this.http.get<unknown>(location, {
        withCredentials: true, headers: new HttpHeaders({ 'X-Tenant-Context': context.tenantContextRef }),
      }));
      if (this.currentTenantContextRef !== context.tenantContextRef || attempt.tenantContextRef !== context.tenantContextRef) {
        throw new TenantContextChangedError();
      }
      const status = parseJobStatus(response, jobId);
      if (!status) throw new Error('invalid-job-status');
      attempt.jobStatus = status;
      if (['PENDING', 'RUNNING', 'RETRY_PENDING'].includes(status)) this.scheduleJobPoll(id, attempt);
      else {
        attempt.jobLocation = undefined;
        await this.refreshStatus(id, false);
      }
    } catch {
      attempt.jobLocation = undefined;
      if (this.currentTenantContextRef !== attempt.tenantContextRef) {
        attempt.jobStatus = undefined;
        attempt.message = 'O contexto ativo mudou desde esta sessão. Volte ao contexto original para consultar o resultado.';
      } else {
        attempt.jobStatus = 'UNKNOWN';
        attempt.message = 'O resultado do trabalho ainda não está confirmado. Consulte o estado da sessão.';
        void this.refreshStatus(id, false);
      }
    }
    this.publish();
  }

  private watchPopup(id: string, attempt: MutableAttempt): void {
    const windowRef = this.documentRef.defaultView;
    if (!windowRef || !attempt.popup || isFinalStatus(attempt.status)) return;
    attempt.popupTimer = windowRef.setTimeout(() => {
      attempt.popupTimer = undefined;
      if (!attempt.popup) return;
      if (attempt.popup.isClosed()) {
        attempt.popup = undefined;
        attempt.locallyDetached = true;
        attempt.message = 'A janela do provedor foi fechada. O servidor ainda precisa confirmar o resultado.';
        this.publish();
        void this.refreshStatus(id, false);
      } else if (Date.parse(attempt.ref.expiresAt) > Date.now()) {
        this.watchPopup(id, attempt);
      }
    }, 500);
  }

  private readonly onProviderMessage = (event: MessageEvent<unknown>): void => {
    for (const [id, attempt] of this.attempts) {
      if (!attempt.popup) continue;
      const signal = validateOAuthReturnEvent(event, {
        popupWindow: attempt.popup.source,
        portalOrigin: this.documentRef.location.origin,
        onboardingRef: id,
      });
      if (signal) {
        void this.refreshStatus(signal.onboardingRef, false);
        return;
      }
      // Legacy auth_success is a navigation hint only, accepted only from this attempt's tracked popup.
      const data = isRecord(event.data) ? event.data : undefined;
      let providerOrigin = false;
      try {
        const url = new URL(event.origin);
        url.searchParams.set('state', 'hint');
        providerOrigin = this.providerLaunch.isAllowed(url);
      } catch {
        providerOrigin = false;
      }
      if (event.source === attempt.popup.source && providerOrigin &&
          (data?.['auth_success'] === true || data?.['type'] === 'auth_success')) {
        void this.refreshStatus(id, false);
        return;
      }
    }
  };

  private hasActiveCoexistence(): boolean {
    return [...this.attempts.values()].some((attempt) => {
      if (this.currentTenantContextRef && attempt.tenantContextRef && attempt.tenantContextRef !== this.currentTenantContextRef) return false;
      const flowVariant = attempt.flowVariant ?? attempt.status?.flowVariant;
      return flowVariant === 'WHATSAPP_COEXISTENCE' && !isFinalStatus(attempt.status);
    });
  }

  private observeTenantContext(tenantContextRef: string): void {
    const previous = this.currentTenantContextRef;
    this.currentTenantContextRef = tenantContextRef;
    if (!previous) {
      this.store.useContext(tenantContextRef);
      this.pendingCreate = this.store.pendingCreate(tenantContextRef);
      return;
    }
    if (previous === tenantContextRef) return;
    this.store.useContext(tenantContextRef);
    this.pendingCreate = this.store.pendingCreate(tenantContextRef);
    this.catalogTenantContextRef = undefined;
    this.update({ catalogState: 'loading', profiles: Object.freeze([]) });
    for (const [id, attempt] of this.attempts) {
      if (attempt.tenantContextRef === tenantContextRef) continue;
      this.clearAttemptTimers(attempt);
      attempt.statusReadSequence += 1;
      attempt.statusReadInFlight = false;
      attempt.popup?.close();
      attempt.popup = undefined;
      this.attempts.delete(id);
    }
    this.publish();
    this.setNotice('O contexto da empresa mudou. As sessões de outro contexto foram ocultadas.');
    void this.loadCatalog();
  }

  private assertTenantMutationAllowed(): boolean {
    const capability = this.tenantIdentity.current();
    if (capability.confirmed && capability.tenantDisplayName.trim()) return true;
    this.setNotice(ONBOARDING_TENANT_IDENTITY_WARNING);
    return false;
  }

  private isActiveCoexistenceConflict(error: unknown): boolean {
    return error instanceof HttpErrorResponse && error.status === 409 && isRecord(error.error) &&
      error.error['code'] === 'COEXISTENCE_SESSION_ACTIVE';
  }

  private statusReadFailure(error: unknown): string {
    const status = isRecord(error) && typeof error['status'] === 'number' ? error['status'] : 0;
    if (status === 401 || status === 403 || status === 404) return 'Esta sessão não está disponível neste contexto de empresa. Volte ao portal ou troque para o contexto original.';
    return 'O status não está disponível agora. As conexões existentes permanecem preservadas; tente atualizar novamente.';
  }

  private clearAttemptTimers(attempt: MutableAttempt): void {
    const windowRef = this.documentRef.defaultView;
    if (windowRef && attempt.statusTimer !== undefined) windowRef.clearTimeout(attempt.statusTimer);
    if (windowRef && attempt.popupTimer !== undefined) windowRef.clearTimeout(attempt.popupTimer);
    if (windowRef && attempt.jobTimer !== undefined) windowRef.clearTimeout(attempt.jobTimer);
    attempt.statusTimer = undefined;
    attempt.popupTimer = undefined;
    attempt.jobTimer = undefined;
  }

  private view(attempt: MutableAttempt): OnboardingAttemptView {
    return Object.freeze({
      id: attempt.ref.id,
      expiresAt: attempt.ref.expiresAt,
      ...((attempt.flowVariant ?? attempt.status?.flowVariant) ? { flowVariant: attempt.flowVariant ?? attempt.status?.flowVariant } : {}),
      ...(attempt.status ? { status: attempt.status } : {}),
      message: attempt.message,
      popupAttached: !!attempt.popup,
      ...(attempt.jobStatus ? { jobStatus: attempt.jobStatus } : {}),
      recoveryOptions: attempt.status ? this.recoveryOptions(attempt.status) : Object.freeze([]),
    });
  }

  private buildSnapshot(input: Pick<PortalOnboardingSnapshot, 'catalogState' | 'profiles' | 'notice' | 'busy'>): PortalOnboardingSnapshot {
    const capability = this.tenantIdentity.current();
    return Object.freeze({
      ...input,
      attempts: Object.freeze([...this.attempts.values()].map((attempt) => this.view(attempt))),
      tenantDisplayName: capability.confirmed && capability.tenantDisplayName.trim() ? capability.tenantDisplayName : null,
      tenantMutationAllowed: capability.confirmed === true && !!capability.tenantDisplayName.trim(),
      providerActivationEnabled: this.providerActivationEnabled,
      ...(this.pendingCreate ? { pendingCreateFlowVariant: this.pendingCreate.flowVariant } : {}),
      notice: !capability.confirmed ? ONBOARDING_TENANT_IDENTITY_WARNING : input.notice,
    });
  }

  private update(patch: Partial<Pick<PortalOnboardingSnapshot, 'catalogState' | 'profiles' | 'notice' | 'busy'>>): void {
    this.stateSubject.next(this.buildSnapshot({
      catalogState: patch.catalogState ?? this.stateSubject.value.catalogState,
      profiles: patch.profiles ?? this.stateSubject.value.profiles,
      notice: patch.notice ?? this.stateSubject.value.notice,
      busy: patch.busy ?? this.busy,
    }));
  }

  private publish(): void { this.update({}); }

  private setNotice(notice: string): void { this.update({ notice }); }
}
