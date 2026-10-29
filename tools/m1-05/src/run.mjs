import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { canTransition, deriveReadiness, isObservationStale } from './readiness.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(path.join(root, 'fixtures', 'coexistence-scenarios.json'), 'utf8'));
const schema = await readFile(path.join(root, 'sql', 'schema.sql'), 'utf8');
const fixedNow = Date.parse('2026-10-28T12:00:00.000Z');
const fixedSqlNow = '2026-10-28 12:00:00.000000';

function uuid(label) {
  const bytes = createHash('sha256').update(`m1-05:${label}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function jsonValue(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function safeConfig(env = process.env) {
  const expected = { host: 'db', port: '3306', user: 'm105_test', database: 'm105_domain' };
  const actual = { host: env.M105_DB_HOST, port: env.M105_DB_PORT, user: env.M105_DB_USER, database: env.M105_DB_NAME };
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(actual[key], value, `Refusing unexpected DB ${key} before connection`);
  }
  assert.ok(env.M105_DB_PASSWORD, 'M105_DB_PASSWORD must be provided ephemerally by the Compose runner');
  return { ...actual, port: Number(actual.port), password: env.M105_DB_PASSWORD, multipleStatements: true, connectionLimit: 4, timezone: 'Z' };
}

function record(name, fn) {
  return fn().then(() => console.log(`PASS ${name}`));
}

const AUDIT_DIFF_FIELDS = new Set(['before', 'after', 'status', 'policyVersion', 'version', 'reasonCode']);
const AUDIT_SAFE_STATES = new Set([
  'CREATED', 'AWAITING_PROVIDER', 'CODE_RECEIVED', 'EXCHANGING', 'ASSETS_VERIFIED',
  'PROVISIONING', 'READY', 'PARTIAL', 'CANCELLED', 'EXPIRED', 'FAILED', 'VERIFIED',
  'REVOKED', 'ACTIVE', 'REAUTH_REQUIRED', 'UNKNOWN', 'STALE', 'MISSING', 'TOMBSTONED',
]);
const AUDIT_SAFE_REASONS = new Set(['CAPABILITY_MISSING', 'EVIDENCE_STALE', 'ROUTE_CONFLICT', 'REAUTH_REQUIRED']);

function validateAuditDiff(diff) {
  if (!diff || typeof diff !== 'object' || Array.isArray(diff)) throw new Error('Unsafe audit diff: object required');
  const entries = Object.entries(diff);
  if (entries.length === 0) throw new Error('Unsafe audit diff: empty diff');
  for (const [key, value] of entries) {
    if (!AUDIT_DIFF_FIELDS.has(key)) throw new Error(`Unsafe audit diff: field ${key} is not allowlisted`);
    if (key === 'before' || key === 'after' || key === 'status') {
      if (typeof value !== 'string' || !AUDIT_SAFE_STATES.has(value)) throw new Error(`Unsafe audit diff: invalid ${key}`);
    } else if (key === 'reasonCode') {
      if (typeof value !== 'string' || !AUDIT_SAFE_REASONS.has(value)) throw new Error('Unsafe audit diff: invalid reasonCode');
    } else if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Unsafe audit diff: invalid ${key}`);
    }
  }
  return Object.fromEntries(entries);
}

