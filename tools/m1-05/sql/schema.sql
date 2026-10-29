CREATE TABLE m105_tenant (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  status VARCHAR(24) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1
) ENGINE=InnoDB;

CREATE TABLE m105_principal (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  kind VARCHAR(16) NOT NULL,
  issuer VARCHAR(255) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  status VARCHAR(24) NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  UNIQUE KEY uq_m105_principal_issuer_subject (issuer, subject)
) ENGINE=InnoDB;

CREATE TABLE m105_membership (
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  roles JSON NOT NULL,
  status VARCHAR(24) NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, principal_id),
  CONSTRAINT fk_m105_membership_tenant FOREIGN KEY (tenant_id) REFERENCES m105_tenant (id),
  CONSTRAINT fk_m105_membership_principal FOREIGN KEY (principal_id) REFERENCES m105_principal (id),
  CONSTRAINT ck_m105_membership_roles CHECK (JSON_VALID(roles))
) ENGINE=InnoDB;

CREATE TABLE m105_portal_session (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  secret_hash BINARY(32) NOT NULL,
  context_ref_hash BINARY(32) NOT NULL,
  context_version BIGINT UNSIGNED NOT NULL,
  issued_at DATETIME(6) NOT NULL,
  idle_at DATETIME(6) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  revoked_at DATETIME(6) NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  UNIQUE KEY uq_m105_session_secret (secret_hash),
  CONSTRAINT fk_m105_session_membership FOREIGN KEY (tenant_id, principal_id) REFERENCES m105_membership (tenant_id, principal_id)
) ENGINE=InnoDB;

CREATE TABLE m105_meta_app_config (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  provider VARCHAR(32) NOT NULL,
  provider_app_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  environment VARCHAR(32) NOT NULL,
  flow_variant VARCHAR(64) NOT NULL,
  auth_variant VARCHAR(64) NOT NULL,
  graph_version VARCHAR(64) NOT NULL,
  signup_version VARCHAR(64) NOT NULL,
  capabilities_version INT UNSIGNED NOT NULL,
  public_config JSON NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  UNIQUE KEY uq_m105_app_config (provider, provider_app_id, environment, flow_variant, auth_variant),
  UNIQUE KEY uq_m105_app_context_provider_environment (id, provider, environment),
  UNIQUE KEY uq_m105_app_context_environment (id, environment),
  UNIQUE KEY uq_m105_app_context_flow_auth (id, flow_variant, auth_variant),
  CONSTRAINT ck_m105_app_config_json CHECK (JSON_VALID(public_config))
) ENGINE=InnoDB;

