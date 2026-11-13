import type { components } from '@ca-meta/contracts';
import { IdentityDeniedError } from '../identity/identity.errors.js';
import { isVerifiedPortalSession, type VerifiedPortalSession } from '../identity/identity.trust.js';
import { TenantAuthorizationService, TenantContextService } from '../identity/identity.service.js';
import type { MembershipRole } from '../identity/identity.types.js';
import type {
  AssetCapabilityEvidence, AssetCatalogChannel, AssetCatalogPageQuery, AssetCatalogReadModel, ConnectionCatalogPageQuery,
  ConnectionCatalogReadModel, FlowCatalogAppOffset, FlowCatalogVariant, MetaEnvironment,
} from './meta-assets.types.js';
import type { MetaAssetsRepository } from './mysql-meta-assets.repository.js';
import { AssetRefreshCoordinator, AssetRefreshUnavailableError } from './asset-refresh.service.js';
import { isAssetObservationStale, toPublicAssetStatusObservation } from './asset-observation.service.js';

export const META_FLOW_ADAPTER_VARIANTS = Symbol('META_FLOW_ADAPTER_VARIANTS');

export interface AssetCatalogQuery {
  readonly cursor?: string;
  readonly limit: number;
  readonly channel?: AssetCatalogChannel;
  readonly number?: string;
  readonly status?: AssetCatalogReadModel['status'];
}

export interface ConnectionCatalogQuery extends Omit<AssetCatalogQuery, 'status'> {
  readonly flowVariant?: ConnectionCatalogReadModel['flowVariant'];
  readonly status?: ConnectionCatalogPageQuery['status'];
}

const FLOW_CATALOG: readonly FlowCatalogVariant[] = [
  'FACEBOOK',
  'INSTAGRAM',
  'WHATSAPP_EXCLUSIVE',
  'WHATSAPP_COEXISTENCE',
];

const PUBLIC_JOURNEYS: Readonly<Record<FlowCatalogVariant, readonly components['schemas']['FlowVariant'][]>> = {
  FACEBOOK: ['FACEBOOK_LOGIN'],
  INSTAGRAM: ['INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN'],
  WHATSAPP_EXCLUSIVE: ['WHATSAPP_CLOUD_API'],
  WHATSAPP_COEXISTENCE: ['WHATSAPP_COEXISTENCE'],
};

// Conservative advisory freshness bound, aligned with the M3.08 resolver's 3,600-second test profile.
// The operation resolver remains authoritative and independently rechecks policy and all evidence.
const CAPABILITY_EVIDENCE_MAX_AGE_MS = 60 * 60 * 1000;

function observationTime(value: string | null): number | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function hasFreshObservation(value: string | null, now: number): boolean {
  const time = observationTime(value);
  return time !== undefined && time <= now && now - time <= CAPABILITY_EVIDENCE_MAX_AGE_MS;
}

function hasUsableTokenEvidence(evidence: AssetCapabilityEvidence, now: number): boolean {
  if (evidence.tokenHealth !== 'HEALTHY' || !evidence.tokenHealthSource ||
      !hasFreshObservation(evidence.tokenHealthObservedAt, now)) return false;
  if (!evidence.tokenExpirySource || !hasFreshObservation(evidence.tokenExpiryObservedAt, now)) return false;
  if (evidence.tokenExpiryState === 'KNOWN') {
    const expiresAt = observationTime(evidence.tokenExpiresAt);
    if (expiresAt === undefined || expiresAt <= now) return false;
  } else if (evidence.tokenExpiryState === 'PROVIDER_NO_EXPIRY') {
    if (evidence.tokenExpiresAt !== null) return false;
  } else return false;
  const dataAccessExpiresAt = observationTime(evidence.dataAccessExpiresAt);
  return !!evidence.dataAccessExpirySource && hasFreshObservation(evidence.dataAccessExpiryObservedAt, now) &&
    dataAccessExpiresAt !== undefined && dataAccessExpiresAt > now;
}

