import { randomUUID } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { ApiEnvironment } from '../config/environment.js';
import type { CredentialResolverService } from '../credentials/credential-resolver.service.js';
import type { CredentialResolverOperation } from '../credentials/credential-resolver.types.js';
import type { ServiceTenantAuthorizationService } from '../identity/identity.service.js';
import type { ServiceCredentialProofVerifier } from '../identity/identity.trust.js';
import type { MetaAppConfigRegistry } from '../meta-config/meta-app-config.registry.js';
import {
  hashInternalAssetOperation,
  hashInternalServiceIdempotencyKey,
  InternalAssetOperationInputError,
  InternalAssetOperationUnavailableError,
  isUuid,
} from './internal-operations.validation.js';
import {
  INTERNAL_ASSET_OPERATION_ADAPTER,
  INTERNAL_ASSET_OPERATION_ASSET_REPOSITORY,
  INTERNAL_ASSET_OPERATION_STORE,
  INTERNAL_ASSET_OPERATION_TARGET_RESOLVER,
  type InternalAssetOperation,
  type InternalAssetOperationAdapter,
  type InternalAssetOperationAssetRepository,
  type InternalAssetOperationPayload,
  type InternalAssetOperationResult,
  type InternalAssetOperationRow,
  type InternalAssetOperationStore,
  type InternalAssetOperationTargetResolver,
} from './internal-operations.types.js';

function bearerProof(value: string | undefined): string {
  const matched = typeof value === 'string' ? /^Bearer ([A-Za-z0-9._~-]{32,512})$/.exec(value) : null;
  if (!matched) throw new UnauthorizedException();
  return matched[1]!;
}

function isReasonCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) && [
    'PROVIDER_REJECTED', 'PROVIDER_RESULT_UNKNOWN', 'OPERATION_FAILED', 'OPERATION_UNSUPPORTED',
  ].includes(value);
}

