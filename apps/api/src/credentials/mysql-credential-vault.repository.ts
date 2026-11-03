import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { AuditEventWriter } from '../privacy/audit.service.js';
import type { CredentialBinding, CredentialRotationBatchResult, CredentialRotationLease,
  CredentialVaultConditionalWriteFence,
  CredentialVaultAuditEntry, CredentialVaultRepository, CredentialVaultRotationState, EncryptedCredential,
  StoredCredential } from './credential-vault.types.js';

interface SecretRow {
  tenant_id: string;
  credential_id: string;
  authorization_id: string;
  app_configuration_id: string;
  provider: string;
  environment: string;
  family: string;
  ciphertext: Buffer;
  nonce: Buffer;
  authentication_tag: Buffer;
  key_version: string;
  format_version: number | string;
  version: number | string;
}

interface RotationRow {
  target_key_version: string;
  state: 'RUNNING' | 'PAUSED' | 'COMPLETED';
  cursor_credential_id: string | null;
  last_safe_error_code: string | null;
}

const SAFE_ROTATION_ERRORS = new Set(['KEY_UNAVAILABLE', 'CIPHERTEXT_INVALID', 'ROTATION_FAILED']);

export class MysqlCredentialVaultRepository implements CredentialVaultRepository {
  constructor(private readonly database: DurableWorkDatabase, private readonly privacyAudit: AuditEventWriter) {}

  async store(binding: CredentialBinding, envelope: EncryptedCredential, audit: CredentialVaultAuditEntry): Promise<void> {
    const dataSource = await this.database.getDataSource();
    await dataSource.transaction(async (manager) => {
      await this.lockActiveKeyVersion(manager, envelope.keyVersion);
      const credentials = await manager.query(
        `SELECT status FROM ca_meta_credentials
         WHERE tenant_id = ? AND id = ? AND authorization_id = ? AND app_configuration_id = ?
           AND provider = ? AND environment = ? AND family = ? FOR UPDATE`,
        [binding.tenantId, binding.credentialId, binding.authorizationId, binding.appConfigurationId, binding.provider, binding.environment, binding.family],
      ) as Array<{ status: string }>;
      if (credentials[0]?.status !== 'ACTIVE') throw new Error('credential-not-active');
      await manager.query(
        `INSERT INTO ca_meta_credential_secrets
         (tenant_id, credential_id, authorization_id, app_configuration_id, provider, environment,
          ciphertext, nonce, authentication_tag, key_version, format_version, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
         ON DUPLICATE KEY UPDATE ciphertext = VALUES(ciphertext), nonce = VALUES(nonce),
          authentication_tag = VALUES(authentication_tag), key_version = VALUES(key_version),
          format_version = VALUES(format_version), version = version + 1, updated_at = UTC_TIMESTAMP(6)`,
        [binding.tenantId, binding.credentialId, binding.authorizationId, binding.appConfigurationId, binding.provider,
          binding.environment, envelope.ciphertext, envelope.nonce, envelope.authenticationTag, envelope.keyVersion, envelope.formatVersion],
      );
      await this.insertAudit(manager, audit);
    });
  }

  async storeIfCurrentWithin(manager: EntityManager, binding: CredentialBinding, envelope: EncryptedCredential,
    audit: CredentialVaultAuditEntry, fence: CredentialVaultConditionalWriteFence): Promise<boolean> {
    await this.lockActiveKeyVersion(manager, envelope.keyVersion);
    const rows = await manager.query(
      `SELECT auth.authorization_state, auth.version AS authorization_version,
              c.status AS credential_status, c.version AS credential_version, s.version AS secret_version
       FROM ca_meta_authorizations auth JOIN ca_meta_credentials c ON c.tenant_id = auth.tenant_id
         AND c.authorization_id = auth.id AND c.app_configuration_id = auth.app_configuration_id
         AND c.provider = auth.provider AND c.environment = auth.environment
       JOIN ca_meta_credential_secrets s ON s.tenant_id = c.tenant_id AND s.credential_id = c.id
         AND s.authorization_id = c.authorization_id AND s.app_configuration_id = c.app_configuration_id
         AND s.provider = c.provider AND s.environment = c.environment
       WHERE c.tenant_id = ? AND c.id = ? AND c.authorization_id = ? AND c.app_configuration_id = ?
         AND c.provider = ? AND c.environment = ? AND c.family = ? FOR UPDATE`,
      [binding.tenantId, binding.credentialId, binding.authorizationId, binding.appConfigurationId,
        binding.provider, binding.environment, binding.family],
    ) as Array<{ authorization_state: string; authorization_version: number | string; credential_status: string;
      credential_version: number | string; secret_version: number | string }>;
    const current = rows[0];
    if (!current || !['ACTIVE', 'PARTIAL'].includes(current.authorization_state) || current.credential_status !== 'ACTIVE' ||
        Number(current.authorization_version) !== fence.expectedAuthorizationVersion ||
        Number(current.credential_version) !== fence.expectedCredentialVersion ||
        Number(current.secret_version) !== fence.expectedSecretVersion) return false;
    const updated = await manager.query(
      `UPDATE ca_meta_credential_secrets
       SET ciphertext = ?, nonce = ?, authentication_tag = ?, key_version = ?, format_version = ?,
           version = version + 1, updated_at = UTC_TIMESTAMP(6)
       WHERE tenant_id = ? AND credential_id = ? AND authorization_id = ? AND app_configuration_id = ?
         AND provider = ? AND environment = ? AND version = ?`,
      [envelope.ciphertext, envelope.nonce, envelope.authenticationTag, envelope.keyVersion, envelope.formatVersion,
        binding.tenantId, binding.credentialId, binding.authorizationId, binding.appConfigurationId,
        binding.provider, binding.environment, fence.expectedSecretVersion],
    ) as { affectedRows?: number };
    if (Number(updated?.affectedRows ?? 0) !== 1) return false;
    await this.insertAudit(manager, audit);
    return true;
  }