function publicAssetKind(value: string): components['schemas']['AssetListItem']['kind'] {
  switch (value) {
    case 'FACEBOOK_PAGE': return 'PAGE';
    case 'INSTAGRAM_BUSINESS_ACCOUNT':
    case 'INSTAGRAM_CREATOR_ACCOUNT': return 'INSTAGRAM_ACCOUNT';
    case 'WHATSAPP_BUSINESS_ACCOUNT': return 'WHATSAPP_BUSINESS_ACCOUNT';
    case 'WHATSAPP_PHONE_NUMBER': return 'PHONE_NUMBER';
    default: return 'PAGE';
  }
}

function canOperate(roles: readonly MembershipRole[]): boolean {
  return roles.some((role) => role === 'owner' || role === 'admin' || role === 'operator');
}

function capabilitySnapshot(item: AssetCatalogReadModel, roles: readonly MembershipRole[],
  refreshAvailable: boolean): components['schemas']['AssetCapabilities'] {
  // Mappings remain advisory; unsupported variant/operation pairs stay false until confirmed.
  const now = Date.now();
  const observation = item.statusObservation ?? null;
  const observationFreshActive = !observation || (!isAssetObservationStale(observation, new Date(now).toISOString()) &&
    observation.status.availability === 'OBSERVED' && observation.status.value === 'ACTIVE');
  const observationPermissionsKnown = !observation || (observation.permissions.availability === 'OBSERVED' &&
    observation.permissions.grantNames !== null);
  const active = item.status === 'ACTIVE' && item.authorizationStatus === 'VERIFIED' && !item.stale &&
    observationFreshActive && observationPermissionsKnown;
  const operator = canOperate(roles);
  const verifiedEvidence = item.capabilityEvidence.filter((evidence) =>
    evidence.authorizationState === 'ACTIVE' && evidence.assetAuthorizationState === 'ACTIVE' &&
    evidence.verificationState === 'VERIFIED' && evidence.verifiedAt !== null && evidence.verificationSource !== null &&
    hasFreshObservation(evidence.verifiedAt, now) && hasUsableTokenEvidence(evidence, now) &&
    item.status === 'ACTIVE' && !item.stale && observationFreshActive && observationPermissionsKnown,
  );
  const hasGrant = (flow: string, auth: string, grantName: string): boolean => verifiedEvidence.some((evidence) =>
    evidence.flowVariant === flow && evidence.authVariant === auth && evidence.grantNames.includes(grantName) &&
      (!observation || observation.permissions.grantNames?.includes(grantName) === true),
  );
  const whatsapp = item.kind === 'WHATSAPP_PHONE_NUMBER';
  const instagram = item.kind === 'INSTAGRAM_BUSINESS_ACCOUNT' || item.kind === 'INSTAGRAM_CREATOR_ACCOUNT';
  return Object.freeze({
    canSend: operator && active && ((whatsapp && hasGrant('WHATSAPP_EXCLUSIVE', 'WHATSAPP_EMBEDDED_SIGNUP', 'whatsapp_business_messaging')) ||
      (instagram && hasGrant('INSTAGRAM', 'INSTAGRAM_LOGIN', 'instagram_business_manage_messages'))),
    // The accepted capability matrix leaves exact template and subscription grants unconfirmed.
    canManageTemplates: false,
    canSubscribe: false,
    canReauthorize: operator && item.reauthorizationRequired,
    canDisconnect: roles.some((role) => role === 'owner' || role === 'admin') && active,
    canRefresh: operator && refreshAvailable,
  });
}

function toAssetListItem(item: AssetCatalogReadModel, roles: readonly MembershipRole[],
  refreshAvailable: boolean): components['schemas']['AssetListItem'] {
  return Object.freeze({
    id: item.assetRef,
    kind: publicAssetKind(item.kind),
    displayLabel: item.displayLabel,
    status: item.status,
    authorizationStatus: item.authorizationStatus,
    observedAt: item.observedAt,
    lastVerifiedAt: item.lastVerifiedAt,
    verificationSource: item.verificationSource,
    stale: item.stale,
    diagnostics: item.diagnostics,
    capabilities: capabilitySnapshot(item, roles, refreshAvailable),
    ...(item.statusObservation ? { statusObservation: toPublicAssetStatusObservation(item.statusObservation,
      item.authorizationStatus, new Date().toISOString()) } : {}),
  });
}