function providerReferenceHash(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

function resultFromRow(row: InternalAssetOperationRow): InternalAssetOperationResult {
  return Object.freeze({ operationId: row.operationId, status: row.status, ...(row.reasonCode ? { reasonCode: row.reasonCode } : {}) });
}

function credentialOperation(operation: InternalAssetOperation): CredentialResolverOperation {
  return operation;
}

@Injectable()
export class InternalAssetOperationsService {
  constructor(
    private readonly proofVerifier: ServiceCredentialProofVerifier,
    private readonly serviceAuthorization: ServiceTenantAuthorizationService,
    private readonly credentials: CredentialResolverService,
    private readonly registry: MetaAppConfigRegistry,
    @Inject(INTERNAL_ASSET_OPERATION_ASSET_REPOSITORY) private readonly assets: InternalAssetOperationAssetRepository,
    @Inject(INTERNAL_ASSET_OPERATION_STORE) private readonly store: InternalAssetOperationStore,
    @Inject(INTERNAL_ASSET_OPERATION_TARGET_RESOLVER) private readonly targets: InternalAssetOperationTargetResolver,
    @Inject(INTERNAL_ASSET_OPERATION_ADAPTER) private readonly adapter: InternalAssetOperationAdapter,
    private readonly environment: Pick<ApiEnvironment, 'nodeEnv'>,
  ) {}

  async execute(input: {
    readonly authorization: string | undefined;
    readonly assetId: string;
    readonly idempotencyKey: string | undefined;
    readonly payload: InternalAssetOperationPayload;
  }): Promise<InternalAssetOperationResult> {
    if (!isUuid(input.assetId)) throw new InternalAssetOperationInputError();
    const assetId = input.assetId.toLowerCase();
    const proof = bearerProof(input.authorization);
    const verified = await this.proofVerifier.verifyCredential(proof);
    if (!verified) throw new UnauthorizedException();
    const scope = await this.serviceAuthorization.resolveScope(verified);
    await this.serviceAuthorization.authorize(scope, 'META_CONNECTION_EXECUTE', scope.tenantId);
    await this.serviceAuthorization.authorize(scope, 'CREDENTIAL_USE', scope.tenantId);

    const asset = await this.assets.findAuthorizedAsset({
      tenantId: scope.tenantId,
      assetId,
      environment: this.environment.nodeEnv,
    });
    if (!asset || asset.tenantId !== scope.tenantId || asset.assetId !== assetId) {
      throw new InternalAssetOperationUnavailableError();
    }
    const configuration = this.registry.resolve(asset.flowVariant, asset.authVariant, asset.environment);
    if (!configuration) throw new InternalAssetOperationUnavailableError();
    const profile = this.registry.bootstrap().profiles.find((entry) =>
      entry.flowVariant === asset.flowVariant && entry.authVariant === asset.authVariant);
    const capability = profile?.capabilities.find((entry) => entry.operation === input.payload.operation);
    if (!capability?.enabled || !this.adapter.available) throw new InternalAssetOperationUnavailableError();

    const target = input.payload.operation === 'SEND_MESSAGE'
      ? { targetRef: input.payload.recipientRef, targetKind: 'RECIPIENT' as const }
      : input.payload.operation === 'MANAGE_COMMENTS' && input.payload.action === 'REPLY'
        ? { targetRef: input.payload.commentRef, targetKind: 'COMMENT' as const }
        : undefined;
    let providerTargetId: string | undefined;
    if (target) {
      try {
        providerTargetId = await this.targets.resolveTarget({ tenantId: scope.tenantId, assetId: asset.assetId, ...target });
      } catch {
        throw new InternalAssetOperationUnavailableError();
      }
    }
    if (target && (!providerTargetId || !/^[A-Za-z0-9:_-]{1,128}$/.test(providerTargetId))) {
      throw new InternalAssetOperationUnavailableError();
    }

    let idempotencyKeyHash: string;
    try {
      idempotencyKeyHash = hashInternalServiceIdempotencyKey(input.idempotencyKey ?? '');
    } catch {
      throw new InternalAssetOperationInputError();
    }
    const payloadHash = hashInternalAssetOperation(input.payload);
    const operationId = randomUUID();
    const correlationId = randomUUID();
    const claimed = await this.store.claim({
      tenantId: scope.tenantId,
      servicePrincipalId: scope.principalId,
      assetId: asset.assetId,
      operation: input.payload.operation,
      operationId,
      idempotencyKeyHash,
      payloadHash,
      correlationId,
    });
    if (!claimed.isNew) return resultFromRow(claimed.row);

    const command = Object.freeze({
      operationId: claimed.row.operationId,
      idempotencyKeyHash,
      payloadHash,
      context: Object.freeze({
        tenantId: scope.tenantId,
        servicePrincipalId: scope.principalId,
        assetId: asset.assetId,
        appConfigurationId: asset.appConfigurationId,
        environment: asset.environment,
        flowVariant: asset.flowVariant,
        authVariant: asset.authVariant,
        configurationRef: configuration.configurationRef,
        providerObjectId: asset.providerObjectId,
        ...(providerTargetId ? { providerTargetId } : {}),
        correlationId,
      }),
      payload: input.payload,
    });

    let resolved;
    try {
      resolved = await this.credentials.resolve({
        tenantId: scope.tenantId,
        provider: 'META',
        appConfigurationId: asset.appConfigurationId,
        environment: asset.environment,
        assetId: asset.assetId,
        operation: credentialOperation(input.payload.operation),
      }, { serviceScope: scope, correlationId });
    } catch {
      const failed = await this.store.complete({
        operationId: claimed.row.operationId, tenantId: scope.tenantId, servicePrincipalId: scope.principalId,
        status: 'FAILED', reasonCode: 'CREDENTIAL_UNAVAILABLE', correlationId,
      });
      return resultFromRow(failed);
    }

    let outcome: Awaited<ReturnType<InternalAssetOperationAdapter['execute']>>;
    try {
      outcome = await this.adapter.execute({
        command,
        credentialHandle: resolved.handle,
        credentialOperation: credentialOperation(input.payload.operation),
      });
    } catch {
      // The adapter may have reached Meta before a timeout. Preserve UNKNOWN and never retry blindly.
      const unknown = await this.store.complete({
        operationId: claimed.row.operationId, tenantId: scope.tenantId, servicePrincipalId: scope.principalId,
        status: 'UNKNOWN', reasonCode: 'PROVIDER_RESULT_UNKNOWN', correlationId,
      });
      return resultFromRow(unknown);
    }

    const normalized = outcome.status === 'SUCCEEDED'
      ? { status: 'SUCCEEDED' as const, ...(providerReferenceHash(outcome.providerReferenceHash) ? { providerReferenceHash: providerReferenceHash(outcome.providerReferenceHash)! } : {}) }
      : outcome.status === 'FAILED'
        ? { status: 'FAILED' as const, reasonCode: isReasonCode(outcome.reasonCode) ? outcome.reasonCode : 'OPERATION_FAILED',
          ...(providerReferenceHash(outcome.providerReferenceHash) ? { providerReferenceHash: providerReferenceHash(outcome.providerReferenceHash)! } : {}) }
        : { status: 'UNKNOWN' as const, reasonCode: 'PROVIDER_RESULT_UNKNOWN' };
    const completed = await this.store.complete({
      operationId: claimed.row.operationId,
      tenantId: scope.tenantId,
      servicePrincipalId: scope.principalId,
      ...normalized,
      correlationId,
    });
    return resultFromRow(completed);
  }

  async status(input: { readonly authorization: string | undefined; readonly operationId: string }): Promise<InternalAssetOperationResult | undefined> {
    if (!isUuid(input.operationId)) throw new InternalAssetOperationInputError();
    const verified = await this.proofVerifier.verifyCredential(bearerProof(input.authorization));
    if (!verified) throw new UnauthorizedException();
    const scope = await this.serviceAuthorization.resolveScope(verified);
    await this.serviceAuthorization.authorize(scope, 'META_CONNECTION_EXECUTE', scope.tenantId);
    const row = await this.store.find({
      operationId: input.operationId.toLowerCase(),
      tenantId: scope.tenantId,
      servicePrincipalId: scope.principalId,
    });
    return row ? resultFromRow(row) : undefined;
  }
}
