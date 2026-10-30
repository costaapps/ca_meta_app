import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection, type Connection } from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { readMigrationEnvironment } from '../src/database/migrations/migration-environment.js';
import { MIGRATION_STEP_LEDGER, deployMigrations, migrationLockName, readMigrationStatus } from '../src/database/migrations/migration-runner.js';
import { MIGRATIONS } from '../src/database/migrations/migrations.js';
import { IdentityAdministrationService } from '../src/identity/identity-administration.service.js';
import { IdentityAdministrationConflictError } from '../src/identity/mysql-identity-administration.repository.js';
import { MysqlIdentityAdministrationRepository } from '../src/identity/mysql-identity-administration.repository.js';
import { MysqlIdentityRepository } from '../src/identity/mysql-identity.repository.js';
import { TenantContextService, hashTenantContextReference } from '../src/identity/identity.service.js';
import { IdentityAssertionVerifier, PlatformIdentityAdminAuthority, PortalSessionVerifier } from '../src/identity/identity.trust.js';

class SyntheticAssertionVerifier extends IdentityAssertionVerifier {
  verify(subject: string) { return this.issueVerifiedAssertion('https://issuer.synthetic.invalid', subject); }
}

const enabled = process.env.M2_MIGRATION_TEST === '1';
const UUID_PREFIX = '00000000-0000-4000-8000-';
const uuid = (value: number): string => UUID_PREFIX + value.toString().padStart(12, '0');
const tenantIsolationFixture = JSON.parse(readFileSync(
  join(__dirname, '../../../../tools/m2-08/fixtures/tenant-isolation-negative.json'), 'utf8',
)) as {
  tenantA: 'primary';
  tenantB: 'other';
  appConfigurationTenant: 'primary' | 'other';
  assetTenant: 'primary' | 'other';
  expectedMariaDbError: string;
};

async function queryRows<T>(connection: Connection, sql: string, values: unknown[] = []): Promise<T[]> {
  const [result] = await connection.query(sql, values as never[]);
  return result as unknown as T[];
}