  async findActive(binding: CredentialBinding): Promise<StoredCredential | undefined> {
    const dataSource = await this.database.getDataSource();
    const rows = await dataSource.query(
      `SELECT s.tenant_id, s.credential_id, s.authorization_id, s.app_configuration_id, s.provider, s.environment, c.family,
              s.ciphertext, s.nonce, s.authentication_tag, s.key_version, s.format_version, s.version
       FROM ca_meta_credential_secrets s
       JOIN ca_meta_credentials c ON c.tenant_id = s.tenant_id AND c.id = s.credential_id
        AND c.authorization_id = s.authorization_id AND c.app_configuration_id = s.app_configuration_id
        AND c.provider = s.provider AND c.environment = s.environment
       WHERE s.tenant_id = ? AND s.credential_id = ? AND s.authorization_id = ? AND s.app_configuration_id = ?
         AND s.provider = ? AND s.environment = ? AND c.family = ? AND c.status = 'ACTIVE'`,
      [binding.tenantId, binding.credentialId, binding.authorizationId, binding.appConfigurationId, binding.provider, binding.environment, binding.family],
    ) as SecretRow[];
    return rows[0] ? this.toStored(rows[0]) : undefined;
  }

  async audit(entry: CredentialVaultAuditEntry): Promise<void> {
    const dataSource = await this.database.getDataSource();
    await this.insertAudit(dataSource, entry);
  }