async function insertAuditEvent(db, { id, tenantId, actorRef, action, targetRef, correlationId, safeDiff, createdAt, retentionClass }) {
  const validatedDiff = validateAuditDiff(safeDiff);
  return db.execute(
    `INSERT INTO m105_audit_event (id, tenant_id, actor_ref, action, target_ref, correlation_id, safe_diff, created_at, retention_class, record_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [id, tenantId, actorRef, action, targetRef, correlationId, JSON.stringify(validatedDiff), createdAt, retentionClass],
  );
}

let db;
try {
  const config = safeConfig();
  for (const [name, value] of [['M105_DB_HOST', '127.0.0.1'], ['M105_DB_PORT', '3307'], ['M105_DB_USER', 'root'], ['M105_DB_NAME', 'mysql']]) {
    const env = { ...process.env, [name]: value };
    assert.throws(() => safeConfig(env), /Refusing unexpected DB/);
  }
  db = await mysql.createConnection(config);
  await db.query(schema);
  await db.query(`CREATE TABLE m105_test_effect_sink (
    idempotency_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY,
    applied_count INT UNSIGNED NOT NULL DEFAULT 0,
    delivery_attempts INT UNSIGNED NOT NULL DEFAULT 0
  ) ENGINE=InnoDB`);

  const appId = uuid(fixture.appConfig.id);
  const alternateAppConfig = {
    id: 'synthetic:alternate-app-config',
    environment: fixture.appConfig.environment,
    flowVariant: 'WHATSAPP_EXCLUSIVE',
    authVariant: 'synthetic:exclusive',
  };
  const alternateAppId = uuid(alternateAppConfig.id);
  await db.execute(
    `INSERT INTO m105_meta_app_config (id, provider, provider_app_id, environment, flow_variant, auth_variant, graph_version, signup_version, capabilities_version, public_config, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [appId, fixture.provider, fixture.appConfig.id, fixture.appConfig.environment, fixture.appConfig.flowVariant, fixture.appConfig.authVariant, fixture.appConfig.graphVersion, fixture.appConfig.signupVersion, fixture.appConfig.capabilitiesVersion, JSON.stringify({ synthetic: true })],
  );
  await db.execute(
    `INSERT INTO m105_meta_app_config (id, provider, provider_app_id, environment, flow_variant, auth_variant, graph_version, signup_version, capabilities_version, public_config, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [alternateAppId, fixture.provider, fixture.appConfig.id, alternateAppConfig.environment, alternateAppConfig.flowVariant, alternateAppConfig.authVariant, fixture.appConfig.graphVersion, fixture.appConfig.signupVersion, fixture.appConfig.capabilitiesVersion, JSON.stringify({ synthetic: true, alternate: true })],
  );

  const tenants = new Map();
  const assets = new Map();
  const authorizations = new Map();
  const credentials = new Map();
  const onboardings = new Map();
  const assetOwners = new Map();

  for (const scenario of fixture.scenarios) {
    const tenantId = uuid(scenario.tenantId);
    const principalId = uuid(`${scenario.tenantId}:principal`);
    tenants.set(scenario.tenantId, tenantId);
    await db.execute('INSERT INTO m105_tenant (id, status, created_at, version) VALUES (?, ?, ?, 1)', [tenantId, 'ACTIVE', fixedSqlNow]);
    await db.execute('INSERT INTO m105_principal (id, kind, issuer, subject, status, version) VALUES (?, ?, ?, ?, ?, 1)', [principalId, 'USER', 'synthetic:issuer', `${scenario.tenantId}:user`, 'ACTIVE']);
    await db.execute('INSERT INTO m105_membership (tenant_id, principal_id, roles, status, version) VALUES (?, ?, ?, ?, 1)', [tenantId, principalId, JSON.stringify(['operator']), 'ACTIVE']);

    const createAsset = async ({ id, externalId, kind }) => {
      const assetId = uuid(id);
      await db.execute(
        `INSERT INTO m105_meta_asset (id, tenant_id, app_config_id, provider, environment, kind, external_id, observed_status, observed_source, observed_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'UNKNOWN', 'synthetic:fixture', NULL, 1)`,
        [assetId, tenantId, appId, fixture.provider, fixture.appConfig.environment, kind, externalId],
      );
      await db.execute(
        `INSERT INTO m105_asset_route_claim (id, provider, app_config_id, environment, kind, external_id, tenant_id, asset_id, claimed_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [uuid(`${id}:route-claim`), fixture.provider, appId, fixture.appConfig.environment, kind, externalId, tenantId, assetId, fixedSqlNow],
      );
      assets.set(id, assetId);
      assetOwners.set(id, { tenantId, scenario, externalId, kind });
      return assetId;
    };

    for (const waba of scenario.wabas) {
      const wabaAssetId = await createAsset({ id: waba.id, externalId: waba.externalId, kind: 'WHATSAPP_BUSINESS_ACCOUNT' });
      for (const number of waba.numbers) {
        const numberAssetId = await createAsset({ id: number.id, externalId: number.externalId, kind: 'PHONE_NUMBER' });
        await db.execute(
          `INSERT INTO m105_asset_relation (id, tenant_id, app_config_id, environment, parent_asset_id, child_asset_id, relation_kind, observed_source, observed_at, version)
           VALUES (?, ?, ?, ?, ?, ?, 'CONTAINS', 'synthetic:fixture', ?, 1)`,
          [uuid(`${waba.id}->${number.id}`), tenantId, appId, fixture.appConfig.environment, wabaAssetId, numberAssetId, fixedSqlNow],
        );
      }
      await db.execute(
        `INSERT INTO m105_webhook_subscription (id, tenant_id, app_config_id, environment, target_asset_id, desired_fields, state, observed_status, observed_source, observed_at, version)
         VALUES (?, ?, ?, ?, ?, ?, 'DESIRED', 'UNKNOWN', 'synthetic:no-provider-observation', NULL, 1)`,
        [uuid(`${waba.id}:subscription`), tenantId, appId, fixture.appConfig.environment, wabaAssetId, JSON.stringify(['synthetic:messages'])],
      );

      for (const authorization of waba.authorizations) {
        const onboardingId = uuid(`${authorization.id}:onboarding`);
        const authId = uuid(authorization.id);
        const credentialId = uuid(authorization.credentialId);
        const stateHash = createHash('sha256').update(`${authorization.id}:state`).digest();
        onboardings.set(authorization.id, { id: onboardingId, tenantId, principalId, version: 1, status: 'CREATED' });
        await db.execute(
          `INSERT INTO m105_onboarding_session (id, tenant_id, principal_id, app_config_id, flow_variant, auth_variant, state_hash, status, expires_at, correlation_id, readiness_policy_version, readiness_reasons, readiness_evaluated_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?, 1, ?, NULL, 1)`,
          [onboardingId, tenantId, principalId, appId, fixture.appConfig.flowVariant, fixture.appConfig.authVariant, stateHash, '2026-10-29 12:00:00.000000', uuid(`${authorization.id}:correlation`), JSON.stringify([{ capability: 'synthetic:required-capability', status: 'UNKNOWN' }])],
        );
        await db.execute(
          `INSERT INTO m105_meta_authorization (id, tenant_id, app_config_id, environment, source_onboarding_id, flow_variant, auth_variant, provider_subject_ref, granted_scopes, status, issued_at, revoked_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, NULL, 1)`,
          [authId, tenantId, appId, fixture.appConfig.environment, onboardingId, fixture.appConfig.flowVariant, fixture.appConfig.authVariant, `synthetic:subject:${authorization.id}`, JSON.stringify(['synthetic:capability']), fixedSqlNow],
        );
        authorizations.set(authorization.id, { id: authId, tenantId, scenario, sourceOnboardingId: onboardingId });
        credentials.set(authorization.credentialId, { id: credentialId, tenantId, authId });
        await db.execute(
          `INSERT INTO m105_meta_credential (id, tenant_id, authorization_id, family, issuer, app_config_id, environment, ciphertext, key_version, scopes_snapshot, authorization_version, expires_at, data_access_expires_at, health, observed_source, observed_at, version)
           VALUES (?, ?, ?, 'synthetic:credential-family', 'synthetic:issuer', ?, ?, ?, 'synthetic:key-version', ?, 1, NULL, NULL, 'UNKNOWN', 'synthetic:no-provider-observation', NULL, 1)`,
          [credentialId, tenantId, authId, appId, fixture.appConfig.environment, Buffer.from('synthetic-ciphertext-fixture'), JSON.stringify(['synthetic:capability'])],
        );
        for (const numberId of authorization.numberIds) {
          await db.execute(
            `INSERT INTO m105_asset_authorization (id, tenant_id, authorization_id, asset_id, app_config_id, environment, capabilities, status, verified_at, revoked_at, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'VERIFIED', ?, NULL, 1)`,
            [uuid(`${authorization.id}:${numberId}`), tenantId, authId, assets.get(numberId), appId, fixture.appConfig.environment, JSON.stringify(['synthetic:capability']), fixedSqlNow],
          );
        }
      }
    }
  }

  const alternateAssetId = uuid('synthetic:alternate-profile-asset');
  const firstTenantId = tenants.get('synthetic:tenant-one-waba');
  await db.execute(
    `INSERT INTO m105_meta_asset (id, tenant_id, app_config_id, provider, environment, kind, external_id, observed_status, observed_source, observed_at, version)
     VALUES (?, ?, ?, ?, ?, 'WHATSAPP_BUSINESS_ACCOUNT', 'synthetic:alternate-profile-waba', 'UNKNOWN', 'synthetic:fixture', NULL, 1)`,
    [alternateAssetId, firstTenantId, alternateAppId, fixture.provider, alternateAppConfig.environment],
  );
  await db.execute(
    `INSERT INTO m105_asset_route_claim (id, provider, app_config_id, environment, kind, external_id, tenant_id, asset_id, claimed_at, version)
     VALUES (?, ?, ?, ?, 'WHATSAPP_BUSINESS_ACCOUNT', 'synthetic:alternate-profile-waba', ?, ?, ?, 1)`,
    [uuid('synthetic:alternate-profile-route-claim'), fixture.provider, alternateAppId, alternateAppConfig.environment, firstTenantId, alternateAssetId, fixedSqlNow],
  );
  assets.set('synthetic:alternate-profile-asset', alternateAssetId);

  await record('AC01.single-waba', async () => {
    const [waba] = fixture.scenarios.filter((item) => item.id === 'one_waba_four_numbers');
    assert.equal(waba.wabas.length, 1);
    assert.equal(waba.wabas[0].numbers.length, 4);
    const initialAuthorizations = waba.wabas[0].authorizations.filter((item) => !item.successorOf);
    assert.equal(initialAuthorizations.length, 4, 'the four numbers have four consecutive initial onboarding/auth records');
    const [onboardingRows] = await db.execute('SELECT COUNT(*) AS count FROM m105_onboarding_session WHERE tenant_id = ?', [tenants.get(waba.tenantId)]);
    assert.equal(Number(onboardingRows[0].count), 5, 'the four initial onboards plus the partial reauth are preserved');
    const [newGrant] = await db.execute(
      `SELECT COUNT(*) AS count FROM m105_asset_authorization WHERE tenant_id = ? AND asset_id = ?`,
      [tenants.get(waba.tenantId), assets.get('synthetic:number-03')],
    );
    assert.equal(Number(newGrant[0].count), 2, 'reauth adds a second authorization without overwriting the old link');
    const [n1Candidates] = await db.execute(
      `SELECT auth.id AS authorization_id, credential.id AS credential_id
       FROM m105_asset_authorization grant_link
       JOIN m105_meta_asset asset ON asset.tenant_id = grant_link.tenant_id AND asset.id = grant_link.asset_id
       JOIN m105_meta_authorization auth ON auth.tenant_id = grant_link.tenant_id AND auth.id = grant_link.authorization_id
       JOIN m105_meta_credential credential ON credential.tenant_id = auth.tenant_id AND credential.authorization_id = auth.id
       WHERE grant_link.tenant_id = ? AND grant_link.asset_id = ? AND grant_link.status = 'VERIFIED' AND auth.status = 'ACTIVE'
         AND JSON_CONTAINS(grant_link.capabilities, JSON_QUOTE('synthetic:capability'))
          AND auth.app_config_id = ? AND asset.app_config_id = ? AND credential.app_config_id = ?
          AND asset.app_config_id = auth.app_config_id AND credential.app_config_id = auth.app_config_id
          AND asset.environment = auth.environment AND credential.environment = auth.environment
          AND credential.environment = ?`,
      [tenants.get(waba.tenantId), assets.get('synthetic:number-01'), appId, appId, appId, fixture.appConfig.environment],
    );
    assert.equal(n1Candidates.length, 1);
    assert.equal(n1Candidates[0].authorization_id, authorizations.get('synthetic:auth-one-number-01').id);
    assert.equal(n1Candidates[0].credential_id, credentials.get('synthetic:credential-one-number-01').id);
    const [wrongProfileCandidates] = await db.execute(
      `SELECT auth.id AS authorization_id, credential.id AS credential_id
       FROM m105_asset_authorization grant_link
       JOIN m105_meta_asset asset ON asset.tenant_id = grant_link.tenant_id AND asset.id = grant_link.asset_id
       JOIN m105_meta_authorization auth ON auth.tenant_id = grant_link.tenant_id AND auth.id = grant_link.authorization_id
       JOIN m105_meta_credential credential ON credential.tenant_id = auth.tenant_id AND credential.authorization_id = auth.id
       WHERE grant_link.tenant_id = ? AND grant_link.asset_id = ? AND grant_link.status = 'VERIFIED' AND auth.status = 'ACTIVE'
         AND asset.app_config_id = ? AND auth.app_config_id = ? AND credential.app_config_id = ?
         AND asset.app_config_id = auth.app_config_id AND credential.app_config_id = auth.app_config_id`,
      [tenants.get(waba.tenantId), assets.get('synthetic:number-01'), alternateAppId, alternateAppId, alternateAppId],
    );
    assert.equal(wrongProfileCandidates.length, 0, 'an asset/auth/credential tuple cannot be selected under a different app profile');
    const [n3Candidates] = await db.execute(
      `SELECT auth.id AS authorization_id FROM m105_asset_authorization grant_link
       JOIN m105_meta_authorization auth ON auth.tenant_id = grant_link.tenant_id AND auth.id = grant_link.authorization_id
       WHERE grant_link.tenant_id = ? AND grant_link.asset_id = ? AND grant_link.status = 'VERIFIED' AND auth.status = 'ACTIVE'
         AND JSON_CONTAINS(grant_link.capabilities, JSON_QUOTE('synthetic:capability'))`,
      [tenants.get(waba.tenantId), assets.get('synthetic:number-03')],
    );
    assert.equal(n3Candidates.length, 2, 'the asset has successive grants; an implicit most-recent/global-token fallback is ambiguous');
  });

  await record('AC01.two-waba-reauth', async () => {
    const scenario = fixture.scenarios.find((item) => item.id === 'two_wabas_two_plus_two');
    assert.equal(scenario.wabas.length, 2);
    assert.deepEqual(scenario.wabas.map((waba) => waba.numbers.length), [2, 2]);
    const [rows] = await db.execute(
      `SELECT COUNT(*) AS count FROM m105_meta_credential WHERE tenant_id = ?`,
      [tenants.get(scenario.tenantId)],
    );
    assert.equal(Number(rows[0].count), 3, 'each WABA has a distinct auth/credential, with an additional number-specific reauth');
    const [oldAndNew] = await db.execute(
      `SELECT COUNT(DISTINCT authorization_id) AS count FROM m105_asset_authorization WHERE tenant_id = ? AND asset_id = ?`,
      [tenants.get(scenario.tenantId), assets.get('synthetic:number-13')],
    );
    assert.equal(Number(oldAndNew[0].count), 2);
  });

  await record('AC01.exact-external-id', async () => {
    const exact = fixture.scenarios[0].wabas[0].numbers[0].externalId;
    assert.equal(typeof exact, 'string');
    const [rows] = await db.execute('SELECT external_id FROM m105_meta_asset WHERE id = ?', [assets.get('synthetic:number-01')]);
    assert.equal(rows[0].external_id, exact);
    assert.ok(exact.length > 16);
  });

  await record('AC02.composite-fk', async () => {
    const auth = authorizations.get('synthetic:auth-one-number-01');
    const target = assets.get('synthetic:number-11');
    await assert.rejects(
      db.execute(
        `INSERT INTO m105_asset_authorization (id, tenant_id, authorization_id, asset_id, app_config_id, environment, capabilities, status, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'VERIFIED', 1)`,
        [uuid('cross-tenant-link'), tenants.get('synthetic:tenant-two-waba'), auth.id, target, appId, fixture.appConfig.environment, JSON.stringify(['synthetic:capability'])],
      ),
      (error) => error.code === 'ER_NO_REFERENCED_ROW_2',
    );
    const onboardingId = onboardings.get('synthetic:auth-one-number-01').id;
    await assert.rejects(
      db.execute(
        `INSERT INTO m105_meta_authorization (id, tenant_id, app_config_id, environment, source_onboarding_id, flow_variant, auth_variant, provider_subject_ref, granted_scopes, status, issued_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'synthetic:wrong-context', JSON_ARRAY('synthetic:capability'), 'ACTIVE', ?, 1)`,
        [uuid('synthetic:auth-wrong-onboarding-context'), tenants.get('synthetic:tenant-one-waba'), alternateAppId, alternateAppConfig.environment, onboardingId, alternateAppConfig.flowVariant, alternateAppConfig.authVariant, fixedSqlNow],
      ),
      (error) => error.code === 'ER_NO_REFERENCED_ROW_2',
    );
    await assert.rejects(
      db.execute(
        `INSERT INTO m105_meta_credential (id, tenant_id, authorization_id, family, issuer, app_config_id, environment, ciphertext, key_version, scopes_snapshot, authorization_version, health, observed_source, version)
         VALUES (?, ?, ?, 'synthetic:family', 'synthetic:issuer', ?, ?, ?, 'synthetic:key', JSON_ARRAY('synthetic:capability'), 1, 'UNKNOWN', 'synthetic:test', 1)`,
        [uuid('synthetic:credential-wrong-app-context'), tenants.get('synthetic:tenant-one-waba'), auth.id, alternateAppId, alternateAppConfig.environment, Buffer.from('synthetic-ciphertext-fixture')],
      ),
      (error) => error.code === 'ER_NO_REFERENCED_ROW_2',
    );
    await assert.rejects(
      db.execute(
        `INSERT INTO m105_meta_credential (id, tenant_id, authorization_id, family, issuer, app_config_id, environment, ciphertext, key_version, scopes_snapshot, authorization_version, health, observed_source, version)
         VALUES (?, ?, ?, 'synthetic:family', 'synthetic:issuer', ?, 'synthetic:wrong-environment', ?, 'synthetic:key', JSON_ARRAY('synthetic:capability'), 1, 'UNKNOWN', 'synthetic:test', 1)`,
        [uuid('synthetic:credential-wrong-environment'), tenants.get('synthetic:tenant-one-waba'), auth.id, appId, Buffer.from('synthetic-ciphertext-fixture')],
      ),
      (error) => error.code === 'ER_NO_REFERENCED_ROW_2',
    );
    await assert.rejects(
      db.execute(
        `INSERT INTO m105_asset_authorization (id, tenant_id, authorization_id, asset_id, app_config_id, environment, capabilities, status, version)
         VALUES (?, ?, ?, ?, ?, ?, JSON_ARRAY('synthetic:capability'), 'VERIFIED', 1)`,
        [uuid('synthetic:grant-wrong-auth-app'), tenants.get('synthetic:tenant-one-waba'), auth.id, assets.get('synthetic:number-04'), alternateAppId, alternateAppConfig.environment],
      ),
      (error) => error.code === 'ER_NO_REFERENCED_ROW_2',
    );
    await assert.rejects(
      db.execute(
        `INSERT INTO m105_asset_authorization (id, tenant_id, authorization_id, asset_id, app_config_id, environment, capabilities, status, version)
         VALUES (?, ?, ?, ?, ?, ?, JSON_ARRAY('synthetic:capability'), 'VERIFIED', 1)`,
        [uuid('synthetic:grant-wrong-asset-app'), tenants.get('synthetic:tenant-one-waba'), auth.id, assets.get('synthetic:alternate-profile-asset'), appId, fixture.appConfig.environment],
      ),
      (error) => error.code === 'ER_NO_REFERENCED_ROW_2',
    );
    await assert.rejects(
      db.execute(
        `INSERT INTO m105_webhook_subscription (id, tenant_id, app_config_id, environment, target_asset_id, desired_fields, state, observed_status, observed_source, version)
         VALUES (?, ?, ?, ?, ?, JSON_ARRAY('synthetic:field'), 'DESIRED', 'UNKNOWN', 'synthetic:test', 1)`,
        [uuid('synthetic:subscription-wrong-asset-app'), tenants.get('synthetic:tenant-one-waba'), alternateAppId, alternateAppConfig.environment, assets.get('synthetic:waba-one')],
      ),
      (error) => error.code === 'ER_NO_REFERENCED_ROW_2',
    );
    await assert.rejects(
      db.execute(
        `INSERT INTO m105_asset_relation (id, tenant_id, app_config_id, environment, parent_asset_id, child_asset_id, relation_kind, observed_source, version)
         VALUES (?, ?, ?, ?, ?, ?, 'CONTAINS', 'synthetic:test', 1)`,
        [uuid('synthetic:relation-wrong-profile'), tenants.get('synthetic:tenant-one-waba'), appId, fixture.appConfig.environment, assets.get('synthetic:alternate-profile-asset'), assets.get('synthetic:number-01')],
      ),
      (error) => error.code === 'ER_NO_REFERENCED_ROW_2',
    );
    await assert.rejects(
      db.execute(
        `INSERT INTO m105_meta_asset (id, tenant_id, app_config_id, provider, environment, kind, external_id, observed_status, observed_source, version)
         VALUES (?, ?, ?, 'synthetic:wrong-provider', ?, 'PHONE_NUMBER', 'synthetic:wrong-provider-asset', 'UNKNOWN', 'synthetic:test', 1)`,
        [uuid('synthetic:asset-wrong-provider-app'), tenants.get('synthetic:tenant-one-waba'), appId, fixture.appConfig.environment],
      ),
      (error) => error.code === 'ER_NO_REFERENCED_ROW_2',
    );
  });

  await record('AC02.tenant-query', async () => {
    const [rows] = await db.execute(
      'SELECT id FROM m105_meta_asset WHERE tenant_id = ? AND id = ?',
      [tenants.get('synthetic:tenant-two-waba'), assets.get('synthetic:number-01')],
    );
    assert.equal(rows.length, 0);
  });

  await record('AC02.route-quarantine', async () => {
    const original = assetOwners.get('synthetic:number-01');
    const conflictId = uuid('synthetic:conflicting-tenant-asset');
    const otherTenant = tenants.get('synthetic:tenant-two-waba');
    await db.execute(
      `INSERT INTO m105_meta_asset (id, tenant_id, app_config_id, provider, environment, kind, external_id, observed_status, observed_source, observed_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'UNKNOWN', 'synthetic:conflict-fixture', NULL, 1)`,
      [conflictId, otherTenant, appId, fixture.provider, fixture.appConfig.environment, original.kind, original.externalId],
    );
    await assert.rejects(
      db.execute(
        `INSERT INTO m105_asset_route_claim (id, provider, app_config_id, environment, kind, external_id, tenant_id, asset_id, claimed_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [uuid('synthetic:conflicting-route-claim'), fixture.provider, appId, fixture.appConfig.environment, original.kind, original.externalId, otherTenant, conflictId, fixedSqlNow],
      ),
      (error) => error.code === 'ER_DUP_ENTRY',
    );
    const [claim] = await db.execute(
      `SELECT tenant_id, asset_id FROM m105_asset_route_claim WHERE provider = ? AND app_config_id = ? AND environment = ? AND kind = ? AND external_id = ?`,
      [fixture.provider, appId, fixture.appConfig.environment, original.kind, original.externalId],
    );
    assert.equal(claim.length, 1, 'the privileged route index has at most one tenant-scoped target');
    assert.equal(claim[0].tenant_id, original.tenantId);
    assert.equal(claim[0].asset_id, assets.get('synthetic:number-01'));
    const mismatchAssetId = uuid('synthetic:route-identity-mismatch-asset');
    await db.execute(
      `INSERT INTO m105_meta_asset (id, tenant_id, app_config_id, provider, environment, kind, external_id, observed_status, observed_source, observed_at, version)
       VALUES (?, ?, ?, ?, ?, 'PHONE_NUMBER', 'synthetic:route-identity-asset', 'UNKNOWN', 'synthetic:negative-test', NULL, 1)`,
      [mismatchAssetId, original.tenantId, appId, fixture.provider, fixture.appConfig.environment],
    );
    await assert.rejects(
      db.execute(
        `INSERT INTO m105_asset_route_claim (id, provider, app_config_id, environment, kind, external_id, tenant_id, asset_id, claimed_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [uuid('synthetic:mismatched-route-identity'), fixture.provider, appId, fixture.appConfig.environment, 'PHONE_NUMBER', 'synthetic:route-identity-asset:wrong', original.tenantId, mismatchAssetId, fixedSqlNow],
      ),
      (error) => error.code === 'ER_NO_REFERENCED_ROW_2',
    );
    await db.execute('DELETE FROM m105_meta_asset WHERE id = ? AND tenant_id = ?', [mismatchAssetId, original.tenantId]);
    const inboxId = uuid('synthetic:route-conflict-inbox');
    await db.execute(
      `INSERT INTO m105_inbox_event (id, app_config_id, provider_event_id, schema_version, received_at, signature_state, raw_ref, route_state, version)
       VALUES (?, ?, 'synthetic:event-route-conflict', 1, ?, 'VERIFIED_TEST_ONLY', NULL, 'PENDING', 1)`,
      [inboxId, appId, fixedSqlNow],
    );
    await db.execute(
      `INSERT INTO m105_routed_event (id, inbox_event_id, app_config_id, item_key, tenant_id, asset_id, route_state, processing_version, version)
       VALUES (?, ?, ?, 'synthetic:item-conflict', NULL, NULL, 'QUARANTINED', 1, 1)`,
      [uuid('synthetic:quarantine-item'), inboxId, appId],
    );
    await assert.rejects(
      db.execute(
        `INSERT INTO m105_routed_event (id, inbox_event_id, app_config_id, item_key, tenant_id, asset_id, route_state, processing_version, version)
         VALUES (?, ?, ?, 'synthetic:item-wrong-inbox-app', NULL, NULL, 'QUARANTINED', 1, 1)`,
        [uuid('synthetic:routed-event-wrong-inbox-app'), inboxId, alternateAppId],
      ),
      (error) => error.code === 'ER_NO_REFERENCED_ROW_2',
    );
    await assert.rejects(
      db.execute(
        `INSERT INTO m105_routed_event (id, inbox_event_id, app_config_id, item_key, tenant_id, asset_id, route_state, processing_version, version)
         VALUES (?, ?, ?, 'synthetic:item-wrong-target-app', ?, ?, 'ROUTED', 1, 1)`,
        [uuid('synthetic:routed-event-wrong-target-app'), inboxId, appId, original.tenantId, assets.get('synthetic:alternate-profile-asset')],
      ),
      (error) => error.code === 'ER_NO_REFERENCED_ROW_2',
    );
    const [routed] = await db.execute('SELECT tenant_id, asset_id, route_state FROM m105_routed_event WHERE inbox_event_id = ?', [inboxId]);
    assert.equal(routed[0].tenant_id, null);
    assert.equal(routed[0].asset_id, null);
    assert.equal(routed[0].route_state, 'QUARANTINED');
  });

  await record('AC03.transitions-readiness', async () => {
    const onboarding = onboardings.get('synthetic:auth-one-number-03-initial');
    const sequence = ['AWAITING_PROVIDER', 'CODE_RECEIVED', 'EXCHANGING', 'ASSETS_VERIFIED', 'PROVISIONING'];
    assert.equal(canTransition('CREATED', 'CODE_RECEIVED'), false);
    let previous = 'CREATED';
    let version = 1;
    for (const next of sequence) {
      assert.equal(canTransition(previous, next), true);
      const [result] = await db.execute(
        'UPDATE m105_onboarding_session SET status = ?, version = version + 1 WHERE id = ? AND tenant_id = ? AND status = ? AND version = ?',
        [next, onboarding.id, onboarding.tenantId, previous, version],
      );
      assert.equal(result.affectedRows, 1);
      previous = next;
      version += 1;
    }
    const readyPolicy = { version: 2, required: ['SEND_MESSAGE'], optional: ['HISTORY_SYNC'], requested: [] };
    const missingRequired = deriveReadiness({ policy: readyPolicy, evidence: { SEND_MESSAGE: { status: 'UNKNOWN', observedAt: null } }, now: fixedNow, maxAgeMs: 60_000 });
    assert.equal(missingRequired.status, 'PARTIAL');
    assert.equal(canTransition('PROVISIONING', 'PARTIAL', { readiness: missingRequired }), true);
    assert.equal(canTransition('PROVISIONING', 'READY', { readiness: missingRequired }), false, 'missing required evidence cannot transition to READY');
    assert.equal(canTransition('PROVISIONING', 'READY', { readiness: { status: 'READY', reasons: [], policyVersion: 2 } }), false, 'a freely asserted READY status is not a derived evaluation');
    const [partialTransition] = await db.execute(
      `UPDATE m105_onboarding_session SET status = 'PARTIAL', readiness_policy_version = ?, readiness_reasons = ?, readiness_evaluated_at = ?, version = version + 1
       WHERE id = ? AND tenant_id = ? AND status = 'PROVISIONING' AND version = ?`,
      [missingRequired.policyVersion, JSON.stringify(missingRequired.reasons), fixedSqlNow, onboarding.id, onboarding.tenantId, version],
    );
    assert.equal(partialTransition.affectedRows, 1);
    version += 1;
    const [partialRows] = await db.execute('SELECT status, readiness_policy_version, readiness_reasons FROM m105_onboarding_session WHERE id = ?', [onboarding.id]);
    assert.equal(partialRows[0].status, 'PARTIAL');
    assert.equal(Number(partialRows[0].readiness_policy_version), 2);
    assert.deepEqual(jsonValue(partialRows[0].readiness_reasons), missingRequired.reasons);
    assert.equal(canTransition('PARTIAL', 'READY'), false, 'PARTIAL cannot jump directly to READY');
    assert.equal(canTransition('PARTIAL', 'PROVISIONING'), false, 'partial recovery needs a server job and a new policy evaluation');
    assert.equal(canTransition('CREATED', 'CANCELLED'), true);
    assert.equal(canTransition('AWAITING_PROVIDER', 'EXPIRED'), true);
    assert.equal(canTransition('EXCHANGING', 'FAILED'), true);
    assert.equal(canTransition('AWAITING_PROVIDER', 'FAILED'), false);
    const retryStep = uuid('synthetic:onboarding-step-safe-error');
    await db.execute(
      `INSERT INTO m105_onboarding_step (id, tenant_id, onboarding_id, step_name, attempt, status, safe_error_code, retryable, started_at, finished_at, evidence_ref, version)
       VALUES (?, ?, ?, 'exchange', 1, 'RETRY_PENDING', 'EXCHANGE_UNKNOWN', TRUE, ?, ?, 'synthetic:diagnostic-ref', 1)`,
      [retryStep, onboarding.tenantId, onboarding.id, fixedSqlNow, fixedSqlNow],
    );
    const [stepRows] = await db.execute('SELECT safe_error_code, retryable, evidence_ref FROM m105_onboarding_step WHERE id = ?', [retryStep]);
    assert.equal(stepRows[0].safe_error_code, 'EXCHANGE_UNKNOWN');
    assert.equal(Boolean(stepRows[0].retryable), true);
    assert.equal(stepRows[0].evidence_ref, 'synthetic:diagnostic-ref');
    const optionalUnknownNotRequested = deriveReadiness({
      policy: readyPolicy,
      evidence: { SEND_MESSAGE: { status: 'VERIFIED', observedAt: new Date(fixedNow).toISOString() }, HISTORY_SYNC: { status: 'UNKNOWN' } },
      now: fixedNow,
      maxAgeMs: 60_000,
    });
    assert.equal(optionalUnknownNotRequested.status, 'READY');
    assert.equal(optionalUnknownNotRequested.policyVersion, 2);
    assert.equal(canTransition('PROVISIONING', 'READY', { readiness: optionalUnknownNotRequested }), true, 'an unrequested optional capability does not block a derived READY result');
    const optionalRequested = deriveReadiness({
      policy: { ...readyPolicy, requested: ['HISTORY_SYNC'] },
      evidence: { SEND_MESSAGE: { status: 'VERIFIED', observedAt: new Date(fixedNow).toISOString() }, HISTORY_SYNC: { status: 'UNKNOWN', observedAt: null } },
      now: fixedNow,
      maxAgeMs: 60_000,
    });
    assert.equal(optionalRequested.status, 'PARTIAL');
    assert.equal(canTransition('PROVISIONING', 'READY', { readiness: optionalRequested }), false, 'a missing requested optional capability cannot transition to READY');
    const evaluated = deriveReadiness({
      policy: readyPolicy,
      evidence: { SEND_MESSAGE: { status: 'VERIFIED', observedAt: new Date(fixedNow).toISOString() } },
      now: fixedNow,
      maxAgeMs: 60_000,
    });
    assert.equal(evaluated.status, 'READY');
    assert.equal(canTransition('PROVISIONING', 'READY', { readiness: evaluated }), true);
    const recoveryJobId = uuid('synthetic:partial-recovery-job');
    const recoveryStepId = uuid('synthetic:onboarding-step-recovery');
    await db.beginTransaction();
    try {
      await db.execute(
        `INSERT INTO m105_sync_job (id, tenant_id, onboarding_id, job_type, payload_version, idempotency_key, attempt, next_run_at, lease_owner, lease_expires_at, status, safe_error, version)
         VALUES (?, ?, ?, 'ONBOARDING_RECOVERY', 1, 'synthetic:partial-recovery-v1', 1, ?, 'synthetic:worker', ?, 'RUNNING', NULL, 1)`,
        [recoveryJobId, onboarding.tenantId, onboarding.id, fixedSqlNow, '2026-10-28 12:05:00.000000'],
      );
      assert.equal(canTransition('PARTIAL', 'PROVISIONING', { recoveryJobId, readiness: evaluated }), true);
      await db.execute(
        `INSERT INTO m105_onboarding_step (id, tenant_id, onboarding_id, step_name, attempt, status, safe_error_code, retryable, started_at, finished_at, evidence_ref, version)
         VALUES (?, ?, ?, 'provisioning', 2, 'RUNNING', NULL, FALSE, ?, NULL, 'synthetic:recovery-evidence', 1)`,
        [recoveryStepId, onboarding.tenantId, onboarding.id, fixedSqlNow],
      );
      await insertAuditEvent(db, {
        id: uuid('synthetic:audit-recovery-start'),
        tenantId: onboarding.tenantId,
        actorRef: 'synthetic:worker',
        action: 'ONBOARDING_RECOVERY_STARTED',
        targetRef: 'synthetic:onboarding-number-03',
        correlationId: uuid('synthetic:recovery-correlation'),
        safeDiff: { before: 'PARTIAL', after: 'PROVISIONING', policyVersion: evaluated.policyVersion },
        createdAt: fixedSqlNow,
        retentionClass: 'synthetic:short-retention',
      });
      const [recovery] = await db.execute(
        `UPDATE m105_onboarding_session session SET status = 'PROVISIONING', version = version + 1
         WHERE session.id = ? AND session.tenant_id = ? AND session.status = 'PARTIAL' AND session.version = ?
         AND EXISTS (SELECT 1 FROM m105_sync_job job WHERE job.tenant_id = session.tenant_id AND job.onboarding_id = session.id AND job.id = ? AND job.job_type = 'ONBOARDING_RECOVERY' AND job.status = 'RUNNING')`,
        [onboarding.id, onboarding.tenantId, version, recoveryJobId],
      );
      assert.equal(recovery.affectedRows, 1);
      await db.commit();
    } catch (error) {
      await db.rollback();
      throw error;
    }
    version += 1;
    assert.equal(canTransition('PROVISIONING', 'READY', { readiness: evaluated }), true, 'the readiness derivation is the gate input before the READY write');
    const [readyUpdate] = await db.execute(
      `UPDATE m105_onboarding_session SET status = 'READY', readiness_policy_version = ?, readiness_reasons = ?, readiness_evaluated_at = ?, version = version + 1
       WHERE id = ? AND tenant_id = ? AND status = 'PROVISIONING' AND version = ?`,
      [evaluated.policyVersion, JSON.stringify(evaluated.reasons), fixedSqlNow, onboarding.id, onboarding.tenantId, version],
    );
    assert.equal(readyUpdate.affectedRows, 1);
    await db.execute('UPDATE m105_sync_job SET status = \'SUCCEEDED\', lease_expires_at = NULL, version = version + 1 WHERE id = ? AND status = \'RUNNING\'', [recoveryJobId]);
    await db.execute('UPDATE m105_onboarding_step SET status = \'SUCCEEDED\', finished_at = ?, version = version + 1 WHERE id = ? AND status = \'RUNNING\'', [fixedSqlNow, recoveryStepId]);
    const [readyRows] = await db.execute('SELECT status, readiness_policy_version, readiness_reasons FROM m105_onboarding_session WHERE id = ?', [onboarding.id]);
    assert.equal(readyRows[0].status, 'READY');
    assert.equal(Number(readyRows[0].readiness_policy_version), 2);
    assert.deepEqual(jsonValue(readyRows[0].readiness_reasons), []);
  });

  await record('AC03.independent-states', async () => {
    const [rows] = await db.execute(
      `SELECT a.observed_status AS asset_state, c.health AS credential_state, s.observed_status AS subscription_state
       FROM m105_meta_asset a
       JOIN m105_asset_authorization aa ON aa.tenant_id = a.tenant_id AND aa.asset_id = a.id
       JOIN m105_meta_credential c ON c.tenant_id = aa.tenant_id AND c.authorization_id = aa.authorization_id
       JOIN m105_webhook_subscription s ON s.tenant_id = a.tenant_id
       WHERE a.id = ? LIMIT 1`,
      [assets.get('synthetic:number-01')],
    );
    assert.equal(rows[0].asset_state, 'UNKNOWN');
    assert.equal(rows[0].credential_state, 'UNKNOWN');
    assert.equal(rows[0].subscription_state, 'UNKNOWN');
  });

  await record('AC04.selective-revoke-tombstone', async () => {
    const tenantId = tenants.get('synthetic:tenant-one-waba');
    const oldAuth = authorizations.get('synthetic:auth-one-number-01');
    const newAuth = authorizations.get('synthetic:auth-one-reauth-number-03');
    const n1 = assets.get('synthetic:number-01');
    const n2 = assets.get('synthetic:number-02');
    const n3 = assets.get('synthetic:number-03');
    const [revoked] = await db.execute(
      `UPDATE m105_asset_authorization SET status = 'REVOKED', revoked_at = ?, version = version + 1
       WHERE tenant_id = ? AND authorization_id = ? AND asset_id = ? AND status = 'VERIFIED'`,
      [fixedSqlNow, tenantId, oldAuth.id, n1],
    );
    assert.equal(revoked.affectedRows, 1);
    const [survivors] = await db.execute(
      `SELECT COUNT(*) AS count FROM m105_asset_authorization WHERE tenant_id = ? AND status = 'VERIFIED' AND asset_id IN (?, ?)`,
      [tenantId, n2, n3],
    );
    assert.equal(Number(survivors[0].count), 3, 'number-02 remains linked and number-03 retains both valid auth links');
    const [auths] = await db.execute('SELECT status FROM m105_meta_authorization WHERE tenant_id = ? AND id IN (?, ?)', [tenantId, oldAuth.id, newAuth.id]);
    assert.equal(auths.filter((row) => row.status === 'ACTIVE').length, 2, 'one asset grant revocation does not revoke either authorization');

    const priorN3Auth = authorizations.get('synthetic:auth-one-number-03-initial');
    const priorN3Credential = credentials.get('synthetic:credential-one-number-03-initial');
    await db.execute('UPDATE m105_meta_authorization SET status = \'REVOKED\', revoked_at = ?, version = version + 1 WHERE tenant_id = ? AND id = ? AND status = \'ACTIVE\'', [fixedSqlNow, tenantId, priorN3Auth.id]);
    await db.execute('UPDATE m105_asset_authorization SET status = \'REVOKED\', revoked_at = ?, version = version + 1 WHERE tenant_id = ? AND authorization_id = ? AND status = \'VERIFIED\'', [fixedSqlNow, tenantId, priorN3Auth.id]);
    await db.execute('UPDATE m105_meta_credential SET health = \'REVOKED\', observed_source = \'synthetic:explicit-revocation\', observed_at = ?, version = version + 1 WHERE tenant_id = ? AND id = ?', [fixedSqlNow, tenantId, priorN3Credential.id]);
    const [survivingReauth] = await db.execute(
      `SELECT auth.status AS authorization_state, grant_link.status AS grant_state, credential.health AS credential_state
       FROM m105_meta_authorization auth
       JOIN m105_asset_authorization grant_link ON grant_link.tenant_id = auth.tenant_id AND grant_link.authorization_id = auth.id
       JOIN m105_meta_credential credential ON credential.tenant_id = auth.tenant_id AND credential.authorization_id = auth.id
       WHERE auth.tenant_id = ? AND auth.id = ? AND grant_link.asset_id = ?`,
      [tenantId, newAuth.id, n3],
    );
    assert.equal(survivingReauth[0].authorization_state, 'ACTIVE');
    assert.equal(survivingReauth[0].grant_state, 'VERIFIED');
    assert.equal(survivingReauth[0].credential_state, 'UNKNOWN', 'revoking the old authorization does not change the new authorization credential');

    const aggregate = n1;
    await db.execute(
      `INSERT INTO m105_projection_checkpoint (tenant_id, destination_ref, aggregate_id, source_version, projection_schema_version, applied_at, tombstone_version, status, version)
       VALUES (?, 'synthetic:destination', ?, 8, 1, ?, 8, 'TOMBSTONED', 1)`,
      [tenantId, aggregate, fixedSqlNow],
    );
    const [staleApply] = await db.execute(
      `UPDATE m105_projection_checkpoint SET source_version = 7, status = 'CURRENT', tombstone_version = 0, version = version + 1
       WHERE tenant_id = ? AND destination_ref = 'synthetic:destination' AND aggregate_id = ? AND source_version < 7 AND tombstone_version < 7`,
      [tenantId, aggregate],
    );
    assert.equal(staleApply.affectedRows, 0);
    const [checkpoint] = await db.execute('SELECT source_version, tombstone_version, status FROM m105_projection_checkpoint WHERE tenant_id = ? AND destination_ref = ? AND aggregate_id = ?', [tenantId, 'synthetic:destination', aggregate]);
    assert.equal(Number(checkpoint[0].source_version), 8);
    assert.equal(Number(checkpoint[0].tombstone_version), 8);
    assert.equal(checkpoint[0].status, 'TOMBSTONED');
  });

  await record('AC05.unknown-stale', async () => {
    assert.equal(isObservationStale(null, fixedNow, 60_000), true);
    assert.equal(isObservationStale('2026-10-28T11:00:00.000Z', fixedNow, 60_000), true);
    const [asset] = await db.execute('SELECT observed_status, observed_source, observed_at FROM m105_meta_asset WHERE id = ?', [assets.get('synthetic:number-04')]);
    assert.deepEqual(asset[0], { observed_status: 'UNKNOWN', observed_source: 'synthetic:fixture', observed_at: null });
    const [credential] = await db.execute('SELECT health, expires_at, observed_source, observed_at FROM m105_meta_credential WHERE id = ?', [credentials.get('synthetic:credential-one-number-01').id]);
    assert.equal(credential[0].health, 'UNKNOWN');
    assert.equal(credential[0].expires_at, null, 'unknown expiry is not treated as never-expiring');
    assert.equal(credential[0].observed_at, null);
  });

  await record('AC05.inbox-outbox-replay', async () => {
    const inboxId = uuid('synthetic:shared-batch-inbox');
    await db.execute(
      `INSERT INTO m105_inbox_event (id, app_config_id, provider_event_id, schema_version, received_at, signature_state, raw_ref, route_state, version)
       VALUES (?, ?, 'synthetic:batch-01', 1, ?, 'VERIFIED_TEST_ONLY', NULL, 'PENDING', 1)`,
      [inboxId, appId, fixedSqlNow],
    );
    const routes = [
      { item: 'synthetic:item-tenant-a', tenant: tenants.get('synthetic:tenant-one-waba'), asset: assets.get('synthetic:number-01') },
      { item: 'synthetic:item-tenant-b', tenant: tenants.get('synthetic:tenant-two-waba'), asset: assets.get('synthetic:number-11') },
    ];
    for (const route of routes) {
      await db.execute(
        `INSERT INTO m105_routed_event (id, inbox_event_id, app_config_id, item_key, tenant_id, asset_id, route_state, processing_version, version)
         VALUES (?, ?, ?, ?, ?, ?, 'ROUTED', 1, 1)`,
        [uuid(route.item), inboxId, appId, route.item, route.tenant, route.asset],
      );
    }
    await assert.rejects(
      db.execute(
        `INSERT INTO m105_routed_event (id, inbox_event_id, app_config_id, item_key, tenant_id, asset_id, route_state, processing_version, version)
         VALUES (?, ?, ?, ?, ?, ?, 'ROUTED', 1, 1)`,
        [uuid('synthetic:duplicate-route'), inboxId, appId, routes[0].item, routes[0].tenant, routes[0].asset],
      ),
      (error) => error.code === 'ER_DUP_ENTRY',
    );
    await db.execute('UPDATE m105_routed_event SET route_state = ?, processing_version = processing_version + 1, version = version + 1 WHERE inbox_event_id = ? AND item_key = ?', ['PROCESSED', inboxId, routes[0].item]);
    const [items] = await db.execute('SELECT item_key, tenant_id, route_state FROM m105_routed_event WHERE inbox_event_id = ? ORDER BY item_key', [inboxId]);
    assert.equal(items.length, 2, 'duplicate item did not create a third delivery, while another item stays independently routed');
    assert.equal(items.filter((row) => row.route_state === 'PROCESSED').length, 1);

    const tenantId = tenants.get('synthetic:tenant-one-waba');
    const assetId = assets.get('synthetic:number-01');
    const idempotencyKey = 'synthetic:outbox-reauth-audit-v1';
    await db.beginTransaction();
    try {
      await db.execute('UPDATE m105_meta_asset SET version = version + 1 WHERE tenant_id = ? AND id = ? AND version = 1', [tenantId, assetId]);
      await db.execute(
        `INSERT INTO m105_outbox_event (id, tenant_id, aggregate_id, aggregate_asset_id, aggregate_version, schema_version, event_type, idempotency_key, payload, created_at, delivery_state, attempt, version)
         VALUES (?, ?, ?, ?, 2, 1, 'synthetic:grant.changed', ?, ?, ?, 'PENDING', 0, 1)`,
        [uuid('synthetic:outbox-event'), tenantId, assetId, assetId, idempotencyKey, JSON.stringify({ status: 'REVOKED', version: 2 }), fixedSqlNow],
      );
      await db.commit();
    } catch (error) {
      await db.rollback();
      throw error;
    }
    const [atomic] = await db.execute('SELECT a.version AS aggregate_version, o.aggregate_version AS outbox_version FROM m105_meta_asset a JOIN m105_outbox_event o ON o.tenant_id = a.tenant_id AND o.aggregate_asset_id = a.id WHERE a.tenant_id = ? AND a.id = ?', [tenantId, assetId]);
    assert.equal(Number(atomic[0].aggregate_version), 2);
    assert.equal(Number(atomic[0].outbox_version), 2, 'aggregate revision and outbox intent commit in the same local transaction');
    await assert.rejects(
      db.execute(
        `INSERT INTO m105_outbox_event (id, tenant_id, aggregate_id, aggregate_asset_id, aggregate_version, schema_version, event_type, idempotency_key, payload, created_at, delivery_state, attempt, version)
         VALUES (?, ?, ?, ?, 1, 1, 'synthetic:grant.changed', ?, ?, ?, 'PENDING', 0, 1)`,
        [uuid('synthetic:outbox-replay'), tenantId, assetId, assetId, idempotencyKey, JSON.stringify({ status: 'REVOKED', version: 2 }), fixedSqlNow],
      ),
      (error) => error.code === 'ER_DUP_ENTRY',
    );
    const [outbox] = await db.execute('SELECT idempotency_key, payload FROM m105_outbox_event WHERE tenant_id = ? AND idempotency_key = ?', [tenantId, idempotencyKey]);
    assert.equal(outbox.length, 1);
    const parsed = jsonValue(outbox[0].payload);
    assert.deepEqual(parsed, { status: 'REVOKED', version: 2 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await db.execute(
        `INSERT INTO m105_test_effect_sink (idempotency_key, applied_count, delivery_attempts) VALUES (?, 1, 1)
         ON DUPLICATE KEY UPDATE applied_count = applied_count, delivery_attempts = delivery_attempts + 1`,
        [outbox[0].idempotency_key],
      );
    }
    const [effect] = await db.execute('SELECT applied_count, delivery_attempts FROM m105_test_effect_sink WHERE idempotency_key = ?', [idempotencyKey]);
    assert.equal(Number(effect[0].applied_count), 1);
    assert.equal(Number(effect[0].delivery_attempts), 2, 'replay was attempted twice but the local synthetic effect applied once');
  });

  await record('AC05.monotonic-checkpoint', async () => {
    const [rows] = await db.execute('SELECT source_version, tombstone_version, status FROM m105_projection_checkpoint WHERE status = \'TOMBSTONED\' LIMIT 1');
    assert.equal(Number(rows[0].source_version), 8);
    assert.equal(Number(rows[0].tombstone_version), 8);
    assert.equal(rows[0].status, 'TOMBSTONED');
  });

  await record('AC05.audit-redaction', async () => {
    const tenantId = tenants.get('synthetic:tenant-one-waba');
    const marker = 'M105_SECRET_MARKER_MUST_NOT_APPEAR';
    assert.throws(
      () => validateAuditDiff({ before: 'VERIFIED', after: 'REVOKED', accessToken: marker }),
      /not allowlisted/,
      'secret-bearing diff fields are rejected before database insertion',
    );
    assert.throws(() => validateAuditDiff({ before: marker }), /invalid before/, 'free-form secret-like status values are rejected');
    await insertAuditEvent(db, {
      id: uuid('synthetic:audit-revoke'),
      tenantId,
      actorRef: 'synthetic:operator',
      action: 'ASSET_GRANT_REVOKED',
      targetRef: 'synthetic:number-01',
      correlationId: uuid('synthetic:audit-correlation'),
      safeDiff: { before: 'VERIFIED', after: 'REVOKED' },
      createdAt: fixedSqlNow,
      retentionClass: 'synthetic:short-retention',
    });
    const [rows] = await db.execute('SELECT safe_diff FROM m105_audit_event WHERE id = ?', [uuid('synthetic:audit-revoke')]);
    const serialized = JSON.stringify(jsonValue(rows[0].safe_diff));
    assert.equal(serialized.includes(marker), false);
    assert.deepEqual(JSON.parse(serialized), { before: 'VERIFIED', after: 'REVOKED' });
  });

  const [counts] = await db.execute(
    `SELECT
      (SELECT COUNT(*) FROM m105_tenant) AS tenants,
      (SELECT COUNT(*) FROM m105_meta_asset) AS assets,
      (SELECT COUNT(*) FROM m105_meta_authorization) AS authorizations,
      (SELECT COUNT(*) FROM m105_meta_credential) AS credentials,
      (SELECT COUNT(*) FROM m105_routed_event) AS routed_items,
      (SELECT COUNT(*) FROM m105_outbox_event) AS outbox_events`,
  );
  console.log(`SUMMARY tenants=${counts[0].tenants} assets=${counts[0].assets} authorizations=${counts[0].authorizations} credentials=${counts[0].credentials} routed-items=${counts[0].routed_items} outbox-events=${counts[0].outbox_events} meta-calls=0 production-writes=0`);
  console.log('M1.05 MariaDB domain harness PASS');
} catch (error) {
  console.error(`M1.05 MariaDB domain harness FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (db) await db.end();
}