test('MariaDB migration ledger, implicit-commit recovery, backfill, role separation, tenant IDs and UTC precision', {
  skip: enabled ? false : 'Run through tools/m2-03/run-mariadb-tests.ps1 with its UUID-scoped MariaDB project.',
}, async () => {
  const environment = readMigrationEnvironment(process.env);
  const connectionOptions = {
    host: environment.database.host,
    port: environment.database.port,
    database: environment.database.name,
    user: process.env.API_DATABASE_USER,
    password: process.env.M2_API_DATABASE_PASSWORD,
    connectTimeout: environment.database.connectTimeoutMs,
    multipleStatements: false,
    dateStrings: true,
    charset: 'utf8mb4',
  };

  const crashAt = async (migrationId: string, variable: string, stepId: string, expectedCode: number): Promise<void> => {
    const child = fork(join(__dirname, 'fixtures', 'migration-crash-child.js'), [migrationId], {
      execPath: process.execPath,
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, [variable]: stepId },
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Migration crash fixture timed out at ${stepId}.`));
      }, 10_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    assert.equal(result.code, expectedCode, `child stopped at the requested crash point (${stepId}); stderr=${stderr}`);
    assert.equal(result.signal, null);
  };

  const admin = await createConnection(connectionOptions);
  try {
    await admin.query("SET time_zone = '+00:00'");
    await admin.query("SET SESSION sql_mode = CONCAT(@@session.sql_mode, ',STRICT_ALL_TABLES')");
    const before = await readMigrationStatus(environment);
    assert.deepEqual(before.migrations, []);

    const initial = MIGRATIONS[0];
    const additive = MIGRATIONS[1];
    assert.ok(initial && additive);
    await crashAt(initial.id, 'M2_CRASH_AFTER_DDL_STEP', 'create-tenants', 86);
    const partial = await readMigrationStatus(environment);
    assert.equal(partial.migrations[0]?.state, 'RUNNING');
    await Promise.all([deployMigrations(environment, [initial]), deployMigrations(environment, [initial])]);
    await deployMigrations(environment, [initial]);

    const tenantA = uuid(1);
    const tenantB = uuid(2);
    const appA = uuid(11);
    const appB = uuid(12);
    const timestamp = '2026-10-29 12:34:56.123456';
    await admin.query(
      'INSERT INTO ca_meta_tenants (id, created_at, updated_at) VALUES (?, ?, ?), (?, ?, ?)',
      [tenantA, timestamp, timestamp, tenantB, timestamp, timestamp],
    );
    await admin.query(
      `INSERT INTO ca_meta_app_configurations
       (id, tenant_id, provider, app_external_id, environment, created_at, updated_at)
       VALUES (?, ?, 'META', ?, 'test', ?, ?), (?, ?, 'META', ?, 'test', ?, ?)`,
      [appA, tenantA, '000123-app', timestamp, timestamp, appB, tenantB, '000123-app', timestamp, timestamp],
    );

    const externalId = '000-123|Zażółć 🧪';
    const rows: Array<[string, string, string, string, string, string, string]> = [];
    for (let index = 0; index < 10_000; index += 1) {
      const tenantId = index < 100 ? tenantA : tenantB;
      const appId = index < 100 ? appA : appB;
      rows.push([
        uuid(10_000 + index), tenantId, appId,
        index === 0 ? externalId : `synthetic-${index.toString().padStart(5, '0')}`,
        `legacy name ${index}`, timestamp, timestamp,
      ]);
    }
    rows.push([uuid(3000), tenantB, appB, externalId, 'same external id in another tenant', timestamp, timestamp]);
    for (let offset = 0; offset < rows.length; offset += 500) {
      const batch = rows.slice(offset, offset + 500);
      const valuesSql = batch.map(() => "(?, ?, ?, 'META', 'test', 'PAGE', ?, ?, ?, ?)").join(', ');
      await admin.query(
        `INSERT INTO ca_meta_assets
         (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id, display_name, created_at, updated_at)
        VALUES ${valuesSql}`,
        batch.flatMap((row) => row),
      );
    }
    const tenantByFixtureLabel = {
      [tenantIsolationFixture.tenantA]: tenantA,
      [tenantIsolationFixture.tenantB]: tenantB,
    };
    const longestSupportedExternalId = 'é'.repeat(512);
    await admin.query(
      `INSERT INTO ca_meta_assets
       (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id, display_name, created_at, updated_at)
       VALUES (?, ?, ?, 'META', 'test', 'PAGE', ?, 'maximum external id', ?, ?)`,
      [uuid(3001), tenantB, appB, longestSupportedExternalId, timestamp, timestamp],
    );

    await crashAt(additive.id, 'M2_CRASH_AFTER_BACKFILL_STEP', 'backfill-asset-external-name', 87);
    const stepRows = await queryRows<{ state: string; cursor_value: string | null }>(admin,
      `SELECT state, cursor_value FROM ${MIGRATION_STEP_LEDGER} WHERE migration_id = ? AND step_id = ?`,
      [additive.id, 'backfill-asset-external-name'],
    );
    assert.equal(stepRows[0]?.state, 'STARTED');
    assert.ok(stepRows[0]?.cursor_value, 'first committed batch cursor is persisted');

    // This N-1 id sorts below the stored cursor. The expansion trigger protects it while the backfill is paused.
    await admin.query(
      `INSERT INTO ca_meta_assets
       (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id, display_name, created_at, updated_at)
       VALUES (?, ?, ?, 'META', 'test', 'PAGE', ?, ?, ?, ?)`,
      [uuid(9000), tenantA, appA, 'n-1-during-backfill', 'written during partial backfill', timestamp, timestamp],
    );
    const duringBackfillWrite = await queryRows<{ external_name: string | null }>(admin,
      'SELECT external_name FROM ca_meta_assets WHERE id = ?', [uuid(9000)],
    );
    assert.equal(duringBackfillWrite[0]?.external_name, 'written during partial backfill');
    assert.ok(String(stepRows[0]?.cursor_value).localeCompare(uuid(9000)) > 0, 'test writer ID is behind the persisted cursor');

    await deployMigrations(environment, [additive]);
    await deployMigrations(environment);
    const identityTimestamp = '2026-10-30 12:00:00.000000';
    const identityUserId = uuid(70_001);
    const identityServiceId = uuid(70_002);
    await admin.query(
      `INSERT INTO ca_meta_principals (id, kind, issuer, subject, status, created_at, updated_at)
       VALUES (?, 'USER', 'https://issuer.synthetic.invalid', 'subject-synthetic-001', 'ACTIVE', ?, ?),
              (?, 'SERVICE', 'https://issuer.synthetic.invalid', 'service-synthetic-001', 'ACTIVE', ?, ?)`,
      [identityUserId, identityTimestamp, identityTimestamp, identityServiceId, identityTimestamp, identityTimestamp],
    );
    await admin.query(
      `INSERT INTO ca_meta_memberships
       (tenant_id, principal_id, principal_kind, roles, status, created_at, updated_at)
       VALUES (?, ?, 'USER', JSON_ARRAY('owner'), 'ACTIVE', ?, ?),
              (?, ?, 'USER', JSON_ARRAY('viewer'), 'ACTIVE', ?, ?)`,
      [tenantA, identityUserId, identityTimestamp, identityTimestamp, tenantB, identityUserId, identityTimestamp, identityTimestamp],
    );
    await admin.query(
      `INSERT INTO ca_meta_service_identity_scopes
       (tenant_id, principal_id, principal_kind, scope, status, created_at)
       VALUES (?, ?, 'SERVICE', 'CREDENTIAL_USE', 'ACTIVE', ?)`,
      [tenantA, identityServiceId, identityTimestamp],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO ca_meta_memberships
         (tenant_id, principal_id, principal_kind, roles, status, created_at, updated_at)
         VALUES (?, ?, 'USER', JSON_ARRAY('operator'), 'ACTIVE', ?, ?)`,
        [tenantA, identityServiceId, identityTimestamp, identityTimestamp],
      ),
    );
    await admin.query(
      `INSERT INTO ca_meta_principals (id, kind, issuer, subject, status, created_at, updated_at)
       VALUES (?, 'USER', 'https://issuer.synthetic.invalid', 'subject-invalid-role-check', 'ACTIVE', ?, ?)`,
      [uuid(70_007), identityTimestamp, identityTimestamp],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO ca_meta_memberships
         (tenant_id, principal_id, principal_kind, roles, status, created_at, updated_at)
         VALUES (?, ?, 'USER', JSON_ARRAY('platform_admin'), 'ACTIVE', ?, ?)`,
        [tenantA, uuid(70_007), identityTimestamp, identityTimestamp],
      ),
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO ca_meta_service_identity_scopes
         (tenant_id, principal_id, principal_kind, scope, status, created_at)
         VALUES (?, ?, 'SERVICE', 'CREDENTIAL_USE', 'ACTIVE', ?)`,
        [tenantA, identityUserId, identityTimestamp],
      ),
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO ca_meta_memberships
         (tenant_id, principal_id, principal_kind, roles, status, created_at, updated_at)
         VALUES (?, ?, 'USER', JSON_ARRAY(), 'ACTIVE', ?, ?)`,
        [tenantA, uuid(70_003), identityTimestamp, identityTimestamp],
      ),
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO ca_meta_principals (id, kind, issuer, subject, status, created_at, updated_at)
         VALUES (?, 'USER', 'https://issuer.synthetic.invalid', 'subject-synthetic-001', 'ACTIVE', ?, ?)`,
        [uuid(70_004), identityTimestamp, identityTimestamp],
      ),
    );

    // Provisioning and membership changes execute through trusted internal capabilities and commit their audit rows atomically.
    const runtimeDatabase = {
      host: environment.database.host,
      port: environment.database.port,
      name: environment.database.name,
      user: environment.apiDatabaseUser,
      password: process.env.M2_API_DATABASE_PASSWORD ?? '',
      connectTimeoutMs: environment.database.connectTimeoutMs,
    };
    const identityRepository = new MysqlIdentityRepository(runtimeDatabase);
    const adminRepository = new MysqlIdentityAdministrationRepository(runtimeDatabase);
    try {
      const assertionVerifier = new SyntheticAssertionVerifier();
      const platformAssertion = assertionVerifier.verify('synthetic-platform-administrator');
      const targetOwner = assertionVerifier.verify('synthetic-bootstrap-owner');
      const authority = new PlatformIdentityAdminAuthority([{
        issuer: 'https://issuer.synthetic.invalid', subject: 'synthetic-platform-administrator',
      }]);
      const platformActor = authority.verify(platformAssertion);
      const identityService = new IdentityAdministrationService(adminRepository, new TenantContextService(identityRepository));
      const legacyMapping = {
        legacyDatabaseId: 'synthetic-bootstrap-db', legacyCompanyId: 'synthetic-bootstrap-company', environment: 'test' as const,
      };
      const bootKey = uuid(71_001);
      const boot = await identityService.bootstrapTenant(platformActor, targetOwner, legacyMapping, bootKey);
      const bootReplay = await identityService.bootstrapTenant(platformActor, targetOwner, legacyMapping, bootKey);
      assert.equal(bootReplay.tenantId, boot.tenantId);
      assert.equal(bootReplay.replayed, true);
      await assert.rejects(
        identityService.bootstrapTenant(platformActor, assertionVerifier.verify('different-bootstrap-owner'), legacyMapping, bootKey),
        IdentityAdministrationConflictError,
      );
      const bootstrapLegacyMap = await queryRows<{ legacy_database_id: string; legacy_company_id: string; environment: string }>(admin,
        `SELECT legacy_database_id, legacy_company_id, environment FROM ca_meta_tenant_legacy_maps WHERE tenant_id = ?`, [boot.tenantId],
      );
      assert.deepEqual(bootstrapLegacyMap, [{ ...legacyMapping }]);

      const contextRef = 'synthetic-integration-context-ref-owner';
      const cookie = 'synthetic-integration-session-cookie-with-enough-entropy';
      const cookieHash = createHash('sha256').update(cookie, 'utf8').digest();
      const portalSession = await new PortalSessionVerifier({
        async findActiveBySecretHash(hash) {
          if (!Buffer.from(hash).equals(cookieHash)) return undefined;
          return {
            sessionId: uuid(71_002), principalId: identityUserId, tenantId: tenantA,
            contextVersion: 1, contextRefHash: hashTenantContextReference(contextRef),
          };
        },
      }).verify(cookie);
      assert.ok(portalSession);
      const targetMember = assertionVerifier.verify('synthetic-member-to-admin');
      const grantKey = uuid(71_003);
      const granted = await identityService.grantMembership(
        portalSession, contextRef, targetMember, 'admin', 'MEMBERSHIP_GRANT', grantKey,
      );
      const grantReplay = await identityService.grantMembership(
        portalSession, contextRef, targetMember, 'admin', 'MEMBERSHIP_GRANT', grantKey,
      );
      assert.equal(grantReplay.replayed, true);
      assert.equal(grantReplay.principalId, granted.principalId);

      const adminContextRef = 'synthetic-integration-context-ref-admin';
      const adminCookie = 'synthetic-integration-admin-cookie-with-enough-entropy';
      const adminCookieHash = createHash('sha256').update(adminCookie, 'utf8').digest();
      const adminSession = await new PortalSessionVerifier({
        async findActiveBySecretHash(hash) {
          if (!Buffer.from(hash).equals(adminCookieHash)) return undefined;
          return {
            sessionId: uuid(71_004), principalId: granted.principalId as string, tenantId: tenantA,
            contextVersion: 1, contextRefHash: hashTenantContextReference(adminContextRef),
          };
        },
      }).verify(adminCookie);
      assert.ok(adminSession);
      const adminScope = await new TenantContextService(identityRepository).resolveCurrent(adminSession, adminContextRef);
      await assert.rejects(
        identityService.grantMembership(
          adminSession, adminContextRef, assertionVerifier.verify('synthetic-escalation-target'), 'admin',
          'MEMBERSHIP_GRANT', uuid(71_005),
        ),
      );
      // Repository direct calls still enforce role policy and preserve privileged target memberships.
      await assert.rejects(adminRepository.execute({
        action: 'GRANT_MEMBERSHIP', actor: adminSession, scope: adminScope, target: targetMember, role: 'viewer',
        reasonCode: 'ROLE_CHANGE', idempotencyKey: uuid(71_007), requestHash: 'c'.repeat(64),
      }));
      const ownerScope = await new TenantContextService(identityRepository).resolveCurrent(portalSession, contextRef);
      await assert.rejects(adminRepository.execute({
        action: 'GRANT_MEMBERSHIP', actor: portalSession, scope: ownerScope,
        target: assertionVerifier.verify('subject-synthetic-001'), role: 'operator',
        reasonCode: 'ROLE_CHANGE', idempotencyKey: uuid(71_008), requestHash: 'd'.repeat(64),
      }));
      const noEscalationAudit = await queryRows<{ count: string | number }>(admin,
        'SELECT COUNT(*) AS count FROM ca_meta_identity_admin_audit WHERE idempotency_key IN (?, ?, ?, ?)',
        [uuid(71_005), uuid(71_007), uuid(71_008), uuid(71_009)],
      );
      assert.equal(Number(noEscalationAudit[0]?.count), 0);

      const revoked = await identityService.revokeMembership(portalSession, contextRef, granted.principalId as string, uuid(71_006));
      const revokedMember = await queryRows<{ status: string; revoked_at: string | null }>(admin,
        'SELECT status, revoked_at FROM ca_meta_memberships WHERE tenant_id = ? AND principal_id = ?',
        [tenantA, revoked.principalId],
      );
      assert.equal(revokedMember[0]?.status, 'REVOKED');
      assert.ok(revokedMember[0]?.revoked_at);

      const adminAudit = await queryRows<{ action: string; authority_kind: string; reason_code: string; request_hash: string; actor_ref: string }>(admin,
        `SELECT action, authority_kind, reason_code, request_hash, actor_ref
         FROM ca_meta_identity_admin_audit WHERE idempotency_key IN (?, ?, ?, ?, ?, ?, ?) ORDER BY action`,
        [bootKey, grantKey, uuid(71_005), uuid(71_006), uuid(71_007), uuid(71_008), uuid(71_009)],
      );
      assert.equal(adminAudit.length, 3, 'denied escalation is not recorded as a successful provisioning command');
      assert.ok(adminAudit.some((row) => row.action === 'BOOTSTRAP_TENANT' && row.authority_kind === 'PLATFORM_IDENTITY_ADMIN' && row.reason_code === 'INITIAL_PROVISIONING'));
      assert.ok(adminAudit.some((row) => row.action === 'GRANT_MEMBERSHIP' && row.authority_kind === 'TENANT_OWNER' && row.reason_code === 'MEMBERSHIP_GRANT'));
      assert.ok(adminAudit.some((row) => row.action === 'REVOKE_MEMBERSHIP' && row.reason_code === 'MEMBERSHIP_REVOCATION'));
      assert.ok(adminAudit.every((row) => /^[a-f0-9]{64}$/.test(row.actor_ref) && /^[a-f0-9]{64}$/.test(row.request_hash)));
      const auditColumns = await queryRows<{ column_name: string }>(admin,
        `SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE()
         AND table_name = 'ca_meta_identity_admin_audit' ORDER BY ordinal_position`,
      );
      assert.ok(!auditColumns.some((row) => /subject|token|cookie|secret/i.test(row.column_name)));
      await assert.rejects(admin.query('UPDATE ca_meta_identity_admin_audit SET reason_code = \'ROLE_CHANGE\' WHERE idempotency_key = ?', [grantKey]));
      await assert.rejects(admin.query('DELETE FROM ca_meta_identity_admin_audit WHERE idempotency_key = ?', [grantKey]));
    } finally {
      await Promise.all([identityRepository.onApplicationShutdown(), adminRepository.onApplicationShutdown()]);
    }

    // Two companies may share a legacy database; a tenant-scoped lookup cannot use the other company's mapping.
    await admin.query(
      `INSERT INTO ca_meta_tenant_legacy_maps
       (id, tenant_id, legacy_database_id, legacy_company_id, environment, created_at)
       VALUES (?, ?, 'synthetic-db-shared', 'synthetic-company-a', 'test', ?),
              (?, ?, 'synthetic-db-shared', 'synthetic-company-b', 'test', ?)`,
      [uuid(70_005), tenantA, identityTimestamp, uuid(70_006), tenantB, identityTimestamp],
    );
    const foreignLegacyMapping = await queryRows<{ count: string | number }>(admin,
      `SELECT COUNT(*) AS count FROM ca_meta_tenant_legacy_maps
       WHERE tenant_id = ? AND legacy_database_id = ? AND legacy_company_id = ? AND environment = ?`,
      [tenantA, 'synthetic-db-shared', 'synthetic-company-b', 'test'],
    );
    assert.equal(Number(foreignLegacyMapping[0]?.count), 0);

    const backfillRows = await queryRows<{ count: string | number }>(admin,
      'SELECT COUNT(*) AS count FROM ca_meta_assets WHERE external_name IS NULL OR BINARY external_name <> BINARY display_name',
    );
    assert.equal(Number(backfillRows[0]?.count ?? 0), 0);

    const preserved = await queryRows<{ id: string; external_id: string; created_at: string; external_name: string }>(admin,
      `SELECT id, external_id, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at,
              external_name FROM ca_meta_assets WHERE id = ?`,
      [uuid(10_000)],
    );
    assert.equal(preserved[0]?.id, uuid(10_000));
    assert.equal(preserved[0]?.external_id, externalId);
    assert.equal(preserved[0]?.created_at, timestamp);
    assert.equal(preserved[0]?.external_name, 'legacy name 0');
    const migratedNMinusOne = await queryRows<{ display_name: string; external_name: string | null }>(admin,
      'SELECT display_name, external_name FROM ca_meta_assets WHERE id = ?', [uuid(9000)],
    );
    assert.equal(migratedNMinusOne[0]?.display_name, 'written during partial backfill');
    assert.equal(migratedNMinusOne[0]?.external_name, 'written during partial backfill');
    const longIdRows = await queryRows<{ external_id: string; char_length: number; byte_length: number }>(admin,
      'SELECT external_id, CHAR_LENGTH(external_id) AS char_length, OCTET_LENGTH(external_id) AS byte_length FROM ca_meta_assets WHERE id = ?',
      [uuid(3001)],
    );
    assert.equal(longIdRows[0]?.external_id, longestSupportedExternalId);
    assert.equal(Number(longIdRows[0]?.char_length), 512);
    assert.equal(Number(longIdRows[0]?.byte_length), 1024);

    // An N-1 writer can keep inserting the old column after the additive migration.
    await admin.query(
      `INSERT INTO ca_meta_assets
       (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id, display_name, created_at, updated_at)
       VALUES (?, ?, ?, 'META', 'test', 'PAGE', ?, ?, ?, ?)`,
      [uuid(30_001), tenantA, appA, 'n-1-write-0007', 'written by old client', timestamp, timestamp],
    );
    const nMinusOne = await queryRows<{ display_name: string; external_name: string | null }>(admin,
      'SELECT display_name, external_name FROM ca_meta_assets WHERE id = ?', [uuid(30_001)],
    );
    assert.equal(nMinusOne[0]?.display_name, 'written by old client');
    assert.equal(nMinusOne[0]?.external_name, 'written by old client');
    await admin.query('UPDATE ca_meta_assets SET display_name = ? WHERE id = ?', ['updated by N-1 writer', uuid(30_001)]);
    const updatedNMinusOne = await queryRows<{ display_name: string; external_name: string | null }>(admin,
      'SELECT display_name, external_name FROM ca_meta_assets WHERE id = ?', [uuid(30_001)],
    );
    assert.equal(updatedNMinusOne[0]?.display_name, 'updated by N-1 writer');
    assert.equal(updatedNMinusOne[0]?.external_name, 'updated by N-1 writer');
    await admin.query('UPDATE ca_meta_assets SET display_name = ? WHERE id = ?', ['updated by N-1 writer ', uuid(30_001)]);
    const trailingSpaceName = await queryRows<{ display_name: string; external_name: string | null; display_name_bytes: number; external_name_bytes: number }>(admin,
      `SELECT display_name, external_name, OCTET_LENGTH(display_name) AS display_name_bytes,
              OCTET_LENGTH(external_name) AS external_name_bytes
       FROM ca_meta_assets WHERE id = ?`, [uuid(30_001)],
    );
    assert.equal(trailingSpaceName[0]?.display_name, 'updated by N-1 writer ');
    assert.equal(trailingSpaceName[0]?.external_name, 'updated by N-1 writer ');
    assert.equal(Number(trailingSpaceName[0]?.external_name_bytes), Number(trailingSpaceName[0]?.display_name_bytes));
    await admin.query('UPDATE ca_meta_assets SET display_name = ? WHERE id = ?', ['updated by N-1 writer', uuid(30_001)]);
    const revertedTrailingSpaceName = await queryRows<{ display_name: string; external_name: string | null }>(admin,
      'SELECT display_name, external_name FROM ca_meta_assets WHERE id = ?', [uuid(30_001)],
    );
    assert.equal(revertedTrailingSpaceName[0]?.display_name, 'updated by N-1 writer');
    assert.equal(revertedTrailingSpaceName[0]?.external_name, 'updated by N-1 writer');

    // The asset unique identity includes tenant scope; the same provider ID in another tenant survived.
    const duplicateCheck = await queryRows<{ count: string | number }>(admin,
      'SELECT COUNT(*) AS count FROM ca_meta_assets WHERE external_id = ?', [externalId],
    );
    assert.equal(Number(duplicateCheck[0]?.count), 2);
    const assetCandidateKey = await queryRows<{ name: string }>(admin,
      `SELECT column_name AS name FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'ca_meta_assets'
         AND index_name = 'uq_ca_meta_asset_tenant_id' AND non_unique = 0
       ORDER BY seq_in_index`,
    );
    assert.deepEqual(assetCandidateKey.map((row) => row.name), ['tenant_id', 'id']);
    const trailingSpaceId = `${externalId} `;
    await admin.query(
      `INSERT INTO ca_meta_assets
       (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id, display_name, created_at, updated_at)
       VALUES (?, ?, ?, 'META', 'test', 'PAGE', ?, 'trailing-space identity', ?, ?)`,
      [uuid(4004), tenantA, appA, trailingSpaceId, timestamp, timestamp],
    );
    const exactIdentityCount = await queryRows<{ count: string | number }>(admin,
      'SELECT COUNT(*) AS count FROM ca_meta_assets WHERE external_id = ?', [trailingSpaceId],
    );
    assert.equal(Number(exactIdentityCount[0]?.count), 1, 'NO PAD binary collation distinguishes an external ID with a trailing space');
    const preservedTrailingSpace = await queryRows<{ external_id: string; external_name: string | null }>(admin,
      'SELECT external_id, external_name FROM ca_meta_assets WHERE id = ?', [uuid(4004)],
    );
    assert.equal(preservedTrailingSpace[0]?.external_id, trailingSpaceId);
    assert.equal(preservedTrailingSpace[0]?.external_name, 'trailing-space identity');
    await assert.rejects(
      admin.query(
        `INSERT INTO ca_meta_assets
         (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id, display_name, created_at, updated_at, external_name)
         VALUES (?, ?, ?, 'META', 'test', 'PAGE', ?, 'new writer', ?, ?, 'new writer')`,
        [uuid(4001), tenantA, appA, externalId, timestamp, timestamp],
      ),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_DUP_ENTRY',
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO ca_meta_assets
         (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id, display_name, created_at, updated_at)
         VALUES (?, ?, ?, 'META', 'test', 'PAGE', ?, 'too long', ?, ?)`,
        [uuid(4003), tenantA, appA, `${longestSupportedExternalId}é`, timestamp, timestamp],
      ),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_DATA_TOO_LONG',
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO ca_meta_assets
         (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id, display_name, created_at, updated_at)
         VALUES (?, ?, ?, 'META', 'test', 'PAGE', 'cross-tenant-fk', 'invalid', ?, ?)`,
        [
          uuid(4002),
          tenantByFixtureLabel[tenantIsolationFixture.assetTenant],
          tenantByFixtureLabel[tenantIsolationFixture.appConfigurationTenant] === tenantA ? appA : appB,
          timestamp,
          timestamp,
        ],
      ),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === tenantIsolationFixture.expectedMariaDbError,
    );

    // Session ownership lands in M3; synthetic volume checks that tenant-scoped plans use indexes without forcing them.
    const migrationConnection = await createConnection({
      ...connectionOptions,
      user: environment.database.user,
      password: environment.database.password,
    });
    try {
      await migrationConnection.query('ANALYZE TABLE ca_meta_assets');
      const explain = await queryRows<{ key: string | null; type: string }>(admin,
        `EXPLAIN SELECT id FROM ca_meta_assets
         WHERE tenant_id = ? AND asset_kind = 'PAGE' ORDER BY created_at LIMIT 20`,
        [tenantA],
      );
      assert.equal(explain[0]?.key, 'ix_ca_meta_asset_tenant_kind_created');
      assert.notEqual(explain[0]?.type, 'ALL', 'synthetic tenant-scoped asset query avoids full table scan');

      await migrationConnection.query(`CREATE TABLE IF NOT EXISTS ca_meta_m203_session_fixture (
        id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        secret_hash BINARY(32) NOT NULL,
        issued_at DATETIME(6) NOT NULL,
        idle_at DATETIME(6) NOT NULL,
        expires_at DATETIME(6) NOT NULL,
        revoked_at DATETIME(6) NULL,
        version BIGINT UNSIGNED NOT NULL DEFAULT 1,
        UNIQUE KEY uq_m203_session_secret (secret_hash),
        KEY ix_m203_session_tenant_live (tenant_id, revoked_at, expires_at)
      ) ENGINE=InnoDB`);
      const sessionRows: Array<[string, string, string, string, string, string]> = [];
      for (let index = 0; index < 10_000; index += 1) {
        const id = uuid(50_000 + index);
        sessionRows.push([id, index < 100 ? tenantA : tenantB, id, timestamp, timestamp, '2027-10-29 12:34:56.123456']);
      }
      for (let offset = 0; offset < sessionRows.length; offset += 500) {
        const batch = sessionRows.slice(offset, offset + 500);
        const valuesSql = batch.map(() => '(?, ?, UNHEX(SHA2(?, 256)), ?, ?, ?)').join(', ');
        await migrationConnection.query(
          `INSERT INTO ca_meta_m203_session_fixture (id, tenant_id, secret_hash, issued_at, idle_at, expires_at)
           VALUES ${valuesSql}`,
          batch.flatMap((row) => row),
        );
      }
      await migrationConnection.query('ANALYZE TABLE ca_meta_m203_session_fixture');
      const sessionExplain = await queryRows<{ key: string | null; type: string }>(admin,
        `EXPLAIN SELECT id FROM ca_meta_m203_session_fixture
         WHERE tenant_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 20`,
        [tenantA, timestamp],
      );
      assert.equal(sessionExplain[0]?.key, 'ix_m203_session_tenant_live');
      assert.notEqual(sessionExplain[0]?.type, 'ALL', 'synthetic tenant-scoped session query avoids full table scan');
    } finally {
      await migrationConnection.end();
    }

    const applied = await readMigrationStatus(environment);
    assert.equal(applied.migrations.length, 4);
    assert.ok(applied.migrations.every((migration) => migration.state === 'APPLIED' && migration.checksumMatches));

    const runtime = await createConnection(connectionOptions);
    try {
      await runtime.query("SET time_zone = '+00:00'");
      await runtime.query("SET SESSION sql_mode = CONCAT(@@session.sql_mode, ',STRICT_ALL_TABLES')");
      const result = await queryRows<{ count: string | number }>(runtime, 'SELECT COUNT(*) AS count FROM ca_meta_assets');
      assert.equal(Number(result[0]?.count), 10_005);
      await assert.rejects(runtime.query('CREATE TABLE runtime_role_must_not_ddl (id INT PRIMARY KEY)'),
        (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_TABLEACCESS_DENIED_ERROR');
    } finally {
      await runtime.end();
    }

    const lock = migrationLockName(environment.database.name);
    const lockResult = await queryRows<{ acquired: number }>(admin, 'SELECT GET_LOCK(?, 0) AS acquired', [lock]);
    assert.equal(Number(lockResult[0]?.acquired), 1);
    try {
      await assert.rejects(deployMigrations(environment), /lock acquisition timed out or failed/);
    } finally {
      await admin.query('SELECT RELEASE_LOCK(?)', [lock]);
    }

    await Promise.all([deployMigrations(environment), deployMigrations(environment)]);
    const finalStatus = await readMigrationStatus(environment);
    assert.ok(finalStatus.migrations.every((migration) => migration.state === 'APPLIED' && migration.checksumMatches));
  } finally {
    await admin.end();
  }
});
