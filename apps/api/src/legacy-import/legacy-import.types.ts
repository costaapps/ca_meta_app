export const LEGACY_IMPORT_PROJECTION_VERSION = 'm3.11-v1' as const;
export const LEGACY_IMPORT_MAX_ROWS = 2_000;

export type LegacyEnvironment = 'development' | 'test' | 'staging' | 'production';

export type LegacyImportReasonCode =
  | 'TENANT_MAPPING_MISSING'
  | 'TENANT_MAPPING_AMBIGUOUS'
  | 'APP_CONFIGURATION_MISSING'
  | 'APP_CONFIGURATION_AMBIGUOUS'
  | 'UNSUPPORTED_SOURCE_KIND'
  | 'INVALID_EXTERNAL_ID'
  | 'INVALID_SOURCE_ROW_ID'
  | 'DUPLICATE_SOURCE_ROW'
  | 'SOURCE_ROW_CHANGED'
  | 'DUPLICATE_TARGET_ASSET'
  | 'WHATSAPP_PARENT_MISSING'
  | 'WHATSAPP_PARENT_AMBIGUOUS'
  | 'WHATSAPP_PARENT_CROSS_TENANT'
  | 'CREDENTIAL_REQUIRES_REAUTH'
  | 'UNKNOWN_SOURCE_SCHEMA';

export interface LegacyTenantMapping {
  readonly tenantId: string;
  readonly legacyDatabaseId: string;
  readonly legacyCompanyId: string;
  readonly environment: LegacyEnvironment;
}

export interface LegacyAppBinding {
  readonly tenantId: string;
  readonly appConfigurationId: string;
  readonly environment: LegacyEnvironment;
}

/** Sanitized source contract. Secret columns must be reduced to presence booleans by the reader. */
export interface LegacyPageRow {
  readonly legacyRowId: string;
  readonly legacyDatabaseId: string;
  readonly legacyCompanyId: string;
  readonly sourceType: string;
  readonly externalId: string;
  readonly userCredentialPresent: boolean;
  readonly pageCredentialPresent: boolean;
  readonly userExpiresAt: string | null;
  readonly pageExpiresAt: string | null;
  readonly parentChannelId: string | null;
}

/** The phone number itself is intentionally not part of this dry-run DTO. */
export interface LegacyNumberRow {
  readonly legacyRowId: string;
  readonly legacyDatabaseId: string;
  readonly legacyCompanyId: string;
  readonly legacyWabaRowId: string;
  readonly externalId: string;
}

export interface LegacyInventorySnapshot {
  /** Internal catalog alias resolved by an operator-controlled allowlist. Never a DSN or schema name. */
  readonly catalogRef: string;
  readonly environment: LegacyEnvironment;
  /** Stable authorized snapshot/watermark identifier, not a database name. */
  readonly sourceVersion: string;
  readonly tenantMappings: readonly LegacyTenantMapping[];
  readonly appBindings: readonly LegacyAppBinding[];
  readonly pages: readonly LegacyPageRow[];
  readonly numbers: readonly LegacyNumberRow[];
}

export interface LegacyImportReferenceHasher {
  /** HMAC-SHA-256 from an operator supplied key held outside the repo/database. */
  digest(value: string): string;
}

export interface LegacyImportContext {
  readonly allowedCatalogRefs: ReadonlySet<string>;
  readonly projectionVersion?: string;
  readonly hasher: LegacyImportReferenceHasher;
}

export type LegacyAssetKind = 'FACEBOOK_PAGE' | 'WHATSAPP_BUSINESS_ACCOUNT' | 'WHATSAPP_PHONE_NUMBER';
export type LegacyExpiryObservation = 'OBSERVED_DATE' | 'UNKNOWN' | 'INVALID';
export type LegacyCredentialDisposition = 'ABSENT' | 'REQUIRES_REAUTH';
export type LegacyImportItemState = 'METADATA_ONLY_CANDIDATE' | 'QUARANTINED';

/** Internal apply DTO. Do not serialize, log, or attach this object to diagnostics. */
export interface LegacyImportPlanItem {
  readonly sequence: number;
  readonly sourceRecordHash: string;
  /** HMAC of the allowlisted row payload, separate from its stable source identity hash. */
  readonly sourcePayloadHash: string;
  readonly sourceTable: 'MetaConnectedPages' | 'MetaConnectedNumbers';
  readonly legacyRowId: string;
  readonly legacyDatabaseId: string;
  readonly legacyCompanyId: string;
  readonly tenantId: string | null;
  readonly appConfigurationId: string | null;
  readonly environment: LegacyEnvironment;
  readonly assetKind: LegacyAssetKind | null;
  readonly externalId: string | null;
  readonly deterministicAssetId: string | null;
  readonly state: LegacyImportItemState;
  readonly reasonCode: LegacyImportReasonCode | null;
  readonly credentialDisposition: LegacyCredentialDisposition;
  readonly expiryObservation: LegacyExpiryObservation;
  readonly batchId: string;
}

export interface LegacyImportReportItem {
  readonly sequence: number;
  readonly sourceRecordHash: string;
  readonly state: LegacyImportItemState;
  readonly reasonCode: LegacyImportReasonCode | null;
  readonly tenantRef: string | null;
  readonly targetAssetRef: string | null;
  readonly credentialDisposition: LegacyCredentialDisposition;
  readonly expiryObservation: LegacyExpiryObservation;
}

export interface LegacyImportReport {
  readonly mode: 'DRY_RUN';
  readonly batchId: string;
  readonly sourceSnapshotHash: string;
  readonly sourceVersion: string;
  readonly projectionVersion: string;
  readonly totalRows: number;
  readonly candidateCount: number;
  readonly quarantinedCount: number;
  readonly credentialReauthCount: number;
  readonly generalSettingsDisposition: 'NOT_READ_SCHEMA_NOT_CONFIRMED';
  readonly items: readonly LegacyImportReportItem[];
}

export interface LegacyImportPlan {
  readonly batchId: string;
  readonly sourceVersion: string;
  readonly projectionVersion: string;
  /** Ordered sanitized item hashes are the only values suitable for a persisted checkpoint cursor. */
  readonly checkpointSequence: number;
  readonly items: readonly LegacyImportPlanItem[];
  readonly report: LegacyImportReport;
}

export interface LegacyImportBatchCheckpoint {
  readonly batchId: string;
  readonly sourceSnapshotHash: string;
  readonly sourceVersion: string;
  readonly projectionVersion: string;
  readonly lastCompletedSequence: number;
  readonly state: 'PLANNED' | 'APPLYING' | 'PAUSED' | 'COMPLETED' | 'FAILED';
}

export interface LegacyCredentialVersionFence {
  readonly expectedCredentialVersion: number;
  readonly expectedSecretVersion: number;
  readonly expectedReauthorizationGeneration: number;
}

export interface CurrentLegacyCredentialVersion {
  readonly credentialVersion: number;
  readonly secretVersion: number;
  readonly reauthorizationGeneration: number;
}