CREATE TABLE m105_onboarding_session (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  app_config_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  flow_variant VARCHAR(64) NOT NULL,
  auth_variant VARCHAR(64) NOT NULL,
  state_hash BINARY(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  correlation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  readiness_policy_version INT UNSIGNED NOT NULL,
  readiness_reasons JSON NOT NULL,
  readiness_evaluated_at DATETIME(6) NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  UNIQUE KEY uq_m105_onboarding_state (state_hash),
  UNIQUE KEY uq_m105_onboarding_tenant_id (tenant_id, id),
  UNIQUE KEY uq_m105_onboarding_auth_context (tenant_id, id, app_config_id, flow_variant, auth_variant),
  CONSTRAINT fk_m105_onboarding_membership FOREIGN KEY (tenant_id, principal_id) REFERENCES m105_membership (tenant_id, principal_id),
  CONSTRAINT fk_m105_onboarding_app FOREIGN KEY (app_config_id, flow_variant, auth_variant) REFERENCES m105_meta_app_config (id, flow_variant, auth_variant),
  CONSTRAINT ck_m105_onboarding_readiness_reasons CHECK (JSON_VALID(readiness_reasons))
) ENGINE=InnoDB;

CREATE TABLE m105_onboarding_step (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  onboarding_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  step_name VARCHAR(48) NOT NULL,
  attempt INT UNSIGNED NOT NULL,
  status VARCHAR(24) NOT NULL,
  safe_error_code VARCHAR(64) NULL,
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  started_at DATETIME(6) NULL,
  finished_at DATETIME(6) NULL,
  evidence_ref VARCHAR(255) NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  UNIQUE KEY uq_m105_onboarding_step_attempt (tenant_id, onboarding_id, step_name, attempt),
  CONSTRAINT fk_m105_onboarding_step_session FOREIGN KEY (tenant_id, onboarding_id) REFERENCES m105_onboarding_session (tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE m105_meta_authorization (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  app_config_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  environment VARCHAR(32) NOT NULL,
  source_onboarding_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  flow_variant VARCHAR(64) NOT NULL,
  auth_variant VARCHAR(64) NOT NULL,
  provider_subject_ref VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  granted_scopes JSON NOT NULL,
  status VARCHAR(24) NOT NULL,
  issued_at DATETIME(6) NOT NULL,
  revoked_at DATETIME(6) NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  UNIQUE KEY uq_m105_authorization_tenant_id (tenant_id, id),
  UNIQUE KEY uq_m105_authorization_context (tenant_id, id, app_config_id, environment),
  CONSTRAINT fk_m105_authorization_onboarding FOREIGN KEY (tenant_id, source_onboarding_id, app_config_id, flow_variant, auth_variant) REFERENCES m105_onboarding_session (tenant_id, id, app_config_id, flow_variant, auth_variant),
  CONSTRAINT fk_m105_authorization_app_environment FOREIGN KEY (app_config_id, environment) REFERENCES m105_meta_app_config (id, environment),
  CONSTRAINT fk_m105_authorization_app_variant FOREIGN KEY (app_config_id, flow_variant, auth_variant) REFERENCES m105_meta_app_config (id, flow_variant, auth_variant),
  CONSTRAINT ck_m105_authorization_scopes CHECK (JSON_VALID(granted_scopes))
) ENGINE=InnoDB;

CREATE TABLE m105_meta_credential (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  authorization_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  family VARCHAR(64) NOT NULL,
  issuer VARCHAR(255) NOT NULL,
  app_config_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  environment VARCHAR(32) NOT NULL,
  ciphertext VARBINARY(512) NOT NULL,
  key_version VARCHAR(64) NOT NULL,
  scopes_snapshot JSON NOT NULL,
  authorization_version BIGINT UNSIGNED NOT NULL,
  expires_at DATETIME(6) NULL,
  data_access_expires_at DATETIME(6) NULL,
  health VARCHAR(24) NOT NULL,
  observed_source VARCHAR(64) NOT NULL,
  observed_at DATETIME(6) NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  CONSTRAINT fk_m105_credential_authorization_context FOREIGN KEY (tenant_id, authorization_id, app_config_id, environment) REFERENCES m105_meta_authorization (tenant_id, id, app_config_id, environment),
  CONSTRAINT fk_m105_credential_app_environment FOREIGN KEY (app_config_id, environment) REFERENCES m105_meta_app_config (id, environment),
  CONSTRAINT ck_m105_credential_scopes CHECK (JSON_VALID(scopes_snapshot))
) ENGINE=InnoDB;

CREATE TABLE m105_meta_asset (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  app_config_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider VARCHAR(32) NOT NULL,
  environment VARCHAR(32) NOT NULL,
  kind VARCHAR(64) NOT NULL,
  external_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  observed_status VARCHAR(24) NOT NULL,
  observed_source VARCHAR(64) NOT NULL,
  observed_at DATETIME(6) NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  UNIQUE KEY uq_m105_asset_identity (tenant_id, provider, app_config_id, environment, kind, external_id),
  UNIQUE KEY uq_m105_asset_tenant_id (tenant_id, id),
  UNIQUE KEY uq_m105_asset_app_context (tenant_id, id, app_config_id),
  UNIQUE KEY uq_m105_asset_context (tenant_id, id, app_config_id, environment),
  UNIQUE KEY uq_m105_asset_route_identity (provider, app_config_id, environment, kind, external_id, tenant_id, id),
  CONSTRAINT fk_m105_asset_app FOREIGN KEY (app_config_id, provider, environment) REFERENCES m105_meta_app_config (id, provider, environment)
) ENGINE=InnoDB;

CREATE TABLE m105_asset_route_claim (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  provider VARCHAR(32) NOT NULL,
  app_config_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  environment VARCHAR(32) NOT NULL,
  kind VARCHAR(64) NOT NULL,
  external_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  claimed_at DATETIME(6) NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  UNIQUE KEY uq_m105_route_identity (provider, app_config_id, environment, kind, external_id),
  UNIQUE KEY uq_m105_route_asset (tenant_id, asset_id),
  CONSTRAINT fk_m105_route_claim_asset_identity FOREIGN KEY (provider, app_config_id, environment, kind, external_id, tenant_id, asset_id) REFERENCES m105_meta_asset (provider, app_config_id, environment, kind, external_id, tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE m105_asset_relation (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  app_config_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  environment VARCHAR(32) NOT NULL,
  parent_asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  child_asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  relation_kind VARCHAR(48) NOT NULL,
  observed_source VARCHAR(64) NOT NULL,
  observed_at DATETIME(6) NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  UNIQUE KEY uq_m105_asset_relation (tenant_id, parent_asset_id, child_asset_id, relation_kind),
  CONSTRAINT fk_m105_relation_parent FOREIGN KEY (tenant_id, parent_asset_id, app_config_id, environment) REFERENCES m105_meta_asset (tenant_id, id, app_config_id, environment),
  CONSTRAINT fk_m105_relation_child FOREIGN KEY (tenant_id, child_asset_id, app_config_id, environment) REFERENCES m105_meta_asset (tenant_id, id, app_config_id, environment)
) ENGINE=InnoDB;

CREATE TABLE m105_asset_authorization (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  authorization_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  app_config_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  environment VARCHAR(32) NOT NULL,
  capabilities JSON NOT NULL,
  status VARCHAR(24) NOT NULL,
  verified_at DATETIME(6) NULL,
  revoked_at DATETIME(6) NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  UNIQUE KEY uq_m105_asset_authorization (tenant_id, authorization_id, asset_id),
  CONSTRAINT fk_m105_asset_auth_authorization FOREIGN KEY (tenant_id, authorization_id, app_config_id, environment) REFERENCES m105_meta_authorization (tenant_id, id, app_config_id, environment),
  CONSTRAINT fk_m105_asset_auth_asset FOREIGN KEY (tenant_id, asset_id, app_config_id, environment) REFERENCES m105_meta_asset (tenant_id, id, app_config_id, environment),
  CONSTRAINT ck_m105_asset_auth_capabilities CHECK (JSON_VALID(capabilities))
) ENGINE=InnoDB;

CREATE TABLE m105_webhook_subscription (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  app_config_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  environment VARCHAR(32) NOT NULL,
  target_asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  desired_fields JSON NOT NULL,
  state VARCHAR(24) NOT NULL,
  observed_status VARCHAR(24) NOT NULL,
  observed_source VARCHAR(64) NOT NULL,
  observed_at DATETIME(6) NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  CONSTRAINT fk_m105_subscription_asset_context FOREIGN KEY (tenant_id, target_asset_id, app_config_id, environment) REFERENCES m105_meta_asset (tenant_id, id, app_config_id, environment),
  CONSTRAINT fk_m105_subscription_app_environment FOREIGN KEY (app_config_id, environment) REFERENCES m105_meta_app_config (id, environment),
  CONSTRAINT ck_m105_subscription_fields CHECK (JSON_VALID(desired_fields))
) ENGINE=InnoDB;

CREATE TABLE m105_inbox_event (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  app_config_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider_event_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  schema_version INT UNSIGNED NOT NULL,
  received_at DATETIME(6) NOT NULL,
  signature_state VARCHAR(24) NOT NULL,
  raw_ref VARCHAR(255) NULL,
  route_state VARCHAR(24) NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  UNIQUE KEY uq_m105_inbox_provider_event (app_config_id, provider_event_id),
  UNIQUE KEY uq_m105_inbox_id_app_context (id, app_config_id),
  CONSTRAINT fk_m105_inbox_app FOREIGN KEY (app_config_id) REFERENCES m105_meta_app_config (id)
) ENGINE=InnoDB;

CREATE TABLE m105_routed_event (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  inbox_event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  app_config_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  item_key VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  route_state VARCHAR(24) NOT NULL,
  processing_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  UNIQUE KEY uq_m105_routed_item (inbox_event_id, item_key),
  CONSTRAINT fk_m105_routed_inbox FOREIGN KEY (inbox_event_id, app_config_id) REFERENCES m105_inbox_event (id, app_config_id),
  CONSTRAINT fk_m105_routed_asset FOREIGN KEY (tenant_id, asset_id, app_config_id) REFERENCES m105_meta_asset (tenant_id, id, app_config_id),
  CONSTRAINT ck_m105_routed_destination CHECK ((tenant_id IS NULL AND asset_id IS NULL AND route_state = 'QUARANTINED') OR (tenant_id IS NOT NULL AND asset_id IS NOT NULL AND route_state <> 'QUARANTINED'))
) ENGINE=InnoDB;

CREATE TABLE m105_outbox_event (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  aggregate_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  aggregate_asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  aggregate_version BIGINT UNSIGNED NOT NULL,
  schema_version INT UNSIGNED NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  payload JSON NOT NULL,
  created_at DATETIME(6) NOT NULL,
  delivery_state VARCHAR(24) NOT NULL,
  attempt INT UNSIGNED NOT NULL DEFAULT 0,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  UNIQUE KEY uq_m105_outbox_aggregate_version (tenant_id, aggregate_id, aggregate_version, event_type),
  UNIQUE KEY uq_m105_outbox_idempotency (tenant_id, event_type, idempotency_key),
  CONSTRAINT fk_m105_outbox_tenant FOREIGN KEY (tenant_id) REFERENCES m105_tenant (id),
  CONSTRAINT fk_m105_outbox_asset FOREIGN KEY (tenant_id, aggregate_asset_id) REFERENCES m105_meta_asset (tenant_id, id),
  CONSTRAINT ck_m105_outbox_payload CHECK (JSON_VALID(payload))
) ENGINE=InnoDB;

CREATE TABLE m105_sync_job (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  onboarding_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  job_type VARCHAR(64) NOT NULL,
  payload_version INT UNSIGNED NOT NULL,
  idempotency_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  attempt INT UNSIGNED NOT NULL DEFAULT 0,
  next_run_at DATETIME(6) NOT NULL,
  lease_owner VARCHAR(128) NULL,
  lease_expires_at DATETIME(6) NULL,
  status VARCHAR(24) NOT NULL,
  safe_error VARCHAR(64) NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  UNIQUE KEY uq_m105_job_idempotency (tenant_id, job_type, idempotency_key),
  CONSTRAINT fk_m105_job_tenant FOREIGN KEY (tenant_id) REFERENCES m105_tenant (id),
  CONSTRAINT fk_m105_job_onboarding FOREIGN KEY (tenant_id, onboarding_id) REFERENCES m105_onboarding_session (tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE m105_projection_checkpoint (
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  destination_ref VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  aggregate_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_version BIGINT UNSIGNED NOT NULL,
  projection_schema_version INT UNSIGNED NOT NULL,
  applied_at DATETIME(6) NOT NULL,
  tombstone_version BIGINT UNSIGNED NOT NULL DEFAULT 0,
  status VARCHAR(24) NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, destination_ref, aggregate_id),
  CONSTRAINT fk_m105_checkpoint_tenant FOREIGN KEY (tenant_id) REFERENCES m105_tenant (id)
) ENGINE=InnoDB;

CREATE TABLE m105_audit_event (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_ref VARCHAR(255) NOT NULL,
  action VARCHAR(64) NOT NULL,
  target_ref VARCHAR(255) NOT NULL,
  correlation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  safe_diff JSON NOT NULL,
  created_at DATETIME(6) NOT NULL,
  retention_class VARCHAR(32) NOT NULL,
  record_version INT UNSIGNED NOT NULL,
  CONSTRAINT fk_m105_audit_tenant FOREIGN KEY (tenant_id) REFERENCES m105_tenant (id),
  CONSTRAINT ck_m105_audit_diff CHECK (JSON_VALID(safe_diff))
) ENGINE=InnoDB;
