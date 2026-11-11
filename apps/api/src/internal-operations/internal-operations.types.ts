import type { MetaEnvironment } from '../meta-assets/meta-assets.types.js';
import type { CredentialResolutionHandle, CredentialResolverOperation, MetaAuthVariant, MetaFlowVariant } from '../credentials/credential-resolver.types.js';

export type InternalAssetOperation =
  | 'SEND_MESSAGE'
  | 'MANAGE_TEMPLATES'
  | 'MANAGE_COMMENTS'
  | 'READ_STATUS'
  | 'SUBSCRIBE_WEBHOOKS';

export type InternalAssetOperationPayload =
  | { readonly operation: 'SEND_MESSAGE'; readonly recipientRef: string; readonly message: { readonly kind: 'TEXT'; readonly text: string } | { readonly kind: 'TEMPLATE'; readonly name: string; readonly language: string; readonly parameters: readonly string[] } }
  | { readonly operation: 'MANAGE_TEMPLATES'; readonly action: 'LIST' }
  | { readonly operation: 'MANAGE_TEMPLATES'; readonly action: 'CREATE'; readonly name: string; readonly language: string; readonly category: 'AUTHENTICATION' | 'MARKETING' | 'UTILITY'; readonly bodyText: string; readonly exampleValues?: readonly string[] }
  | { readonly operation: 'MANAGE_COMMENTS'; readonly action: 'LIST' }
  | { readonly operation: 'MANAGE_COMMENTS'; readonly action: 'REPLY'; readonly commentRef: string; readonly text: string }
  | { readonly operation: 'READ_STATUS' }
  | { readonly operation: 'SUBSCRIBE_WEBHOOKS'; readonly action: 'READ' | 'RECONCILE' };

export interface InternalAssetOperationContext {
  readonly tenantId: string;
  readonly servicePrincipalId: string;
  readonly assetId: string;
  readonly appConfigurationId: string;
  readonly environment: MetaEnvironment;
  readonly flowVariant: MetaFlowVariant;
  readonly authVariant: MetaAuthVariant;
  readonly configurationRef: string;
  /** Resolved from the tenant-scoped asset row. Never accepted from the service request. */
  readonly providerObjectId: string;
  /** Resolved from a tenant/asset-bound recipient or comment reference; never caller-supplied provider ID. */
  readonly providerTargetId?: string;
  readonly correlationId: string;
}

export interface InternalAssetOperationCommand {
  readonly operationId: string;
  readonly idempotencyKeyHash: string;
  readonly payloadHash: string;
  readonly context: InternalAssetOperationContext;
  readonly payload: InternalAssetOperationPayload;
}

export type InternalAssetOperationStatus = 'UNKNOWN' | 'SUCCEEDED' | 'FAILED';

export interface InternalAssetOperationResult {
  readonly operationId: string;
  readonly status: InternalAssetOperationStatus;
  readonly reasonCode?: string;
}

export interface InternalAssetOperationRow extends InternalAssetOperationResult {
  readonly tenantId: string;
  readonly servicePrincipalId: string;
  readonly assetId: string;
  readonly operation: InternalAssetOperation;
  readonly payloadHash: string;
  readonly providerReferenceHash?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InternalAssetOperationClaim {
  readonly row: InternalAssetOperationRow;
  /** Only the request that inserted the unique idempotency row may execute its side effect. */
  readonly isNew: boolean;
}

export interface InternalAssetOperationStore {
  /** Find an existing result after identity/asset revalidation but before new-operation gates. */
  findByIdempotency(input: {
    readonly tenantId: string;
    readonly servicePrincipalId: string;
    readonly assetId: string;
    readonly operation: InternalAssetOperation;
    readonly idempotencyKeyHash: string;
    readonly payloadHash: string;
  }): Promise<InternalAssetOperationRow | undefined>;
  claim(input: {
    readonly tenantId: string;
    readonly servicePrincipalId: string;
    readonly assetId: string;
    readonly operationId: string;
    readonly operation: InternalAssetOperation;
    readonly idempotencyKeyHash: string;
    readonly payloadHash: string;
    readonly correlationId: string;
  }): Promise<InternalAssetOperationClaim>;
  complete(input: {
    readonly operationId: string;
    readonly tenantId: string;
    readonly servicePrincipalId: string;
    readonly status: InternalAssetOperationStatus;
    readonly reasonCode?: string;
    /** SHA-256 of a provider message/operation reference; raw provider IDs are not persisted. */
    readonly providerReferenceHash?: string;
    readonly correlationId: string;
  }): Promise<InternalAssetOperationRow>;
  find(input: { readonly operationId: string; readonly tenantId: string; readonly servicePrincipalId: string }): Promise<InternalAssetOperationRow | undefined>;
}

export interface InternalAssetOperationAsset {
  readonly tenantId: string;
  readonly assetId: string;
  readonly appConfigurationId: string;
  readonly environment: MetaEnvironment;
  readonly flowVariant: MetaFlowVariant;
  readonly authVariant: MetaAuthVariant;
  readonly providerObjectId: string;
}

export interface InternalAssetOperationAssetRepository {
  /** Returns only one currently active, verified authorization for this tenant/asset/environment. */
  findAuthorizedAsset(input: { readonly tenantId: string; readonly assetId: string; readonly environment: MetaEnvironment }): Promise<InternalAssetOperationAsset | undefined>;
}

export interface InternalAssetOperationTargetResolver {
  /** Resolve an internal service reference to a provider reference only inside the current tenant/asset. */
  resolveTarget(input: {
    readonly tenantId: string;
    readonly assetId: string;
    readonly targetRef: string;
    readonly targetKind: 'RECIPIENT' | 'COMMENT';
  }): Promise<string | undefined>;
}

export interface InternalAssetOperationAdapterInput {
  readonly command: InternalAssetOperationCommand;
  readonly credentialHandle: CredentialResolutionHandle;
  readonly credentialOperation: CredentialResolverOperation;
}

export type InternalAssetOperationAdapterOutcome =
  | { readonly status: 'SUCCEEDED'; readonly providerReferenceHash?: string }
  | { readonly status: 'FAILED'; readonly reasonCode: string; readonly providerReferenceHash?: string }
  | { readonly status: 'UNKNOWN'; readonly reasonCode: string; readonly providerReferenceHash?: string };

export interface InternalAssetOperationAdapter {
  readonly available: boolean;
  execute(input: InternalAssetOperationAdapterInput): Promise<InternalAssetOperationAdapterOutcome>;
}

export const INTERNAL_ASSET_OPERATION_STORE = Symbol('INTERNAL_ASSET_OPERATION_STORE');
export const INTERNAL_ASSET_OPERATION_ASSET_REPOSITORY = Symbol('INTERNAL_ASSET_OPERATION_ASSET_REPOSITORY');
export const INTERNAL_ASSET_OPERATION_TARGET_RESOLVER = Symbol('INTERNAL_ASSET_OPERATION_TARGET_RESOLVER');
export const INTERNAL_ASSET_OPERATION_ADAPTER = Symbol('INTERNAL_ASSET_OPERATION_ADAPTER');
