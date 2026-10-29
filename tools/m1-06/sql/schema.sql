CREATE TABLE m106_tenant (
  id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  status VARCHAR(16) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE m106_principal (
  issuer VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  subject VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  PRIMARY KEY (issuer, subject)
) ENGINE=InnoDB;

CREATE TABLE m106_membership (
  tenant_id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  issuer VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  subject VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  role_name VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  email_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (tenant_id, issuer, subject),
  UNIQUE KEY uq_m106_membership_invite (tenant_id, email_hash),
  CONSTRAINT fk_m106_membership_tenant FOREIGN KEY (tenant_id) REFERENCES m106_tenant (id),
  CONSTRAINT fk_m106_membership_principal FOREIGN KEY (issuer, subject) REFERENCES m106_principal (issuer, subject)
) ENGINE=InnoDB;

CREATE TABLE m106_consumed_ticket (
  issuer VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  jti_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  consumed_at DATETIME(6) NOT NULL,
  PRIMARY KEY (issuer, jti_hash)
) ENGINE=InnoDB;

CREATE TABLE m106_preauth_challenge (
  challenge_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  preauth_cookie_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  consumed_at DATETIME(6) NULL,
  KEY ix_m106_preauth_cookie (preauth_cookie_hash)
) ENGINE=InnoDB;

CREATE TABLE m106_portal_session (
  session_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  issuer VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  subject VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tenant_id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  role_name VARCHAR(16) NOT NULL,
  context_ref_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  context_version BIGINT UNSIGNED NOT NULL,
  csrf_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  issued_at DATETIME(6) NOT NULL,
  idle_at DATETIME(6) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  revoked_at DATETIME(6) NULL,
  CONSTRAINT fk_m106_session_membership FOREIGN KEY (tenant_id, issuer, subject)
    REFERENCES m106_membership (tenant_id, issuer, subject),
  KEY ix_m106_session_tenant (tenant_id, subject)
) ENGINE=InnoDB;

CREATE TABLE m106_magic_link (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  purpose VARCHAR(24) NOT NULL,
  tenant_id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  issuer VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  subject VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  issued_at DATETIME(6) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  consumed_at DATETIME(6) NULL,
  CONSTRAINT fk_m106_link_membership FOREIGN KEY (tenant_id, issuer, subject)
    REFERENCES m106_membership (tenant_id, issuer, subject)
) ENGINE=InnoDB;

CREATE TABLE m106_onboarding (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  tenant_id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  issuer VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  subject VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(24) NOT NULL,
  context_version BIGINT UNSIGNED NOT NULL,
  started_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_m106_onboarding_membership FOREIGN KEY (tenant_id, issuer, subject)
    REFERENCES m106_membership (tenant_id, issuer, subject)
) ENGINE=InnoDB;

CREATE TABLE m106_asset (
  tenant_id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  label VARCHAR(64) NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT fk_m106_asset_tenant FOREIGN KEY (tenant_id) REFERENCES m106_tenant (id)
) ENGINE=InnoDB;

CREATE TABLE m106_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_ref VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation VARCHAR(32) NOT NULL,
  target_ref VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  outcome VARCHAR(16) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  KEY ix_m106_audit_tenant_time (tenant_id, created_at),
  CONSTRAINT fk_m106_audit_tenant FOREIGN KEY (tenant_id) REFERENCES m106_tenant (id)
) ENGINE=InnoDB;
