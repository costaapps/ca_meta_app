import { DOCUMENT } from '@angular/common';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { META_API_BASE_URL, PROVIDER_AUTHORIZATION_ORIGINS } from '../config/public-runtime-config';
import {
  COEXISTENCE_PROVIDER_ADAPTER,
  decodeCoexistenceMessage,
  hasReviewedCoexistenceContract,
  type CoexistenceProviderAdapter,
  type CoexistenceProviderMessage,
  type PreparedCoexistenceSignup,
} from './coexistence-provider-adapter';

export type CoexistenceAttemptState =
  | 'awaiting_provider'
  | 'awaiting_server_confirmation'
  | 'ready'
  | 'partial'
  | 'cancelled'
  | 'expired'
  | 'failed'
  | 'recoverable_error';

export type CoexistenceRecoveryAction = 'RESUME' | 'RECONCILE' | 'REAUTHORIZE';
export type CoexistenceRecoveryStage = 'authorization' | 'asset-verification' | 'subscription' | 'projection';

export interface CoexistenceRecoveryOption {
  readonly action: CoexistenceRecoveryAction;
  readonly stage: CoexistenceRecoveryStage;
}

export interface CoexistenceStepSnapshot {
  readonly name: CoexistenceRecoveryStage;
  readonly status: string;
}

export interface CoexistenceAttemptSnapshot {
  readonly onboardingRef: string;
  readonly ordinal: number;
  readonly state: CoexistenceAttemptState;
  readonly message: string;
  readonly startedAt: string;
  readonly lastUpdatedAt?: string;
  readonly nextAction?: string;
  readonly steps?: readonly CoexistenceStepSnapshot[];
  readonly recoveryOptions: readonly CoexistenceRecoveryOption[];
  readonly recoveryInFlight: boolean;
  readonly pendingRecovery?: CoexistenceRecoveryOption;
  readonly replacementOnboardingRef?: string;
}

export interface CoexistenceOnboardingSnapshot {
  readonly state: 'checking' | 'starting' | 'awaiting_provider' | 'awaiting_server_confirmation' |
    'confirmed' | 'partial' | 'unavailable' | 'recoverable_error';
  readonly message: string;
  readonly canStart: boolean;
  readonly attempts: readonly CoexistenceAttemptSnapshot[];
}

interface PortalContext {
  readonly tenantContextRef: string;
  readonly csrfToken: string;
}

class TenantContextChangedError extends Error {
  constructor() {
    super('The active tenant context no longer matches this onboarding session.');
  }
}

interface CoexistenceFlowProfile {
  readonly requestedCapabilities: readonly string[];
}

interface CreatedOnboarding {
  readonly id: string;
  readonly status: 'AWAITING_PROVIDER';
  readonly expiresAt: string;
  readonly launchUrl: string;
  readonly requestId: string;
}

interface ServerOnboardingStatus {
  readonly id: string;
  readonly status: string;
  readonly readiness: string;
  readonly lastUpdatedAt: string;
  readonly nextAction: string;
  readonly steps: readonly CoexistenceStepSnapshot[];
}

interface MutableAttempt {
  readonly onboardingRef: string;
  readonly stateRef: string;
  readonly tenantContextRef: string;
  readonly expiresAtMs: number;
  readonly ordinal: number;
  readonly startedAt: string;
  state: CoexistenceAttemptState;
  message: string;
  lastUpdatedAt?: string;
  codeSubmitted: boolean;
  confirmationRequested: boolean;
  statusReadInFlight: boolean;
  nextAction?: string;
  serverStatus?: string;
  steps?: readonly CoexistenceStepSnapshot[];
  pendingRecovery?: CoexistenceRecoveryOption;
  replacementOnboardingRef?: string;
  recoveryActionInFlight: boolean;
  prepared?: PreparedCoexistenceSignup;
  messageListener?: (event: MessageEvent<unknown>) => void;
  expiryTimer?: number;
  pollTimer?: number;
}

const TERMINAL_STATUS = new Set(['READY', 'CANCELLED', 'EXPIRED', 'FAILED']);
const OPAQUE_REF = /^[A-Za-z0-9_-]{16,128}$/;
const STATE_REF = /^[A-Za-z0-9_-]{32,128}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._~-]{16,128}$/;
const RECOVERY_STAGES: readonly CoexistenceRecoveryStage[] = [
  'authorization', 'asset-verification', 'subscription', 'projection',
];
const RESUMABLE_STAGES: readonly CoexistenceRecoveryStage[] = ['asset-verification', 'subscription', 'projection'];

export function recoveryOptionsFor(status: Pick<ServerOnboardingStatus, 'status' | 'nextAction' | 'steps'>): readonly CoexistenceRecoveryOption[] {
  if (status.status === 'PARTIAL' && status.nextAction === 'REAUTHORIZE' &&
      status.steps.some((step) => step.name === 'authorization' && step.status === 'FAILED')) {
    return Object.freeze([Object.freeze({ action: 'REAUTHORIZE' as const, stage: 'authorization' as const })]);
  }
  if (status.nextAction === 'RESUME') {
    return Object.freeze(status.steps
      .filter((step) => RESUMABLE_STAGES.includes(step.name) && step.status === 'RETRY_PENDING')
      .map((step) => Object.freeze({ action: 'RESUME' as const, stage: step.name })));
  }
  if (status.nextAction === 'RECONCILE') {
    return Object.freeze(status.steps
      .filter((step) => RECOVERY_STAGES.includes(step.name) && ['UNKNOWN', 'RUNNING'].includes(step.status))
      .map((step) => Object.freeze({ action: 'RECONCILE' as const, stage: step.name })));
  }
  return Object.freeze([]);
}

