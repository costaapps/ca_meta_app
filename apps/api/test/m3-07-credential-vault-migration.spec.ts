import assert from 'node:assert/strict';
import { test } from 'node:test';
import { META_CREDENTIAL_VAULT_MIGRATION, META_CREDENTIAL_VAULT_TABLES } from '../src/database/migrations/credential-vault.js';

test('M3.07 migration is additive and binds encrypted material to tenant authorization and app context', () => {
  assert.equal(META_CREDENTIAL_VAULT_MIGRATION.schemaVersion, 11);
  assert.equal(META_CREDENTIAL_VAULT_MIGRATION.id, '202610300010-credential-vault');
  assert.match(META_CREDENTIAL_VAULT_MIGRATION.checksum, /^[a-f0-9]{64}$/);
  assert.deepEqual(META_CREDENTIAL_VAULT_MIGRATION.steps.map((step) => step.id), [
    'create-credential-vault-key-state', 'create-credential-vault-key-version-history', 'create-credential-secret-envelope',
    'create-credential-key-rotations', 'create-credential-access-audit',
  ]);
  const keyState = META_CREDENTIAL_VAULT_MIGRATION.steps[0];
  assert.ok(keyState && 'sql' in keyState);
  assert.ok(keyState.sql.includes('active_key_version VARCHAR(64)'));
  assert.ok(keyState.sql.includes('CHECK (singleton_id = 1)'));
  const keyVersionHistory = META_CREDENTIAL_VAULT_MIGRATION.steps[1];
  assert.ok(keyVersionHistory && 'sql' in keyVersionHistory);
  assert.ok(keyVersionHistory.sql.includes('PRIMARY KEY (key_version)'));
  assert.ok(keyVersionHistory.sql.includes("status IN ('ACTIVE', 'RETIRED')"));
  const secrets = META_CREDENTIAL_VAULT_MIGRATION.steps[2];
  assert.ok(secrets && 'sql' in secrets);
  assert.ok(secrets.sql.includes('ciphertext VARBINARY(16384) NOT NULL'));
  assert.ok(secrets.sql.includes('nonce BINARY(12) NOT NULL'));
  assert.ok(secrets.sql.includes('authentication_tag BINARY(16) NOT NULL'));
  assert.ok(secrets.sql.includes('FOREIGN KEY (tenant_id, credential_id, authorization_id, app_configuration_id, provider, environment)'));
  assert.ok(secrets.sql.includes('REFERENCES ca_meta_credentials (tenant_id, id, authorization_id, app_configuration_id, provider, environment)'));
  assert.ok(secrets.sql.includes('KEY ix_ca_meta_secret_credential_context (tenant_id, credential_id, authorization_id, app_configuration_id, provider, environment)'));
  const audit = META_CREDENTIAL_VAULT_MIGRATION.steps[4];
  assert.ok(audit && 'sql' in audit);
  assert.ok(!/ciphertext|nonce|token_value|secret_value/i.test(audit.sql));
  assert.deepEqual(META_CREDENTIAL_VAULT_TABLES, [
    'ca_meta_credential_vault_key_state', 'ca_meta_credential_vault_key_versions', 'ca_meta_credential_secrets',
    'ca_meta_credential_rotations', 'ca_meta_credential_access_audit',
  ]);
});