function toConnection(item: ConnectionCatalogReadModel): components['schemas']['Connection'] {
  return Object.freeze({
    id: item.connectionRef,
    flowVariant: item.flowVariant,
    status: item.status,
    readiness: item.readiness,
    observedAt: item.observedAt,
    lastVerifiedAt: item.lastVerifiedAt,
    verificationSource: item.verificationSource,
    stale: item.stale,
    assetCount: item.assetCount,
    diagnostics: item.diagnostics,
  });
}

function toConnectionAsset(item: AssetCatalogReadModel, roles: readonly MembershipRole[],
  refreshAvailable: boolean): components['schemas']['ConnectionAsset'] {
  return Object.freeze({
    id: item.assetRef,
    kind: publicAssetKind(item.kind),
    displayLabel: item.displayLabel,
    status: item.status,
    authorizationStatus: item.authorizationStatus,
    observedAt: item.observedAt,
    lastVerifiedAt: item.lastVerifiedAt,
    verificationSource: item.verificationSource,
    stale: item.stale,
    diagnostics: item.diagnostics,
    capabilities: capabilitySnapshot(item, roles, refreshAvailable),
    ...(item.statusObservation ? { statusObservation: toPublicAssetStatusObservation(item.statusObservation,
      item.authorizationStatus, new Date().toISOString()) } : {}),
  });
}

function encodeCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length < 16 || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new AssetCatalogInputError();
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded) ||
      Buffer.from(decoded, 'utf8').toString('base64url') !== value) throw new AssetCatalogInputError();
  return decoded;
}

export class AssetCatalogInputError extends Error {
  constructor() { super('Invalid asset catalog query.'); this.name = 'AssetCatalogInputError'; }
}

export class AssetNotFoundError extends Error {
  constructor() { super('Asset not found.'); this.name = 'AssetNotFoundError'; }
}

export class AssetCatalogService {
  constructor(
    private readonly repository: MetaAssetsRepository,
    private readonly contexts: TenantContextService,
    private readonly authorization: TenantAuthorizationService,
    private readonly environment: MetaEnvironment,
    private readonly refreshCoordinator: AssetRefreshCoordinator,
    private readonly registeredFlowVariants: ReadonlySet<FlowCatalogVariant>,
  ) {}

  async listFlows(session: VerifiedPortalSession, tenantContextRef: string, requestId: string,
    appOffset: FlowCatalogAppOffset = 0): Promise<components['schemas']['FlowList']> {
    const scope = await this.readScope(session, tenantContextRef);
    await this.authorization.authorize(scope, 'RESOURCE_READ', scope.tenantId);
    const apps = await this.repository.listFlowCatalogApps({
      tenantId: scope.tenantId, environment: this.environment, appOffset,
    });
    const contexts = apps.items.length > 0 ? apps.items : appOffset === 0
      ? [{ appConfigurationRef: null, environment: this.environment }]
      : [];
    const allItems = contexts.flatMap((app) => FLOW_CATALOG.flatMap((flowVariant) => PUBLIC_JOURNEYS[flowVariant].map((variant) => {
      const appConfigured = app.appConfigurationRef !== null;
      const adapterRegistered = this.registeredFlowVariants.has(flowVariant);
      const availability = !appConfigured ? 'CONFIGURATION_MISSING'
        : !adapterRegistered ? 'ADAPTER_UNAVAILABLE' : 'UNKNOWN';
      return Object.freeze({
        variant,
        flowVariant,
        journeys: PUBLIC_JOURNEYS[flowVariant],
        appConfigurationRef: app.appConfigurationRef,
        environment: app.environment,
        enabled: false,
        availability,
        prerequisites: Object.freeze({
          metaAppConfigured: appConfigured,
          serverAdapterRegistered: adapterRegistered,
          tenantFeatureFlag: 'UNKNOWN' as const,
        }),
        requestedCapabilities: Object.freeze([]),
      });
    })));
    const items = allItems.slice(0, 32);
    return Object.freeze({ items: Object.freeze(items), truncated: apps.truncated || allItems.length > items.length, requestId });
  }

