import type { CredentialExecutionContext, CredentialResolutionHandle, CredentialResolverOperation } from '../credentials/credential-resolver.types.js';
import type { MetaAuthenticationVariant, MetaOperation, MetaProductFlow } from '../meta-config/capability-manifest.js';
import type { RuntimeEnvironment } from '../config/environment.js';

export type MetaGraphHost = 'graph.facebook.com' | 'graph.instagram.com';
export type MetaGraphMethod = 'GET' | 'POST';
export type MetaGraphJson = null | boolean | number | string | readonly MetaGraphJson[] | { readonly [key: string]: MetaGraphJson };
export type MetaGraphQuery = Readonly<{
  readonly fields?: string;
  readonly limit?: number;
  readonly after?: string;
  readonly since?: number;
  readonly until?: number;
}>;

/** Server-created context that pairs the resolver's opaque handle with its trusted policy context. */
export interface MetaGraphExecutionContext extends CredentialExecutionContext {
  readonly configurationRef: string;
  /** Provider object ID resolved server-side for the internal assetId; never accepted from a browser URL. */
  readonly providerObjectId: string;
}

export interface MetaGraphBaseInput {
  readonly context: MetaGraphExecutionContext;
  readonly credentialHandle: CredentialResolutionHandle;
  readonly credentialCapability: CredentialResolverOperation;
  readonly operation: MetaOperation;
  readonly correlationId: string;
  /** A Meta object id already authorized by the server-side asset context. */
  readonly resourceId: string;
  readonly query?: MetaGraphQuery;
}

export type MetaGraphAssetEdge = 'accounts' | 'businesses' | 'comments' | 'instagram_accounts' |
  'message_templates' | 'owned_pages' | 'phone_numbers' | 'subscribed_apps';

export type MetaGraphInput =
  | (MetaGraphBaseInput & { readonly endpoint: 'OBJECT_READ' })
  | (MetaGraphBaseInput & { readonly endpoint: 'ASSET_EDGE_LIST'; readonly edge: Exclude<MetaGraphAssetEdge, 'comments' | 'message_templates' | 'subscribed_apps'> })
  | (MetaGraphBaseInput & { readonly endpoint: 'TEMPLATES_LIST' })
  | (MetaGraphBaseInput & { readonly endpoint: 'COMMENTS_LIST' })
  | (MetaGraphBaseInput & { readonly endpoint: 'SUBSCRIBED_APPS_LIST' })
  | (MetaGraphBaseInput & { readonly endpoint: 'SEND_MESSAGE'; readonly body: Readonly<Record<string, MetaGraphJson>> })
  | (MetaGraphBaseInput & { readonly endpoint: 'TEMPLATE_CREATE'; readonly body: Readonly<Record<string, MetaGraphJson>> })
  | (MetaGraphBaseInput & { readonly endpoint: 'COMMENT_REPLY'; readonly body: Readonly<Record<string, MetaGraphJson>> })
  | (MetaGraphBaseInput & { readonly endpoint: 'SUBSCRIBE_APP'; readonly body: Readonly<Record<string, MetaGraphJson>> });

export type MetaGraphSafeErrorCategory =
  | 'CAPABILITY_DISABLED'
  | 'CONFIGURATION_UNAVAILABLE'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'CREDENTIAL_REJECTED'
  | 'PERMISSION_REQUIRED'
  | 'REQUEST_BUDGET_EXHAUSTED'
  | 'REQUEST_INVALID'
  | 'RESPONSE_INVALID'
  | 'NETWORK_ERROR'
  | 'RATE_LIMITED'
  | 'TRANSIENT_PROVIDER_FAILURE'
  | 'INVALID_REQUEST'
  | 'AUTHORIZATION_FAILED'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_UNAVAILABLE'
  | 'REDIRECT_REFUSED'
  | 'RESPONSE_TOO_LARGE'
  | 'PAGINATION_INVALID'
  | 'PAGINATION_LOOP'
  | 'LIMIT_REACHED'
  | 'BUSY'
  | 'AMBIGUOUS_POST';

export interface MetaGraphSafeError {
  readonly category: MetaGraphSafeErrorCategory;
  readonly providerType?: string;
  readonly retryable: boolean;
  readonly ambiguous: boolean;
  readonly recommendedAction?: 'REAUTHENTICATE' | 'REVIEW_PERMISSION' | 'RECONCILE' | 'RETRY_LATER';
  readonly httpStatus?: number;
  readonly providerCode?: number;
  readonly providerSubcode?: number;
  readonly traceId?: string;
  readonly retryAfterSeconds?: number;
  readonly capabilityReason?: string;
  readonly timeoutPhase?: 'CONNECT' | 'HEADERS' | 'READ' | 'OVERALL';
}

export interface MetaGraphCallResult {
  readonly outcome: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  readonly data?: MetaGraphJson;
  readonly error?: MetaGraphSafeError;
  readonly httpStatus?: number;
  readonly attempts: number;
  readonly retries: number;
  readonly retryable: boolean;
  readonly ambiguous: boolean;
}

export interface MetaGraphCheckpoint {
  /** Opaque provider cursor; it is internal state and must never be logged or sent to a browser. */
  readonly after: string | null;
  readonly pagesProcessed: number;
  readonly itemsProcessed: number;
}

export interface MetaGraphCollectionResult {
  readonly outcome: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  readonly data: readonly MetaGraphJson[];
  readonly checkpoint?: MetaGraphCheckpoint;
  readonly error?: MetaGraphSafeError;
  readonly httpStatus?: number;
  readonly attempts: number;
  readonly retries: number;
  readonly retryable: boolean;
  readonly ambiguous: boolean;
}

export interface MetaGraphMetricLabels {
  readonly operation: MetaOperation;
  readonly product: MetaGraphExecutionContext['flowVariant'];
  readonly environment: MetaGraphExecutionContext['environment'];
  readonly outcome: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'UNKNOWN';
  readonly category: MetaGraphSafeErrorCategory | 'NONE';
  readonly attempts: number;
  readonly retries: number;
}

export interface MetaGraphMetrics {
  record(labels: MetaGraphMetricLabels): void;
}

export const META_GRAPH_METRICS = Symbol('META_GRAPH_METRICS');

export interface MetaGraphTransportRequest {
  readonly host: MetaGraphHost;
  readonly flowVariant: MetaProductFlow;
  readonly authVariant: MetaAuthenticationVariant;
  readonly environment: RuntimeEnvironment;
  readonly configurationRef: string;
  readonly operation: MetaOperation;
  readonly graphApiVersion: string;
  readonly correlationId: string;
  readonly method: MetaGraphMethod;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly connectTimeoutMs: number;
  readonly headersTimeoutMs: number;
  readonly readTimeoutMs: number;
  readonly overallTimeoutMs: number;
  readonly maxResponseBytes: number;
}

export interface MetaGraphTransportResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

export interface MetaGraphTransport {
  send(request: MetaGraphTransportRequest): Promise<MetaGraphTransportResponse>;
}

export const META_GRAPH_TRANSPORT = Symbol('META_GRAPH_TRANSPORT');
