import { randomUUID } from 'node:crypto';
import { CredentialVaultDeniedError, CredentialVaultError, CredentialVaultIntegrityError, CredentialVaultKeyUnavailableError,
  CredentialVaultOperationError, CredentialVaultRecordUnavailableError, CredentialVaultRotationBusyError, CredentialVaultRotationError } from './credential-vault.errors.js';
import { decryptCredential, encryptCredential } from './credential-vault-crypto.js';
import type { CredentialBinding, CredentialKeyProvider, CredentialVaultActor, CredentialVaultAuthorizationPort,
  CredentialVaultRepository, CredentialVaultRotationState } from './credential-vault.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const OPERATION = /^[A-Z][A-Z0-9_]{0,63}$/;

export class FailClosedCredentialVaultAuthorization implements CredentialVaultAuthorizationPort {
  async authorize(): Promise<void> {
    throw new CredentialVaultDeniedError();
  }
}

export class CredentialVaultService {
  constructor(
    private readonly repository: CredentialVaultRepository,
    private readonly keyProvider: CredentialKeyProvider,
    private readonly authorization: CredentialVaultAuthorizationPort,
    private readonly rotationOwner = randomUUID(),
  ) {}

  async store(input: CredentialBinding & CredentialVaultActor & { readonly secret: string }): Promise<void> {
    const { secret: secretValue, ...actorBinding } = input;
    let secret = secretValue;
    const binding: CredentialBinding = {
      tenantId: actorBinding.tenantId,
      credentialId: actorBinding.credentialId,
      authorizationId: actorBinding.authorizationId,
      appConfigurationId: actorBinding.appConfigurationId,
      provider: actorBinding.provider,
      environment: actorBinding.environment,
      family: actorBinding.family,
    };
    this.validateBinding(binding);
    this.validateActor(actorBinding);
    await this.authorize({ action: 'STORE', actorRef: actorBinding.actorRef, operation: 'CREDENTIAL_STORE', binding });
    const activeVersion = this.keyProvider.activeVersion();
    if (!activeVersion || !KEY_VERSION.test(activeVersion)) throw new CredentialVaultKeyUnavailableError();
    const key = this.keyProvider.keyFor(activeVersion);
    if (!key || key.length !== 32) {
      key?.fill(0);
      throw new CredentialVaultKeyUnavailableError();
    }
    key.fill(0);
    let envelope;
    try {
      envelope = encryptCredential(binding, secret, activeVersion, this.keyProvider);
      secret = '';
      await this.repository.store(binding, envelope, {
        tenantId: binding.tenantId,
        credentialId: binding.credentialId,
        actorRef: actorBinding.actorRef,
        correlationId: actorBinding.correlationId,
        action: 'STORE',
        operation: 'CREDENTIAL_STORE',
        keyVersion: activeVersion,
      });
    } catch {
      throw new CredentialVaultOperationError();
    } finally {
      secret = '';
    }
  }

  /** Executes server-side work with a credential; plaintext is never returned by this service. */
  async withCredential<T>(input: CredentialBinding & CredentialVaultActor & { readonly operation: string },
    execute: (secret: string) => Promise<T>): Promise<T> {
    const { operation, ...actorBinding } = input;
    const binding: CredentialBinding = {
      tenantId: actorBinding.tenantId,
      credentialId: actorBinding.credentialId,
      authorizationId: actorBinding.authorizationId,
      appConfigurationId: actorBinding.appConfigurationId,
      provider: actorBinding.provider,
      environment: actorBinding.environment,
      family: actorBinding.family,
    };
    this.validateBinding(binding);
    this.validateActor(actorBinding);
    if (typeof operation !== 'string' || !OPERATION.test(operation)) throw new CredentialVaultDeniedError();
    await this.authorize({ action: 'USE', actorRef: actorBinding.actorRef, operation, binding });
    let record;
    try {
      record = await this.repository.findActive(binding);
    } catch {
      throw new CredentialVaultRecordUnavailableError();
    }
    if (!record || !this.sameBinding(record, binding) || typeof record.envelope.keyVersion !== 'string' ||
        !KEY_VERSION.test(record.envelope.keyVersion)) {
      throw new CredentialVaultRecordUnavailableError();
    }
    const key = this.keyProvider.keyFor(record.envelope.keyVersion);
    if (!key) throw new CredentialVaultKeyUnavailableError();
    let secret: string;
    try {
      secret = decryptCredential(binding, record.envelope, key);
    } catch {
      throw new CredentialVaultIntegrityError();
    }
    try {
      await this.repository.audit({
        tenantId: binding.tenantId,
        credentialId: binding.credentialId,
        actorRef: actorBinding.actorRef,
        correlationId: actorBinding.correlationId,
        action: 'DECRYPT',
        operation,
        keyVersion: record.envelope.keyVersion,
      });
    } catch {
      secret = '';
      throw new CredentialVaultDeniedError();
    }
    try {
      return await execute(secret);
    } catch {
      // Provider/library exceptions may include request headers or response bodies; never propagate them here.
      throw new CredentialVaultOperationError();
    } finally {
      secret = '';
    }
  }