  async listAssets(session: VerifiedPortalSession, tenantContextRef: string, query: AssetCatalogQuery,
    requestId: string): Promise<components['schemas']['AssetListPage']> {
    const scope = await this.readScope(session, tenantContextRef);
    await this.authorization.authorize(scope, 'RESOURCE_READ', scope.tenantId);
    const cursor = decodeCursor(query.cursor);
    const repoQuery: AssetCatalogPageQuery = {
      tenantId: scope.tenantId,
      environment: this.environment,
      limit: query.limit,
      ...(cursor ? { cursor } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.number ? { number: query.number } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const page = await this.repository.listAssetCatalog(repoQuery);
    return Object.freeze({
      items: Object.freeze(page.items.map((item) => toAssetListItem(item, scope.roles, this.refreshCoordinator.available))),
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
      requestId,
    });
  }

  async getAsset(session: VerifiedPortalSession, tenantContextRef: string, assetRef: string,
    requestId: string): Promise<components['schemas']['Asset'] | undefined> {
    const scope = await this.readScope(session, tenantContextRef);
    await this.authorization.authorize(scope, 'RESOURCE_READ', scope.tenantId);
    if (!isUuid(assetRef)) return undefined;
    const item = await this.repository.findAssetCatalog({ tenantId: scope.tenantId, environment: this.environment, assetRef });
    if (!item) return undefined;
    return Object.freeze({ ...toAssetListItem(item, scope.roles, this.refreshCoordinator.available), requestId });
  }

  async listConnections(session: VerifiedPortalSession, tenantContextRef: string, query: ConnectionCatalogQuery,
    requestId: string): Promise<components['schemas']['ConnectionListPage']> {
    const scope = await this.readScope(session, tenantContextRef);
    await this.authorization.authorize(scope, 'RESOURCE_READ', scope.tenantId);
    const cursor = decodeCursor(query.cursor);
    const repoQuery: ConnectionCatalogPageQuery = {
      tenantId: scope.tenantId, environment: this.environment, limit: query.limit,
      ...(cursor ? { cursor } : {}), ...(query.channel ? { channel: query.channel } : {}),
      ...(query.flowVariant ? { flowVariant: query.flowVariant } : {}),
      ...(query.number ? { number: query.number } : {}), ...(query.status ? { status: query.status } : {}),
    };
    const page = await this.repository.listConnectionCatalog(repoQuery);
    return Object.freeze({ items: Object.freeze(page.items.map(toConnection)),
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null, requestId });
  }

  async getConnection(session: VerifiedPortalSession, tenantContextRef: string, connectionRef: string,
    requestId: string): Promise<components['schemas']['ConnectionDetail'] | undefined> {
    const scope = await this.readScope(session, tenantContextRef);
    await this.authorization.authorize(scope, 'RESOURCE_READ', scope.tenantId);
    if (!isUuid(connectionRef)) return undefined;
    const item = await this.repository.findConnectionCatalog({ tenantId: scope.tenantId,
      environment: this.environment, connectionRef });
    if (!item) return undefined;
    return Object.freeze({ ...toConnection(item), assets: Object.freeze((item.assets ?? []).map((asset) =>
      toConnectionAsset(asset, scope.roles, this.refreshCoordinator.available))), requestId });
  }

  async refreshAsset(session: VerifiedPortalSession, tenantContextRef: string, assetRef: string,
    _requestId: string): Promise<components['schemas']['JobAccepted']> {
    const scope = await this.readScope(session, tenantContextRef);
    await this.authorization.authorize(scope, 'REFRESH_ASSET', scope.tenantId);
    if (!isUuid(assetRef)) throw new AssetNotFoundError();
    const item = await this.repository.findAssetCatalog({ tenantId: scope.tenantId, environment: this.environment, assetRef });
    if (!item) throw new AssetNotFoundError();
    if (!this.refreshCoordinator.available) throw new AssetRefreshUnavailableError();
    return this.refreshCoordinator.enqueue({ tenantId: scope.tenantId, assetId: item.assetRef,
      appConfigurationId: item.appConfigurationId, environment: this.environment, requestId: _requestId });
  }

  private async readScope(session: VerifiedPortalSession, tenantContextRef: string) {
    if (!isVerifiedPortalSession(session)) throw new IdentityDeniedError();
    return this.contexts.resolveCurrent(session, tenantContextRef);
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