function sameRecoveryOption(left: CoexistenceRecoveryOption, right: CoexistenceRecoveryOption): boolean {
  return left.action === right.action && left.stage === right.stage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function isPortalSession(value: unknown): value is { tenantContextRef: string } {
  if (!isRecord(value) || typeof value['tenantContextRef'] !== 'string' ||
      !/^[A-Za-z0-9._~-]{16,512}$/.test(value['tenantContextRef'])) return false;
  return true;
}

function isCoexistenceFlowProfile(value: unknown): value is Record<string, unknown> & {
  requestedCapabilities: readonly string[];
} {
  if (!isRecord(value) || value['variant'] !== 'WHATSAPP_COEXISTENCE' ||
      value['flowVariant'] !== 'WHATSAPP_COEXISTENCE' || value['enabled'] !== true ||
      value['availability'] !== 'AVAILABLE' || !isRecord(value['prerequisites'])) return false;
  const prerequisites = value['prerequisites'];
  if (prerequisites['metaAppConfigured'] !== true || prerequisites['serverAdapterRegistered'] !== true ||
      prerequisites['tenantFeatureFlag'] !== 'ENABLED' || !Array.isArray(value['requestedCapabilities']) ||
      value['requestedCapabilities'].length > 32 ||
      !value['requestedCapabilities'].every((item) => typeof item === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(item))) return false;
  return true;
}

function isCreatedOnboarding(value: unknown): value is CreatedOnboarding {
  if (!isRecord(value) || !exactKeys(value, ['id', 'status', 'expiresAt', 'launchUrl', 'requestId']) ||
      typeof value['id'] !== 'string' || !OPAQUE_REF.test(value['id']) || value['status'] !== 'AWAITING_PROVIDER' ||
      typeof value['expiresAt'] !== 'string' || typeof value['launchUrl'] !== 'string' ||
      value['launchUrl'].length > 4096 || typeof value['requestId'] !== 'string' || value['requestId'].length < 1 ||
      value['requestId'].length > 128) return false;
  const expiry = Date.parse(value['expiresAt']);
  return Number.isFinite(expiry) && expiry > Date.now() && expiry <= Date.now() + 60 * 60_000;
}

function isAcceptedJob(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ['jobId', 'status', 'location', 'requestId']) &&
    typeof value['jobId'] === 'string' && value['jobId'].length > 0 && value['jobId'].length <= 128 &&
    value['status'] === 'PENDING' && typeof value['location'] === 'string' &&
    /^\/api\/v1\/jobs\/[A-Za-z0-9_-]+$/.test(value['location']) &&
    typeof value['requestId'] === 'string' && value['requestId'].length > 0 && value['requestId'].length <= 128;
}

function parseServerStatus(value: unknown, expectedRef: string): ServerOnboardingStatus | undefined {
  const keys = ['id', 'flowVariant', 'status', 'readiness', 'steps', 'nextAction', 'lastUpdatedAt', 'requestId'];
  if (!isRecord(value) || !exactKeys(value, keys) || value['id'] !== expectedRef ||
      value['flowVariant'] !== 'WHATSAPP_COEXISTENCE' ||
      !['CREATED', 'AWAITING_PROVIDER', 'CODE_RECEIVED', 'EXCHANGING', 'ASSETS_VERIFIED', 'PROVISIONING',
        'READY', 'PARTIAL', 'CANCELLED', 'EXPIRED', 'FAILED'].includes(String(value['status'])) ||
      !['READY', 'PARTIAL', 'UNKNOWN'].includes(String(value['readiness'])) ||
      !Array.isArray(value['steps']) || value['steps'].length > 32 ||
      !['WAIT', 'CHECK_STATUS', 'REAUTHORIZE', 'RECONCILE', 'RESUME', 'RESOLVE_CONFLICT', 'NONE'].includes(String(value['nextAction'])) ||
      typeof value['lastUpdatedAt'] !== 'string' || Number.isNaN(Date.parse(value['lastUpdatedAt'])) ||
      typeof value['requestId'] !== 'string' || value['requestId'].length < 1 || value['requestId'].length > 128) return undefined;
  const stepsAreSafe = value['steps'].every((step) => isRecord(step) && exactKeys(step, ['name', 'status']) &&
    typeof step['name'] === 'string' && RECOVERY_STAGES.includes(step['name'] as CoexistenceRecoveryStage) &&
    ['PENDING', 'RUNNING', 'SUCCEEDED', 'RETRY_PENDING', 'FAILED', 'UNKNOWN', 'SKIPPED'].includes(String(step['status'])));
  if (!stepsAreSafe) return undefined;
  const status = String(value['status']);
  const readiness = String(value['readiness']);
  const nextAction = String(value['nextAction']);
  const steps = value['steps'] as { name: CoexistenceRecoveryStage; status: string }[];
  if (status === 'READY' && (readiness !== 'READY' || nextAction !== 'NONE' ||
      !['authorization', 'asset-verification', 'subscription', 'projection'].every((name) =>
        steps.some((step) => step.name === name && step.status === 'SUCCEEDED')))) return undefined;
  if (status === 'PARTIAL' && readiness !== 'PARTIAL') return undefined;
  return {
    id: expectedRef,
    status,
    readiness,
    lastUpdatedAt: value['lastUpdatedAt'],
    nextAction,
    steps: Object.freeze(steps.map((step) => Object.freeze({ name: step.name, status: step.status }))),
  };
}

