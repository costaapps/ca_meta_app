import { createHash } from 'node:crypto';
import type { components } from '@ca-meta/contracts';
import { isVerifiedPortalSession, type VerifiedPortalSession } from '../identity/identity.trust.js';
import { TenantAuthorizationService, TenantContextService } from '../identity/identity.service.js';
import type { OnboardingSessionService } from '../onboarding/onboarding-session.service.js';
import { OnboardingConfigurationUnavailableError, OnboardingConflictError } from '../onboarding/onboarding-session.types.js';
import type { ConnectionLifecycleCommandRepository, ConnectionLifecycleDisconnectResult } from './connection-lifecycle.types.js';
import { reauthorizationFlow } from './connection-lifecycle.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY = /^[A-Za-z0-9._~-]{16,128}$/;

export class ConnectionLifecycleInputError extends Error {
  constructor() { super('Connection lifecycle request is invalid.'); this.name = 'ConnectionLifecycleInputError'; }
}

export class ConnectionLifecycleNotFoundError extends Error {
  constructor() { super('Connection was not found.'); this.name = 'ConnectionLifecycleNotFoundError'; }
}

export class ConnectionLifecycleScopeRequiredError extends Error {
  constructor() { super('Select one resource before disconnecting a shared authorization.'); this.name = 'ConnectionLifecycleScopeRequiredError'; }
}

export class ConnectionLifecycleConflictError extends Error {
  constructor() { super('Connection lifecycle request conflicts with existing state.'); this.name = 'ConnectionLifecycleConflictError'; }
}

export class ConnectionLifecycleConfigurationUnavailableError extends Error {
  constructor() { super('Reauthorization is unavailable for this connection.'); this.name = 'ConnectionLifecycleConfigurationUnavailableError'; }
}

/** Local access changes and reauthorization session creation. Provider cleanup is represented as gated work only. */
export class ConnectionLifecycleService {
  constructor(
    private readonly repository: ConnectionLifecycleCommandRepository,
    private readonly contexts: TenantContextService,
    private readonly authorization: TenantAuthorizationService,
    private readonly onboarding: OnboardingSessionService,
  ) {}