  async beginRotation(actor: CredentialVaultActor): Promise<CredentialVaultRotationState> {
    this.validateActor(actor);
    const targetKeyVersion = this.keyProvider.activeVersion();
    if (!targetKeyVersion || !KEY_VERSION.test(targetKeyVersion)) {
      throw new CredentialVaultKeyUnavailableError();
    }
    this.assertKeyAvailable(targetKeyVersion);
    await this.authorize({ action: 'ROTATE', actorRef: actor.actorRef, operation: 'CREDENTIAL_KEY_ROTATION', targetKeyVersion });
    try {
      return await this.repository.ensureRotation(targetKeyVersion);
    } catch {
      throw new CredentialVaultRotationError();
    }
  }

  async rotateNextBatch(actor: CredentialVaultActor, targetKeyVersion: string, batchSize = 100): Promise<{ processed: number; done: boolean }> {
    this.validateActor(actor);
    if (!KEY_VERSION.test(targetKeyVersion) || targetKeyVersion !== this.keyProvider.activeVersion() ||
        !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
      throw new CredentialVaultRotationError();
    }
    this.assertKeyAvailable(targetKeyVersion);
    await this.authorize({ action: 'ROTATE', actorRef: actor.actorRef, operation: 'CREDENTIAL_KEY_ROTATION', targetKeyVersion });
    let lease: Awaited<ReturnType<CredentialVaultRepository['acquireRotationLease']>>;
    try {
      lease = await this.repository.acquireRotationLease(targetKeyVersion, this.rotationOwner, randomUUID(), 30);
    } catch {
      throw new CredentialVaultRotationError();
    }
    if (!lease) throw new CredentialVaultRotationBusyError();
    try {
      const result = await this.repository.rotateBatch(
        lease,
        batchSize,
        (record) => {
          const key = this.keyProvider.keyFor(record.envelope.keyVersion);
          if (!key) throw new CredentialVaultKeyUnavailableError();
          let plaintext = decryptCredential(record, record.envelope, key);
          try {
            return encryptCredential(record, plaintext, targetKeyVersion, this.keyProvider);
          } finally {
            // JS strings are immutable; overwrite this local reference immediately after encryption.
            plaintext = '';
          }
        },
        (record, keyVersion) => ({
          tenantId: record.tenantId,
          credentialId: record.credentialId,
          actorRef: actor.actorRef,
          correlationId: actor.correlationId,
          operation: 'CREDENTIAL_KEY_ROTATION',
          action: 'ROTATE',
          keyVersion,
        }),
      );
      return result;
    } catch (error) {
      const safeErrorCode = error instanceof CredentialVaultKeyUnavailableError
        ? 'KEY_UNAVAILABLE'
        : error instanceof CredentialVaultIntegrityError ? 'CIPHERTEXT_INVALID' : 'ROTATION_FAILED';
      await this.repository.pauseRotation(lease, safeErrorCode).catch(() => undefined);
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultRotationError();
    }
  }

  async rotationState(targetKeyVersion: string): Promise<CredentialVaultRotationState> {
    try {
      return await this.repository.getRotationState(targetKeyVersion);
    } catch {
      throw new CredentialVaultRotationError();
    }
  }

  async resumeRotation(actor: CredentialVaultActor, targetKeyVersion: string): Promise<CredentialVaultRotationState> {
    this.validateActor(actor);
    if (!KEY_VERSION.test(targetKeyVersion) || targetKeyVersion !== this.keyProvider.activeVersion()) {
      throw new CredentialVaultRotationError();
    }
    this.assertKeyAvailable(targetKeyVersion);
    await this.authorize({ action: 'ROTATE', actorRef: actor.actorRef, operation: 'CREDENTIAL_KEY_ROTATION', targetKeyVersion });
    try {
      return await this.repository.resumeRotation(targetKeyVersion);
    } catch {
      throw new CredentialVaultRotationError();
    }
  }

  private async authorize(request: Parameters<CredentialVaultAuthorizationPort['authorize']>[0]): Promise<void> {
    try {
      await this.authorization.authorize(request);
    } catch {
      throw new CredentialVaultDeniedError();
    }
  }

  private validateBinding(binding: CredentialBinding): void {
    if (![binding.tenantId, binding.credentialId, binding.authorizationId, binding.appConfigurationId].every((value) => UUID.test(value)) ||
        binding.provider !== 'META' || !/^[A-Za-z0-9_-]{1,16}$/.test(binding.environment) ||
        !/^[A-Z][A-Z0-9_-]{0,31}$/.test(binding.family)) {
      throw new CredentialVaultRecordUnavailableError();
    }
  }

  private validateActor(actor: CredentialVaultActor): void {
    if (typeof actor.actorRef !== 'string' || !UUID.test(actor.actorRef) ||
        typeof actor.correlationId !== 'string' || !UUID.test(actor.correlationId)) throw new CredentialVaultDeniedError();
  }

  private sameBinding(left: CredentialBinding, right: CredentialBinding): boolean {
    return left.tenantId === right.tenantId && left.credentialId === right.credentialId &&
      left.authorizationId === right.authorizationId && left.appConfigurationId === right.appConfigurationId &&
      left.provider === right.provider && left.environment === right.environment && left.family === right.family;
  }

  private assertKeyAvailable(version: string): void {
    const key = this.keyProvider.keyFor(version);
    if (!key || key.length !== 32) {
      key?.fill(0);
      throw new CredentialVaultKeyUnavailableError();
    }
    key.fill(0);
  }
}