  async ensureRotation(targetKeyVersion: string): Promise<CredentialVaultRotationState> {
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT IGNORE INTO ca_meta_credential_vault_key_state (singleton_id, active_key_version, updated_at)
         VALUES (1, ?, UTC_TIMESTAMP(6))`,
        [targetKeyVersion],
      );
      const keyState = await manager.query(
        'SELECT active_key_version FROM ca_meta_credential_vault_key_state WHERE singleton_id = 1 FOR UPDATE',
      ) as Array<{ active_key_version: string }>;
      const currentKeyVersion = keyState[0]?.active_key_version;
      if (!currentKeyVersion) throw new Error('credential-key-state-unavailable');
      if (currentKeyVersion === targetKeyVersion) {
        await this.ensureActiveKeyVersionHistory(manager, targetKeyVersion);
      } else {
        await this.transitionActiveKeyVersion(manager, currentKeyVersion, targetKeyVersion);
      }
      await manager.query(
        `INSERT IGNORE INTO ca_meta_credential_rotations
         (id, target_key_version, state, created_at, updated_at)
         VALUES (?, ?, 'RUNNING', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
        [randomUUID(), targetKeyVersion],
      );
      return this.rotationState(manager, targetKeyVersion);
    });
  }

  async acquireRotationLease(targetKeyVersion: string, owner: string, token: string, leaseSeconds: number): Promise<CredentialRotationLease | undefined> {
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => {
      const keyState = await manager.query(
        'SELECT active_key_version FROM ca_meta_credential_vault_key_state WHERE singleton_id = 1 LOCK IN SHARE MODE',
      ) as Array<{ active_key_version: string }>;
      if (keyState[0]?.active_key_version !== targetKeyVersion) throw new Error('stale-rotation-key-version');
      const result = await manager.query(
        `UPDATE ca_meta_credential_rotations
         SET lease_owner = ?, lease_token = ?, lease_expires_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND), updated_at = UTC_TIMESTAMP(6)
         WHERE target_key_version = ? AND state = 'RUNNING'
           AND (lease_expires_at IS NULL OR lease_expires_at <= UTC_TIMESTAMP(6))`,
        [owner, token, leaseSeconds, targetKeyVersion],
      ) as { affectedRows?: number };
      if (!result || Number(result.affectedRows ?? 0) !== 1) return undefined;
      return Object.freeze({ targetKeyVersion, owner, token });
    });
  }

  async rotateBatch(
    lease: CredentialRotationLease,
    batchSize: number,
    transform: (record: StoredCredential) => EncryptedCredential,
    auditFor: (record: StoredCredential, newKeyVersion: string) => CredentialVaultAuditEntry,
  ): Promise<CredentialRotationBatchResult> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error('invalid-rotation-batch-size');
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => {
      const keyState = await manager.query(
        'SELECT active_key_version FROM ca_meta_credential_vault_key_state WHERE singleton_id = 1 LOCK IN SHARE MODE',
      ) as Array<{ active_key_version: string }>;
      if (keyState[0]?.active_key_version !== lease.targetKeyVersion) throw new Error('stale-rotation-key-version');
      const leased = await manager.query(
        `SELECT target_key_version FROM ca_meta_credential_rotations
         WHERE target_key_version = ? AND state = 'RUNNING' AND lease_owner = ? AND lease_token = ?
           AND lease_expires_at > UTC_TIMESTAMP(6) FOR UPDATE`,
        [lease.targetKeyVersion, lease.owner, lease.token],
      ) as Array<{ target_key_version: string }>;
      if (!leased[0]) throw new Error('rotation-lease-lost');
      const stateRows = await manager.query(
        'SELECT cursor_credential_id FROM ca_meta_credential_rotations WHERE target_key_version = ?',
        [lease.targetKeyVersion],
      ) as Array<{ cursor_credential_id: string | null }>;
      const cursor = stateRows[0]?.cursor_credential_id ?? null;
      const rows = await manager.query(
        `SELECT s.tenant_id, s.credential_id, s.authorization_id, s.app_configuration_id, s.provider, s.environment, c.family,
                s.ciphertext, s.nonce, s.authentication_tag, s.key_version, s.format_version, s.version
         FROM ca_meta_credential_secrets s
         JOIN ca_meta_credentials c ON c.tenant_id = s.tenant_id AND c.id = s.credential_id
          AND c.authorization_id = s.authorization_id AND c.app_configuration_id = s.app_configuration_id
          AND c.provider = s.provider AND c.environment = s.environment
         WHERE s.key_version <> ? AND (? IS NULL OR s.credential_id > ?)
         ORDER BY s.credential_id LIMIT ${batchSize} FOR UPDATE`,
        [lease.targetKeyVersion, cursor, cursor],
      ) as SecretRow[];

      let lastCredentialId: string | null = null;
      for (const row of rows) {
        const record = this.toStored(row);
        const next = transform(record);
        const updated = await manager.query(
          `UPDATE ca_meta_credential_secrets
           SET ciphertext = ?, nonce = ?, authentication_tag = ?, key_version = ?, format_version = ?,
               version = version + 1, updated_at = UTC_TIMESTAMP(6)
           WHERE tenant_id = ? AND credential_id = ? AND version = ? AND key_version = ?`,
          [next.ciphertext, next.nonce, next.authenticationTag, next.keyVersion, next.formatVersion,
            record.tenantId, record.credentialId, record.version, record.envelope.keyVersion],
        ) as { affectedRows?: number };
        if (Number(updated?.affectedRows ?? 0) !== 1) throw new Error('credential-version-conflict');
        await this.insertAudit(manager, auditFor(record, next.keyVersion));
        lastCredentialId = record.credentialId;
      }

      const checkpoint = lastCredentialId ?? cursor;
      const remaining = rows.length === 0 ? [] : await manager.query(
        `SELECT credential_id FROM ca_meta_credential_secrets
         WHERE key_version <> ? AND credential_id > ? ORDER BY credential_id LIMIT 1`,
        [lease.targetKeyVersion, checkpoint],
      ) as Array<{ credential_id: string }>;
      const done = rows.length === 0 || remaining.length === 0;
      const updatedRotation = await manager.query(
        `UPDATE ca_meta_credential_rotations
         SET cursor_credential_id = ?, state = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
             last_safe_error_code = NULL, completed_at = IF(? = 'COMPLETED', UTC_TIMESTAMP(6), NULL), updated_at = UTC_TIMESTAMP(6)
         WHERE target_key_version = ? AND lease_owner = ? AND lease_token = ? AND lease_expires_at > UTC_TIMESTAMP(6)`,
        [checkpoint, done ? 'COMPLETED' : 'RUNNING', done ? 'COMPLETED' : 'RUNNING', lease.targetKeyVersion, lease.owner, lease.token],
      ) as { affectedRows?: number };
      if (Number(updatedRotation?.affectedRows ?? 0) !== 1) throw new Error('rotation-lease-expired');
      return Object.freeze({ processed: rows.length, done });
    });
  }

  async pauseRotation(lease: CredentialRotationLease, safeErrorCode: string): Promise<void> {
    const dataSource = await this.database.getDataSource();
    await dataSource.query(
      `UPDATE ca_meta_credential_rotations
       SET state = 'PAUSED', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           last_safe_error_code = ?, updated_at = UTC_TIMESTAMP(6)
       WHERE target_key_version = ? AND lease_owner = ? AND lease_token = ? AND state = 'RUNNING'`,
      [SAFE_ROTATION_ERRORS.has(safeErrorCode) ? safeErrorCode : 'ROTATION_FAILED', lease.targetKeyVersion, lease.owner, lease.token],
    );
  }

  async getRotationState(targetKeyVersion: string): Promise<CredentialVaultRotationState> {
    const dataSource = await this.database.getDataSource();
    return this.rotationState(dataSource, targetKeyVersion);
  }

  async resumeRotation(targetKeyVersion: string): Promise<CredentialVaultRotationState> {
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => {
      const keyState = await manager.query(
        'SELECT active_key_version FROM ca_meta_credential_vault_key_state WHERE singleton_id = 1 LOCK IN SHARE MODE',
      ) as Array<{ active_key_version: string }>;
      if (keyState[0]?.active_key_version !== targetKeyVersion) throw new Error('stale-rotation-key-version');
      await manager.query(
        `UPDATE ca_meta_credential_rotations SET state = 'RUNNING', last_safe_error_code = NULL, updated_at = UTC_TIMESTAMP(6)
         WHERE target_key_version = ? AND state = 'PAUSED'`,
        [targetKeyVersion],
      );
      return this.rotationState(manager, targetKeyVersion);
    });
  }

  private async rotationState(dataSource: Pick<DataSource, 'query'>, targetKeyVersion: string): Promise<CredentialVaultRotationState> {
    const rows = await dataSource.query(
      `SELECT target_key_version, state, cursor_credential_id, last_safe_error_code
       FROM ca_meta_credential_rotations WHERE target_key_version = ?`,
      [targetKeyVersion],
    ) as RotationRow[];
    const row = rows[0];
    if (!row) throw new Error('rotation-not-found');
    return Object.freeze({
      targetKeyVersion: row.target_key_version,
      state: row.state,
      cursorCredentialId: row.cursor_credential_id,
      lastSafeErrorCode: row.last_safe_error_code,
    });
  }

  private async lockActiveKeyVersion(manager: EntityManager, keyVersion: string): Promise<void> {
    await manager.query(
      `INSERT IGNORE INTO ca_meta_credential_vault_key_state (singleton_id, active_key_version, updated_at)
       VALUES (1, ?, UTC_TIMESTAMP(6))`,
      [keyVersion],
    );
    const rows = await manager.query(
      'SELECT active_key_version FROM ca_meta_credential_vault_key_state WHERE singleton_id = 1 LOCK IN SHARE MODE',
    ) as Array<{ active_key_version: string }>;
    if (rows[0]?.active_key_version !== keyVersion) throw new Error('credential-key-version-not-active');
    await this.ensureActiveKeyVersionHistory(manager, keyVersion);
  }

  private async ensureActiveKeyVersionHistory(manager: EntityManager, activeKeyVersion: string): Promise<void> {
    const activeRows = await manager.query(
      'SELECT status FROM ca_meta_credential_vault_key_versions WHERE key_version = ?',
      [activeKeyVersion],
    ) as Array<{ status: string }>;
    if (activeRows[0]?.status === 'RETIRED') throw new Error('credential-key-version-retired');
    if (activeRows.length === 0) {
      const existingVersions = await manager.query(
        'SELECT DISTINCT key_version FROM ca_meta_credential_secrets ORDER BY key_version',
      ) as Array<{ key_version: string }>;
      for (const row of existingVersions) {
        const status = row.key_version === activeKeyVersion ? 'ACTIVE' : 'RETIRED';
        await this.insertKeyVersionHistory(manager, row.key_version, status);
      }
      await this.insertKeyVersionHistory(manager, activeKeyVersion, 'ACTIVE');
    }
    const currentRows = await manager.query(
      'SELECT status FROM ca_meta_credential_vault_key_versions WHERE key_version = ?',
      [activeKeyVersion],
    ) as Array<{ status: string }>;
    if (currentRows[0]?.status !== 'ACTIVE') throw new Error('credential-key-version-history-invalid');
  }

  private async transitionActiveKeyVersion(manager: EntityManager, currentKeyVersion: string, targetKeyVersion: string): Promise<void> {
    await this.ensureActiveKeyVersionHistory(manager, currentKeyVersion);
    const targetRows = await manager.query(
      'SELECT status FROM ca_meta_credential_vault_key_versions WHERE key_version = ? FOR UPDATE',
      [targetKeyVersion],
    ) as Array<{ status: string }>;
    if (targetRows.length !== 0) throw new Error('credential-key-version-reuse-denied');
    const currentRows = await manager.query(
      'SELECT status FROM ca_meta_credential_vault_key_versions WHERE key_version = ? FOR UPDATE',
      [currentKeyVersion],
    ) as Array<{ status: string }>;
    if (currentRows[0]?.status !== 'ACTIVE') throw new Error('credential-key-version-history-invalid');
    await manager.query(
      `UPDATE ca_meta_credential_vault_key_versions SET status = 'RETIRED', retired_at = UTC_TIMESTAMP(6)
       WHERE key_version = ? AND status = 'ACTIVE'`,
      [currentKeyVersion],
    );
    await this.insertKeyVersionHistory(manager, targetKeyVersion, 'ACTIVE');
    const updated = await manager.query(
      `UPDATE ca_meta_credential_vault_key_state SET active_key_version = ?, updated_at = UTC_TIMESTAMP(6)
       WHERE singleton_id = 1 AND active_key_version = ?`,
      [targetKeyVersion, currentKeyVersion],
    ) as { affectedRows?: number };
    if (Number(updated?.affectedRows ?? 0) !== 1) throw new Error('credential-key-state-conflict');
    await manager.query(
      `UPDATE ca_meta_credential_rotations
       SET state = 'PAUSED', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           last_safe_error_code = 'ROTATION_FAILED', updated_at = UTC_TIMESTAMP(6)
       WHERE target_key_version = ? AND state = 'RUNNING'`,
      [currentKeyVersion],
    );
  }

  private async insertKeyVersionHistory(manager: EntityManager, keyVersion: string, status: 'ACTIVE' | 'RETIRED'): Promise<void> {
    await manager.query(
      `INSERT IGNORE INTO ca_meta_credential_vault_key_versions (key_version, status, created_at, retired_at)
       VALUES (?, ?, UTC_TIMESTAMP(6), IF(? = 'RETIRED', UTC_TIMESTAMP(6), NULL))`,
      [keyVersion, status, status],
    );
  }

  private async insertAudit(executor: DataSource | EntityManager, entry: CredentialVaultAuditEntry): Promise<void> {
    await executor.query(
      `INSERT INTO ca_meta_credential_access_audit
       (id, tenant_id, credential_id, actor_ref, action, operation, key_version, correlation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
      [randomUUID(), entry.tenantId, entry.credentialId, entry.actorRef, entry.action,
        entry.operation, entry.keyVersion, entry.correlationId],
    );
    await this.privacyAudit.record({
      tenantId: entry.tenantId,
      actorRef: entry.actorRef,
      action: 'ASSET_OPERATION',
      targetRef: entry.credentialId,
      correlationId: entry.correlationId,
      retentionClass: 'SECURITY',
      safeDiff: { reasonCode: entry.operation, version: entry.keyVersion },
    }, executor);
  }

  private toStored(row: SecretRow): StoredCredential {
    return Object.freeze({
      tenantId: row.tenant_id,
      credentialId: row.credential_id,
      authorizationId: row.authorization_id,
      appConfigurationId: row.app_configuration_id,
      provider: 'META',
      environment: row.environment,
      family: row.family,
      envelope: Object.freeze({
        ciphertext: Buffer.from(row.ciphertext),
        nonce: Buffer.from(row.nonce),
        authenticationTag: Buffer.from(row.authentication_tag),
        keyVersion: row.key_version,
        formatVersion: Number(row.format_version) as 1,
      }),
      version: Number(row.version),
    });
  }
}