  async disconnect(input: {
    readonly session: VerifiedPortalSession;
    readonly tenantContextRef: string;
    readonly authorizationRef: string;
    readonly assetRef?: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<ConnectionLifecycleDisconnectResult> {
    if (!isVerifiedPortalSession(input.session) || !UUID.test(input.authorizationRef) ||
      (input.assetRef !== undefined && !UUID.test(input.assetRef)) || !IDEMPOTENCY.test(input.idempotencyKey) ||
      !UUID.test(input.correlationId)) throw new ConnectionLifecycleInputError();
    const scope = await this.contexts.resolveCurrent(input.session, input.tenantContextRef);
    await this.authorization.authorize(scope, 'DISCONNECT', scope.tenantId);
    const binding = await this.repository.findBinding({ tenantId: scope.tenantId, authorizationId: input.authorizationRef });
    if (!binding) throw new ConnectionLifecycleNotFoundError();
    // The catalog connection identifier is an authorization. Never broaden a one-resource action to all
    // grants under a shared authorization without an explicit asset reference.
    if (input.assetRef === undefined && binding.assetBindings > 1) throw new ConnectionLifecycleScopeRequiredError();
    try {
      return await this.repository.disconnect({
        tenantId: scope.tenantId,
        actorRef: input.session.principalId,
        authorizationId: binding.authorizationId,
        assetId: input.assetRef ?? null,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'connection-lifecycle-scope-required') {
        throw new ConnectionLifecycleScopeRequiredError();
      }
      if (error instanceof Error && error.message === 'connection-lifecycle-not-found') {
        throw new ConnectionLifecycleNotFoundError();
      }
      if (error instanceof Error && error.message === 'connection-lifecycle-idempotency-conflict') {
        throw new ConnectionLifecycleConflictError();
      }
      throw error;
    }
  }

  async reauthorize(input: {
    readonly session: VerifiedPortalSession;
    readonly tenantContextRef: string;
    readonly authorizationRef: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<components['schemas']['OnboardingCreated']> {
    if (!isVerifiedPortalSession(input.session) || !UUID.test(input.authorizationRef) ||
      !IDEMPOTENCY.test(input.idempotencyKey) || !/^[A-Za-z0-9:_-]{1,128}$/.test(input.requestId)) {
      throw new ConnectionLifecycleInputError();
    }
    const scope = await this.contexts.resolveCurrent(input.session, input.tenantContextRef);
    await this.authorization.authorize(scope, 'REAUTHORIZE', scope.tenantId);
    const binding = await this.repository.findBinding({ tenantId: scope.tenantId, authorizationId: input.authorizationRef });
    if (!binding) throw new ConnectionLifecycleNotFoundError();
    const flowVariant = reauthorizationFlow(binding.flowVariant, binding.authVariant);
    if (!flowVariant || binding.authorizationState === 'REVOKED' || binding.authorizationState === 'DISCONNECTED') {
      throw new ConnectionLifecycleConfigurationUnavailableError();
    }

    // Salt the idempotency value with the exact connection so retries cannot attach the same onboarding
    // session to another authorization. Onboarding creation has no provider effect until its launch URL is used.
    const sessionIdempotency = createHash('sha256')
      .update('ca-meta-reauthorization-v1\0', 'utf8')
      .update(scope.tenantId, 'utf8').update('\0')
      .update(binding.authorizationId, 'utf8').update('\0')
      .update(input.idempotencyKey, 'utf8')
      .digest('base64url');
    try {
      const created = await this.onboarding.create(input.session, input.tenantContextRef, sessionIdempotency, {
        flowVariant,
        requestedCapabilities: [],
        returnRoute: 'connections',
      });
      await this.repository.associateReauthorization({
        tenantId: scope.tenantId,
        actorRef: input.session.principalId,
        authorizationId: binding.authorizationId,
        onboardingSessionId: created.id,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.requestId,
      });
      return Object.freeze({ ...created, requestId: input.requestId });
    } catch (error) {
      if (error instanceof OnboardingConfigurationUnavailableError) {
        throw new ConnectionLifecycleConfigurationUnavailableError();
      }
      if (error instanceof OnboardingConflictError ||
        (error instanceof Error && error.message === 'connection-lifecycle-idempotency-conflict')) {
        throw new ConnectionLifecycleConflictError();
      }
      throw error;
    }
  }

  async readStatus(input: {
    readonly session: VerifiedPortalSession;
    readonly tenantContextRef: string;
    readonly commandRef: string;
    readonly requestId: string;
  }): Promise<components['schemas']['JobStatus']> {
    if (!isVerifiedPortalSession(input.session) || !UUID.test(input.commandRef) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)) throw new ConnectionLifecycleInputError();
    const scope = await this.contexts.resolveCurrent(input.session, input.tenantContextRef);
    await this.authorization.authorize(scope, 'RESOURCE_READ', scope.tenantId);
    const command = await this.repository.findStatus({ tenantId: scope.tenantId, commandRef: input.commandRef });
    if (!command) throw new ConnectionLifecycleNotFoundError();
    const lifecycle = command.operation === 'REAUTHORIZE' ? undefined : Object.freeze({
      commandId: command.commandRef,
      localState: 'DISCONNECTED' as const,
      cleanupState: command.cleanupState!,
      reasonCode: command.safeReasonCode!,
      requestId: input.requestId,
    });
    return Object.freeze({
      id: input.commandRef,
      status: 'PENDING',
      operation: command.operation,
      createdAt: command.createdAt,
      updatedAt: command.updatedAt,
      nextAction: command.operation === 'REAUTHORIZE' ? 'WAIT' : 'CHECK_STATUS',
      safeError: null,
      requestId: input.requestId,
      ...(lifecycle ? { connectionLifecycle: lifecycle } : {}),
    }) satisfies components['schemas']['JobStatus'];
  }
}