function readCookie(documentRef: Document, cookieName: string): string | undefined {
  const matches = documentRef.cookie.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName}=`));
  if (matches.length !== 1) return undefined;
  const value = matches[0].slice(cookieName.length + 1);
  return /^[A-Za-z0-9._~-]{32,512}$/.test(value) ? value : undefined;
}

function randomIdempotencyKey(windowRef: Window): string | undefined {
  try {
    const bytes = new Uint8Array(24);
    windowRef.crypto.getRandomValues(bytes);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const value = windowRef.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    return IDEMPOTENCY_KEY.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** M4.03 create dedupes only by tenant + Idempotency-Key; retries from tabs must share this key. */
export function reauthorizationIdempotencyKey(onboardingRef: string): string | undefined {
  const key = `reauth-${onboardingRef}`;
  return IDEMPOTENCY_KEY.test(key) ? key : undefined;
}

@Injectable()
export class CoexistenceOnboardingService {
  private readonly baseUrl: string;
  private readonly listeners = new Set<(snapshot: CoexistenceOnboardingSnapshot) => void>();
  private readonly attempts: MutableAttempt[] = [];
  private snapshotValue: CoexistenceOnboardingSnapshot = Object.freeze({
    state: 'checking',
    message: 'Verificando as condições seguras para adicionar um número…',
    canStart: false,
    attempts: Object.freeze([]),
  });
  private startInFlight = false;
  private flowAvailable = false;
  private ambiguousCreate = false;
  private disposed = false;

  constructor(
    private readonly http: HttpClient,
    @Inject(META_API_BASE_URL) baseUrl: string,
    @Inject(PROVIDER_AUTHORIZATION_ORIGINS) private readonly providerOrigins: readonly string[],
    @Inject(COEXISTENCE_PROVIDER_ADAPTER) private readonly providerAdapter: CoexistenceProviderAdapter,
    @Inject(DOCUMENT) private readonly documentRef: Document,
  ) {
    const configuredBase = baseUrl.replace(/\/+$/, '');
    this.baseUrl = configuredBase.endsWith('/v1') ? configuredBase : `${configuredBase || '/api'}/v1`;
  }

  getSnapshot(): CoexistenceOnboardingSnapshot { return this.snapshotValue; }

  subscribe(listener: (snapshot: CoexistenceOnboardingSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshotValue);
    return () => this.listeners.delete(listener);
  }

  async refreshAvailability(): Promise<void> {
    if (this.disposed) return;
    if (this.ambiguousCreate) {
      this.flowAvailable = false;
      this.publish('recoverable_error', 'Uma solicitação de sessão não teve resposta confirmável. Verifique o estado no portal antes de iniciar outro número.');
      return;
    }
    if (!hasReviewedCoexistenceContract(this.providerAdapter, this.providerOrigins)) {
      this.flowAvailable = false;
      this.publish('unavailable', 'A configuração do Embedded Signup Coexistence está desativada enquanto versão, featureType, origem, source e schema de eventos não tiverem evidência revisada.');
      return;
    }
    this.publish('checking', 'Verificando sessão e disponibilidade configurada no servidor…');
    try {
      const context = await this.readContext(false);
      if (this.disposed) return;
      const profiles = await this.readFlowProfiles(context);
      if (this.disposed) return;
      this.flowAvailable = profiles !== undefined;
      this.publish(profiles ? 'confirmed' : 'unavailable', profiles
        ? 'O servidor e o contrato do provedor permitem iniciar uma sessão.'
        : 'O servidor não habilitou este fluxo. Nenhuma sessão de provedor foi iniciada.');
    } catch {
      this.flowAvailable = false;
      this.publish('unavailable', 'Não foi possível confirmar a sessão ou a disponibilidade do fluxo.');
    }
  }

  async start(): Promise<void> {
    if (!this.documentRef.defaultView || this.disposed || !this.flowAvailable || this.startInFlight ||
        this.ambiguousCreate || this.hasPendingAttempt()) return;
    this.startInFlight = true;
    const prepared = this.prepareProviderSignup();
    if (!prepared) {
      this.startInFlight = false;
      this.flowAvailable = false;
      this.publish('unavailable', 'Não foi possível preparar a janela de provedor com gesto do usuário e contrato revisado.');
      return;
    }
    this.publish('checking', 'Confirmando novamente a sessão e a configuração do fluxo…');
    try {
      await this.createOnboardingAttempt(prepared);
    } finally {
      this.startInFlight = false;
      this.publishSnapshot();
    }
  }

  private async createOnboardingAttempt(
    prepared: PreparedCoexistenceSignup,
    startMessage = 'Criando uma sessão individual para adicionar o próximo número…',
    stableIdempotencyKey?: string,
    expectedTenantContextRef?: string,
  ): Promise<MutableAttempt | undefined> {
    const windowRef = this.documentRef.defaultView;
    if (!windowRef || this.disposed) {
      try { prepared.dispose(); } catch { /* A failed popup cleanup never changes server state. */ }
      return undefined;
    }
    let createRequestSent = false;
    let preparedTransferred = false;
    try {
      if (!hasReviewedCoexistenceContract(this.providerAdapter, this.providerOrigins)) {
        this.flowAvailable = false;
        this.publish('unavailable', 'O contrato exato do Embedded Signup Coexistence ainda não foi confirmado.');
        return undefined;
      }
      const context = await this.readContext(true);
      if (this.disposed) return undefined;
      if (expectedTenantContextRef && context.tenantContextRef !== expectedTenantContextRef) {
        throw new Error('The active tenant context changed since the original onboarding session.');
      }
      const profile = await this.readFlowProfiles(context);
      if (this.disposed) return undefined;
      if (!profile) {
        this.flowAvailable = false;
        this.publish('unavailable', 'O servidor não habilitou este fluxo para a sessão atual.');
        return undefined;
      }
      this.flowAvailable = true;
      const idempotencyKey = stableIdempotencyKey ?? randomIdempotencyKey(windowRef);
      if (!idempotencyKey) throw new Error('Unable to create a request identifier.');
      this.publish('starting', startMessage);
      createRequestSent = true;
      const createdValue = await firstValueFrom(this.http.post<unknown>(`${this.baseUrl}/onboarding-sessions`, {
        flowVariant: 'WHATSAPP_COEXISTENCE',
        requestedCapabilities: [...profile.requestedCapabilities],
        returnRoute: 'setup',
      }, {
        withCredentials: true,
        headers: this.requestHeaders(context, idempotencyKey),
      }));
      if (this.disposed) return undefined;
      if (!isCreatedOnboarding(createdValue)) throw new Error('Invalid onboarding session response.');
      if (this.attempts.some((attempt) => attempt.onboardingRef === createdValue.id)) {
        throw new Error('The server returned an onboarding session already used in this tab.');
      }
      const launch = this.validateLaunch(createdValue.launchUrl);
      if (!launch) throw new Error('The server returned an unsupported launch URL.');
      const stateRef = launch.searchParams.get('state');
      if (!stateRef || !STATE_REF.test(stateRef) || this.attempts.some((attempt) => attempt.stateRef === stateRef)) {
        throw new Error('The server session has no valid, unused state reference.');
      }

      const messageOrigin = this.exactOrigin(prepared?.messageOrigin);
      const contractOrigin = this.exactOrigin(this.providerAdapter.contract?.messageOrigin);
      if (!prepared || !prepared.messageSource || !messageOrigin || messageOrigin !== contractOrigin ||
          !this.providerOrigins.includes(messageOrigin)) {
        this.addAttempt({
          onboardingRef: createdValue.id,
          stateRef,
          tenantContextRef: context.tenantContextRef,
          expiresAtMs: Date.parse(createdValue.expiresAt),
          ordinal: this.attempts.length + 1,
          startedAt: new Date().toISOString(),
          state: 'recoverable_error',
          message: 'A sessão foi criada, mas a origem ou o vínculo da janela do provedor não corresponde ao contrato revisado.',
          codeSubmitted: false,
          confirmationRequested: true,
          statusReadInFlight: false,
          recoveryActionInFlight: false,
        });
        const attempt = this.attempts[this.attempts.length - 1];
        await this.confirmStatus(attempt, true);
        return attempt;
      }

      const attempt: MutableAttempt = {
        onboardingRef: createdValue.id,
        stateRef,
        tenantContextRef: context.tenantContextRef,
        expiresAtMs: Date.parse(createdValue.expiresAt),
        ordinal: this.attempts.length + 1,
        startedAt: new Date().toISOString(),
        state: 'awaiting_provider',
        message: 'Conclua o QR e o consentimento na janela do WhatsApp. O portal aguardará a confirmação do servidor.',
        codeSubmitted: false,
        confirmationRequested: false,
        statusReadInFlight: false,
        recoveryActionInFlight: false,
        prepared,
      };
      attempt.messageListener = (event) => this.onProviderMessage(attempt, event);
      this.addAttempt(attempt);
      preparedTransferred = true;
      windowRef.addEventListener('message', attempt.messageListener);
      const remainingMs = Math.max(0, Math.min(attempt.expiresAtMs - Date.now(), 60 * 60_000));
      attempt.expiryTimer = windowRef.setTimeout(() => { void this.onExpiry(attempt); }, remainingMs);
      try {
        prepared.start({ launchUrl: launch.href, onboardingRef: createdValue.id });
      } catch {
        this.stopListening(attempt);
        attempt.state = 'recoverable_error';
        attempt.message = 'A janela não pôde ser iniciada. O servidor verificará esta sessão antes de permitir outra tentativa.';
        attempt.confirmationRequested = true;
        this.publish('recoverable_error', attempt.message);
        await this.confirmStatus(attempt, true);
        return attempt;
      }
      this.publish('awaiting_provider', 'Aguardando a conclusão do fluxo e a confirmação do servidor.');
      return attempt;
    } catch {
      if (createRequestSent) this.ambiguousCreate = true;
      if (this.ambiguousCreate) this.flowAvailable = false;
      this.publish('recoverable_error', 'Não foi possível iniciar esta etapa. Verifique o estado antes de tentar novamente.');
      return undefined;
    } finally {
      if (!preparedTransferred) {
        try { prepared.dispose(); } catch { /* A failed popup cleanup never changes server state. */ }
      }
    }
  }

  private prepareProviderSignup(): PreparedCoexistenceSignup | undefined {
    if (this.disposed || !this.documentRef.defaultView ||
        !hasReviewedCoexistenceContract(this.providerAdapter, this.providerOrigins)) return undefined;
    let prepared: PreparedCoexistenceSignup | undefined;
    try {
      prepared = this.providerAdapter.prepareForUserGesture();
    } catch {
      return undefined;
    }
    const messageOrigin = this.exactOrigin(prepared?.messageOrigin);
    const contractOrigin = this.exactOrigin(this.providerAdapter.contract?.messageOrigin);
    if (!prepared || !prepared.messageSource || !messageOrigin || messageOrigin !== contractOrigin ||
        !this.providerOrigins.includes(messageOrigin) ||
        this.attempts.some((attempt) => attempt.prepared?.messageSource === prepared?.messageSource)) {
      try { prepared?.dispose(); } catch { /* A failed popup cleanup never changes server state. */ }
      return undefined;
    }
    return prepared;
  }

  cancel(onboardingRef: string): void {
    if (this.disposed) return;
    const attempt = this.attempts.find((item) => item.onboardingRef === onboardingRef);
    if (!attempt || this.isTerminal(attempt.state) || attempt.state === 'partial') return;
    this.stopListening(attempt);
    attempt.confirmationRequested = true;
    attempt.state = 'awaiting_server_confirmation';
    attempt.message = 'A janela foi fechada. O servidor ainda precisa confirmar o resultado desta sessão.';
    this.publish('awaiting_server_confirmation', attempt.message);
    void this.confirmStatus(attempt, true);
  }

  async refreshAttemptStatus(onboardingRef: string): Promise<void> {
    const attempt = this.attempts.find((item) => item.onboardingRef === onboardingRef);
    if (!attempt || this.disposed || this.isTerminal(attempt.state)) return;
    attempt.confirmationRequested = true;
    await this.confirmStatus(attempt, true);
  }

  async recover(onboardingRef: string, option: CoexistenceRecoveryOption): Promise<void> {
    const attempt = this.attempts.find((item) => item.onboardingRef === onboardingRef);
    if (!attempt || this.disposed || this.startInFlight || this.ambiguousCreate || this.isTerminal(attempt.state) ||
        attempt.recoveryActionInFlight || attempt.pendingRecovery ||
        !this.availableRecoveryOptions(attempt).some((candidate) => sameRecoveryOption(candidate, option))) return;

    let prepared: PreparedCoexistenceSignup | undefined;
    if (option.action === 'REAUTHORIZE') {
      prepared = this.prepareProviderSignup();
      if (!prepared) {
        attempt.message = 'Não foi possível preparar a janela de provedor com gesto do usuário e contrato revisado.';
        this.publishSnapshot();
        return;
      }
    }
    attempt.recoveryActionInFlight = true;
    attempt.message = 'Consultando o status atual antes de solicitar a ação segura do servidor…';
    this.publish(attempt.state === 'partial' ? 'partial' : 'awaiting_server_confirmation', attempt.message);
    try {
      const currentStatus = await this.readServerStatus(attempt);
      if (this.disposed) return;
      this.applyServerStatus(attempt, currentStatus);
      if (this.isTerminal(attempt.state) ||
          !recoveryOptionsFor(currentStatus).some((candidate) => sameRecoveryOption(candidate, option))) return;

      if (option.action === 'REAUTHORIZE') {
        this.stopListening(attempt);
        this.clearTimers(attempt);
        this.startInFlight = true;
        try {
          this.publish('starting', 'O servidor confirmou que a autorização pode ser refeita. Criando uma nova sessão…');
          // Do not use a random key here: tabs reauthorizing this same source session must replay one create.
          const idempotencyKey = reauthorizationIdempotencyKey(attempt.onboardingRef);
          if (!idempotencyKey) throw new Error('Unable to create a stable reauthorization identifier.');
          if (!prepared) throw new Error('A provider launch context was not prepared.');
          const replacement = await this.createOnboardingAttempt(prepared,
            'Criando uma nova sessão para refazer a autorização…', idempotencyKey, attempt.tenantContextRef);
          prepared = undefined;
          if (replacement) {
            attempt.replacementOnboardingRef = replacement.onboardingRef;
            attempt.confirmationRequested = false;
            attempt.message = `O servidor indicou nova autorização. Uma sessão nova foi iniciada como Número ${replacement.ordinal}; esta sessão anterior foi mantida no histórico.`;
          } else {
            attempt.message = this.ambiguousCreate
              ? 'A criação da nova sessão teve resposta ambígua. Consulte o estado antes de iniciar outra sessão.'
              : 'Não foi possível criar a nova sessão. A tentativa anterior permanece no histórico para consulta.';
          }
          this.publishSnapshot();
        } finally {
          this.startInFlight = false;
        }
        return;
      }

      const context = await this.readContext(true);
      this.assertAttemptTenantContext(attempt, context);
      const windowRef = this.documentRef.defaultView;
      const idempotencyKey = windowRef ? randomIdempotencyKey(windowRef) : undefined;
      if (!idempotencyKey) throw new Error('Unable to create a recovery request identifier.');
      const response = await firstValueFrom(this.http.post<unknown>(
        `${this.baseUrl}/onboarding-sessions/${encodeURIComponent(attempt.onboardingRef)}/actions`,
        { action: option.action, stage: option.stage },
        { withCredentials: true, headers: this.requestHeaders(context, idempotencyKey) },
      ));
      if (!isAcceptedJob(response)) throw new Error('Invalid recovery response.');
      attempt.pendingRecovery = option;
      attempt.confirmationRequested = true;
      attempt.state = 'awaiting_server_confirmation';
      attempt.message = `${option.action} da etapa ${option.stage} aceita pelo servidor. Aguardando o novo status.`;
      this.publish('awaiting_server_confirmation', attempt.message);
      await this.confirmStatus(attempt, true);
    } catch {
      attempt.confirmationRequested = true;
      attempt.message = 'A ação não foi confirmada. O portal consultará o status antes de permitir outra tentativa.';
      await this.confirmStatus(attempt, true);
    } finally {
      try { prepared?.dispose(); } catch { /* A failed popup cleanup never changes server state. */ }
      attempt.recoveryActionInFlight = false;
      this.publishSnapshot();
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const attempt of this.attempts) {
      this.stopListening(attempt);
      this.clearTimers(attempt);
    }
    this.listeners.clear();
  }

  private async readContext(requireCsrf: boolean): Promise<PortalContext> {
    const session = await firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/session`, { withCredentials: true }));
    if (!isPortalSession(session)) throw new Error('A verified portal session is required.');
    const csrfToken = readCookie(this.documentRef, '__Host-ca_meta_csrf');
    if (requireCsrf && !csrfToken) throw new Error('The session CSRF token is unavailable.');
    return { tenantContextRef: session.tenantContextRef, csrfToken: csrfToken ?? '' };
  }

  private async readServerStatus(attempt: MutableAttempt): Promise<ServerOnboardingStatus> {
    const context = await this.readContext(false);
    this.assertAttemptTenantContext(attempt, context);
    const value = await firstValueFrom(this.http.get<unknown>(
      `${this.baseUrl}/onboarding-sessions/${encodeURIComponent(attempt.onboardingRef)}`,
      { withCredentials: true, headers: new HttpHeaders({ 'X-Tenant-Context': context.tenantContextRef }) },
    ));
    const status = parseServerStatus(value, attempt.onboardingRef);
    if (!status) throw new Error('Invalid onboarding status.');
    return status;
  }

  private assertAttemptTenantContext(attempt: MutableAttempt, context: PortalContext): void {
    if (context.tenantContextRef !== attempt.tenantContextRef) throw new TenantContextChangedError();
  }

  private async readFlowProfiles(context: PortalContext): Promise<CoexistenceFlowProfile | undefined> {
    const response = await firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/integrations/flows`, {
      withCredentials: true,
      headers: new HttpHeaders({ 'X-Tenant-Context': context.tenantContextRef }),
    }));
    if (!isRecord(response) || !Array.isArray(response['items'])) return undefined;
    const matching = response['items'].filter((item) => isRecord(item) && item['variant'] === 'WHATSAPP_COEXISTENCE');
    if (matching.length !== 1) return undefined;
    const profile = matching[0];
    if (!isCoexistenceFlowProfile(profile)) return undefined;
    return { requestedCapabilities: Object.freeze([...profile.requestedCapabilities]) };
  }

  private requestHeaders(context: PortalContext, idempotencyKey: string): HttpHeaders {
    return new HttpHeaders({
      'X-Tenant-Context': context.tenantContextRef,
      'X-CSRF-Token': context.csrfToken,
      'Idempotency-Key': idempotencyKey,
    });
  }

  private validateLaunch(value: string): URL | undefined {
    try {
      const url = new URL(value, this.documentRef.location.origin);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
          !this.providerOrigins.includes(url.origin) || url.searchParams.getAll('state').length !== 1) return undefined;
      return url;
    } catch {
      return undefined;
    }
  }

  private exactOrigin(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password ||
          url.pathname !== '/' || url.search || url.hash) return undefined;
      return url.origin;
    } catch {
      return undefined;
    }
  }

  private onProviderMessage(attempt: MutableAttempt, event: MessageEvent<unknown>): void {
    const prepared = attempt.prepared;
    if (!prepared || this.isTerminal(attempt.state) || event.origin !== prepared.messageOrigin ||
        event.source !== prepared.messageSource) return;
    const message = decodeCoexistenceMessage(this.providerAdapter, event.data);
    if (!message) return;
    this.handleProviderMessage(attempt, message);
  }

  private handleProviderMessage(attempt: MutableAttempt, message: CoexistenceProviderMessage): void {
    if (message.type === 'authorization_code') {
      if (attempt.codeSubmitted) return;
      attempt.codeSubmitted = true;
      attempt.confirmationRequested = true;
      attempt.state = 'awaiting_server_confirmation';
      attempt.message = 'O código foi enviado uma vez à sessão correspondente. Aguardando confirmação do servidor.';
      this.publish('awaiting_server_confirmation', attempt.message);
      void this.submitCode(attempt, message.authorizationCode);
      return;
    }
    if (message.type === 'cancelled') this.stopListening(attempt);
    attempt.confirmationRequested = true;
    attempt.state = 'awaiting_server_confirmation';
    attempt.message = message.type === 'cancelled'
      ? 'O fluxo foi fechado. Consultando o servidor para confirmar se houve algum resultado.'
      : 'O fluxo informou conclusão. Isso não confirma a conexão; aguardando o servidor.';
    this.publish('awaiting_server_confirmation', attempt.message);
    void this.confirmStatus(attempt, true);
  }

  private async submitCode(attempt: MutableAttempt, authorizationCode: string): Promise<void> {
    try {
      const windowRef = this.documentRef.defaultView;
      if (!windowRef) throw new Error('No browser window is available.');
      const context = await this.readContext(true);
      this.assertAttemptTenantContext(attempt, context);
      const idempotencyKey = randomIdempotencyKey(windowRef);
      if (!idempotencyKey) throw new Error('Unable to create a request identifier.');
      const accepted = await firstValueFrom(this.http.post<unknown>(
        `${this.baseUrl}/onboarding-sessions/${encodeURIComponent(attempt.onboardingRef)}/authorization-code`,
        { authorizationCode, stateRef: attempt.stateRef },
        { withCredentials: true, headers: this.requestHeaders(context, idempotencyKey) },
      ));
      if (!isAcceptedJob(accepted)) throw new Error('Invalid code submission response.');
    } catch {
      // The code is never retained or blindly resubmitted after an ambiguous result.
      attempt.message = 'Não foi possível confirmar o recebimento. O código não será reenviado; consulte o estado desta sessão.';
      attempt.state = 'awaiting_server_confirmation';
    }
    this.stopListening(attempt);
    await this.confirmStatus(attempt, true);
  }

  private async onExpiry(attempt: MutableAttempt): Promise<void> {
    if (this.disposed || this.isTerminal(attempt.state)) return;
    this.stopListening(attempt);
    attempt.confirmationRequested = true;
    attempt.state = 'awaiting_server_confirmation';
    attempt.message = 'O prazo informado pelo servidor terminou. Consultando o estado final desta sessão.';
    this.publish('awaiting_server_confirmation', attempt.message);
    await this.confirmStatus(attempt, false);
  }

  private async confirmStatus(attempt: MutableAttempt, scheduleNext: boolean): Promise<void> {
    if (attempt.statusReadInFlight || this.isTerminal(attempt.state)) return;
    attempt.statusReadInFlight = true;
    try {
      const status = await this.readServerStatus(attempt);
      attempt.lastUpdatedAt = status.lastUpdatedAt;
      this.applyServerStatus(attempt, status);
    } catch (error) {
      if (!this.isTerminal(attempt.state)) {
        if (error instanceof TenantContextChangedError) {
          attempt.confirmationRequested = false;
          attempt.message = 'O contexto ativo mudou desde esta sessão. Nenhuma leitura ou ação foi enviada; volte ao contexto original para consultar o resultado.';
        } else {
          attempt.state = 'awaiting_server_confirmation';
          attempt.message = 'O resultado ainda não foi confirmado pelo servidor. Esta tela não declara a conexão pronta.';
        }
      }
    } finally {
      attempt.statusReadInFlight = false;
      this.publishSnapshot();
    }
    if (!this.disposed && !this.isTerminal(attempt.state) && scheduleNext && attempt.confirmationRequested && Date.now() < attempt.expiresAtMs) {
      this.scheduleStatusPoll(attempt);
    }
  }

  private applyServerStatus(attempt: MutableAttempt, status: ServerOnboardingStatus): void {
    attempt.serverStatus = status.status;
    attempt.nextAction = status.nextAction;
    attempt.steps = status.steps;
    if (attempt.pendingRecovery) {
      const stageStatus = status.steps.find((step) => step.name === attempt.pendingRecovery?.stage)?.status;
      const remainsQueued = attempt.pendingRecovery.action === 'RECONCILE'
        ? stageStatus === 'UNKNOWN' || stageStatus === 'RUNNING'
        : stageStatus === 'PENDING' || stageStatus === 'RUNNING';
      if (!remainsQueued) attempt.pendingRecovery = undefined;
    }
    switch (status.status) {
      case 'READY':
        attempt.state = 'ready';
        attempt.message = 'O servidor confirmou esta etapa de conexão.';
        this.stopListening(attempt);
        this.clearTimers(attempt);
        this.publish('confirmed', attempt.message);
        return;
      case 'PARTIAL':
        attempt.state = 'partial';
        attempt.message = `O servidor confirmou um resultado parcial. Próxima ação: ${status.nextAction}.`;
        break;
      case 'CANCELLED':
        attempt.state = 'cancelled';
        attempt.message = 'O servidor confirmou o cancelamento desta sessão.';
        break;
      case 'EXPIRED':
        attempt.state = 'expired';
        attempt.message = 'O servidor confirmou que esta sessão expirou. Inicie uma nova etapa se necessário.';
        break;
      case 'FAILED':
        attempt.state = 'failed';
        attempt.message = 'O servidor confirmou que esta etapa falhou. As conexões anteriores foram preservadas.';
        break;
      default:
        attempt.state = 'awaiting_server_confirmation';
        attempt.message = 'A sessão continua em processamento. O portal atualizará quando o servidor confirmar o resultado.';
        break;
    }
    if (TERMINAL_STATUS.has(status.status)) {
      attempt.pendingRecovery = undefined;
      this.stopListening(attempt);
      this.clearTimers(attempt);
    }
    const state = attempt.state === 'awaiting_server_confirmation' ? 'awaiting_server_confirmation'
      : attempt.state === 'partial' ? 'partial' : 'confirmed';
    this.publish(state, attempt.message);
  }

  private scheduleStatusPoll(attempt: MutableAttempt): void {
    const windowRef = this.documentRef.defaultView;
    if (!windowRef || this.disposed || attempt.replacementOnboardingRef || attempt.pollTimer !== undefined || Date.now() >= attempt.expiresAtMs) return;
    attempt.pollTimer = windowRef.setTimeout(() => {
      attempt.pollTimer = undefined;
      void this.confirmStatus(attempt, true);
    }, 1_500);
  }

  private addAttempt(attempt: MutableAttempt): void {
    this.attempts.push(attempt);
    this.publishSnapshot();
  }

  private hasPendingAttempt(): boolean {
    return this.attempts.some((attempt) => !attempt.replacementOnboardingRef && !this.isTerminal(attempt.state));
  }

  private isTerminal(state: CoexistenceAttemptState): boolean {
    return ['ready', 'cancelled', 'expired', 'failed'].includes(state);
  }

  private availableRecoveryOptions(attempt: MutableAttempt): readonly CoexistenceRecoveryOption[] {
    if (this.ambiguousCreate || attempt.replacementOnboardingRef || this.isTerminal(attempt.state) || !attempt.serverStatus ||
        !attempt.nextAction || !attempt.steps) return Object.freeze([]);
    return recoveryOptionsFor({ status: attempt.serverStatus, nextAction: attempt.nextAction, steps: attempt.steps })
      .filter((option) => option.action !== 'REAUTHORIZE' || !!reauthorizationIdempotencyKey(attempt.onboardingRef));
  }

  private stopListening(attempt: MutableAttempt): void {
    const windowRef = this.documentRef.defaultView;
    if (windowRef && attempt.messageListener) windowRef.removeEventListener('message', attempt.messageListener);
    attempt.messageListener = undefined;
    try { attempt.prepared?.dispose(); } catch { /* Provider teardown is best effort and never changes server state. */ }
    attempt.prepared = undefined;
  }

  private clearTimers(attempt: MutableAttempt): void {
    const windowRef = this.documentRef.defaultView;
    if (windowRef && attempt.expiryTimer !== undefined) windowRef.clearTimeout(attempt.expiryTimer);
    if (windowRef && attempt.pollTimer !== undefined) windowRef.clearTimeout(attempt.pollTimer);
    attempt.expiryTimer = undefined;
    attempt.pollTimer = undefined;
  }

  private publish(state: CoexistenceOnboardingSnapshot['state'], message: string): void {
    this.snapshotValue = Object.freeze({
      state,
      message,
      canStart: this.flowAvailable && !this.startInFlight && !this.ambiguousCreate && !this.hasPendingAttempt(),
      attempts: this.attempts.map((attempt) => Object.freeze({
        onboardingRef: attempt.onboardingRef,
        ordinal: attempt.ordinal,
        state: attempt.state,
        message: attempt.message,
        startedAt: attempt.startedAt,
        recoveryOptions: this.availableRecoveryOptions(attempt),
        recoveryInFlight: attempt.recoveryActionInFlight,
        ...(attempt.pendingRecovery ? { pendingRecovery: attempt.pendingRecovery } : {}),
        ...(attempt.replacementOnboardingRef ? { replacementOnboardingRef: attempt.replacementOnboardingRef } : {}),
        ...(attempt.nextAction ? { nextAction: attempt.nextAction } : {}),
        ...(attempt.steps ? { steps: attempt.steps } : {}),
        ...(attempt.lastUpdatedAt ? { lastUpdatedAt: attempt.lastUpdatedAt } : {}),
      })),
    });
    for (const listener of this.listeners) listener(this.snapshotValue);
  }

  private publishSnapshot(): void {
    this.publish(this.snapshotValue.state, this.snapshotValue.message);
  }
}
