export interface CredentialBinding {
  readonly tenantId: string;
  readonly credentialId: string;
  readonly authorizationId: string;
  readonly appConfigurationId: string;
  readonly provider: 'META';
  readonly environment: string;
  readonly family: string;
}

export interface CredentialVaultActor {
  /** Opaque server-side principal reference; never a credential or user-supplied name. */
  readonly actorRef: string;
  readonly correlationId: string;
}

export type CredentialVaultAction = 'STORE' | 'USE' | 'ROTATE';

export interface CredentialVaultAuthorizationRequest {
  readonly action: CredentialVaultAction;
  readonly actorRef: string;
  readonly operation: string;
  readonly binding?: CredentialBinding;
  readonly targetKeyVersion?: string;
}

export interface CredentialVaultAuthorizationPort {
  authorize(request: CredentialVaultAuthorizationRequest): Promise<void>;
}

export interface CredentialKeyProvider {
  activeVersion(): string | undefined;
  keyFor(version: string): Buffer | undefined;
}

export interface EncryptedCredential {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly authenticationTag: Buffer;
  readonly keyVersion: string;
  readonly formatVersion: 1;
}

export interface StoredCredential extends CredentialBinding {
  readonly envelope: EncryptedCredential;
  readonly version: number;
}

export interface CredentialVaultAuditEntry extends CredentialVaultActor {
  readonly tenantId: string;
  readonly credentialId: string;
  readonly operation: string;
  readonly action: 'STORE' | 'DECRYPT' | 'ROTATE';
  readonly keyVersion: string;
}

export interface CredentialVaultRotationState {
  readonly targetKeyVersion: string;
  readonly state: 'RUNNING' | 'PAUSED' | 'COMPLETED';
  readonly cursorCredentialId: string | null;
  readonly lastSafeErrorCode: string | null;
}

export interface CredentialRotationLease {
  readonly targetKeyVersion: string;
  readonly owner: string;
  readonly token: string;
}

export interface CredentialRotationBatchResult {
  readonly processed: number;
  readonly done: boolean;
}

export interface CredentialVaultRepository {
  store(binding: CredentialBinding, envelope: EncryptedCredential, audit: CredentialVaultAuditEntry): Promise<void>;
  findActive(binding: CredentialBinding): Promise<StoredCredential | undefined>;
  audit(entry: CredentialVaultAuditEntry): Promise<void>;
  ensureRotation(targetKeyVersion: string): Promise<CredentialVaultRotationState>;
  acquireRotationLease(targetKeyVersion: string, owner: string, token: string, leaseSeconds: number): Promise<CredentialRotationLease | undefined>;
  rotateBatch(
    lease: CredentialRotationLease,
    batchSize: number,
    transform: (record: StoredCredential) => EncryptedCredential,
    auditFor: (record: StoredCredential, newKeyVersion: string) => CredentialVaultAuditEntry,
  ): Promise<CredentialRotationBatchResult>;
  pauseRotation(lease: CredentialRotationLease, safeErrorCode: string): Promise<void>;
  getRotationState(targetKeyVersion: string): Promise<CredentialVaultRotationState>;
  resumeRotation(targetKeyVersion: string): Promise<CredentialVaultRotationState>;
}

export const CREDENTIAL_VAULT_REPOSITORY = Symbol('CREDENTIAL_VAULT_REPOSITORY');
export const CREDENTIAL_KEY_PROVIDER = Symbol('CREDENTIAL_KEY_PROVIDER');
export const CREDENTIAL_VAULT_AUTHORIZATION = Symbol('CREDENTIAL_VAULT_AUTHORIZATION');
