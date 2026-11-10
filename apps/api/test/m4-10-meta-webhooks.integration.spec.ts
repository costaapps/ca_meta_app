import assert from 'node:assert/strict';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { test } from 'node:test';
import { validateEnvironment } from '../src/config/environment.js';
import { deployMigrations } from '../src/database/migrations/migration-runner.js';
import { readMigrationEnvironment } from '../src/database/migrations/migration-environment.js';
import { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import type { MetaAppConfiguration } from '../src/meta-config/meta-app-config.configuration.js';
import { MetaWebhookRepository } from '../src/meta-webhooks/meta-webhook.repository.js';
import { MetaWebhookReplayService } from '../src/meta-webhooks/meta-webhook-replay.service.js';
import { parseMetaWebhookDelivery } from '../src/meta-webhooks/meta-webhook-validation.js';
import type {
  MetaWebhookApplication,
  MetaWebhookPayloadProtector,
  ProtectedMetaWebhookPayload,
} from '../src/meta-webhooks/meta-webhook.types.js';

const enabled = process.env.M4_10_MARIADB_TEST === '1';
const migrationTimestamp = '2026-11-01 12:00:00.000000';
const syntheticKey = randomBytes(32);

class SyntheticPayloadProtector implements MetaWebhookPayloadProtector {
  async protect(input: Parameters<MetaWebhookPayloadProtector['protect']>[0]): Promise<ProtectedMetaWebhookPayload> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', syntheticKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(input.rawBody), cipher.final()]);
    return {
      reference: input.reference,
      keyReference: 'm4-10-synthetic-payload-protector',
      nonce,
      authenticationTag: cipher.getAuthTag(),
      ciphertext,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    };
  }

  async unprotect(payload: ProtectedMetaWebhookPayload): Promise<Buffer> {
    if (Date.parse(payload.expiresAt) <= Date.now()) throw new Error('Synthetic payload expired.');
    const decipher = createDecipheriv('aes-256-gcm', syntheticKey, payload.nonce);
    decipher.setAuthTag(payload.authenticationTag);
    return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
  }
}

function providerAppId(): string {
  const suffix = randomBytes(5).readUInt32BE(1) % 100_000;
  return `${Date.now()}${String(suffix).padStart(5, '0')}`;
}

function statusEnvelope(input: {
  readonly phoneNumberId: string;
  readonly messageId: string;
  readonly recipientId: string;
  readonly statuses: readonly { readonly status: string; readonly timestamp: string }[];
}): Buffer {
  return Buffer.from(JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: `synthetic-waba-${input.phoneNumberId}`,
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: input.phoneNumberId },
          statuses: input.statuses.map((value) => ({
            id: input.messageId,
            recipient_id: input.recipientId,
            status: value.status,
            timestamp: value.timestamp,
          })),
        },
      }],
    }],
  }), 'utf8');
}

function webhookProfile(
  providerAppIdValue: string,
  configurationRef = 'm4-10-synthetic-profile',
  flowVariant: MetaAppConfiguration['flowVariant'] = 'WHATSAPP_EXCLUSIVE',
): MetaAppConfiguration {
  return {
    configurationRef,
    environment: 'test',
    flowVariant,
    authVariant: flowVariant === 'WHATSAPP_COEXISTENCE' ? 'WHATSAPP_BUSINESS_APP_ONBOARDING' : 'WHATSAPP_EMBEDDED_SIGNUP',
    providerAppIdRef: 'm4-10-synthetic-provider-app',
    providerAppId: providerAppIdValue,
    appMode: 'DEVELOPMENT',
    appDomain: 'm4-10.synthetic.invalid',
    callbackUri: 'https://m4-10.synthetic.invalid/callback',
    redirectAllowlist: ['https://m4-10.synthetic.invalid'],
    appSecretRef: 'vault://meta-app/test/m4-10-synthetic/app-secret',
    tokenConfigurationRef: 'vault://meta-app/test/m4-10-synthetic/token',
    capabilityManifestVersion: 'v1',
    enabled: true,
    versions: { graphApi: { value: 'v25.0', status: 'NOT_CONFIRMED' } },
    capabilityEvidence: [],
  };
}

class RecordingMetaWebhookRepository extends MetaWebhookRepository {
  readonly replayConfigurationRefs: string[] = [];

  override async replayQuarantined(input: Parameters<MetaWebhookRepository['replayQuarantined']>[0]) {
    this.replayConfigurationRefs.push(input.application.configurationRef);
    return super.replayQuarantined(input);
  }
}

test('M4.10 MariaDB webhook routes, quarantine replay, status serialization and fencing are tenant scoped', {
  skip: enabled ? false : 'Run only against a disposable synthetic MariaDB schema with M4_10_MARIADB_TEST=1.',
}, async () => {
  await deployMigrations(readMigrationEnvironment(process.env));
  const environment = validateEnvironment(process.env);
  const database = new DurableWorkDatabase(environment);
  const dataSource = await database.getDataSource();
  const repository = new RecordingMetaWebhookRepository(database);
  const protector = new SyntheticPayloadProtector();
  const providerApp = providerAppId();
  const application: MetaWebhookApplication = {
    configurationRef: 'm4-10-synthetic-profile',
    providerAppId: providerApp,
    environment: 'test',
    appSecretRef: 'vault://meta-app/test/m4-10-synthetic/app-secret',
    providerAppIdRef: 'm4-10-synthetic-provider-app',
  };
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const appA = randomUUID();
  const appB = randomUUID();
  const authorizationA = randomUUID();
  const authorizationB = randomUUID();
  const phoneA = `m4-10-phone-a-${randomUUID().replaceAll('-', '')}`;
  const phoneB = `m4-10-phone-b-${randomUUID().replaceAll('-', '')}`;
  const phoneConflict = `m4-10-phone-conflict-${randomUUID().replaceAll('-', '')}`;
  const phoneForReplay = `m4-10-phone-replay-${randomUUID().replaceAll('-', '')}`;
  const assetA = randomUUID();
  const assetB = randomUUID();
  const assetConflict = randomUUID();
  const assetReplay = randomUUID();
  const messageA = `wamid.m4-10-${randomUUID()}`;
  const messageB = `wamid.m4-10-${randomUUID()}`;
  const messageConflict = `wamid.m4-10-${randomUUID()}`;
  const messageReplay = `wamid.m4-10-${randomUUID()}`;
  const workerA = `m4-10-worker-a-${randomUUID().replaceAll('-', '')}`;
  const workerB = `m4-10-worker-b-${randomUUID().replaceAll('-', '')}`;
  const statusesTimestamp = '1793980800';
  let replayEventId: string | undefined;

  const seedAsset = async (input: {
    readonly tenantId: string;
    readonly authorizationId: string;
    readonly appConfigurationId: string;
    readonly assetId: string;
    readonly externalId: string;
    readonly assetAuthorizationState: 'ACTIVE' | 'QUARANTINED';
  }): Promise<void> => {
    await dataSource.query(
      `INSERT INTO ca_meta_assets
       (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id,
        display_name, external_name, version, created_at, updated_at)
       VALUES (?, ?, ?, 'META', 'test', 'WHATSAPP_PHONE_NUMBER', ?, 'Synthetic phone', 'Synthetic phone', 1, ?, ?)`,
      [input.assetId, input.tenantId, input.appConfigurationId, input.externalId, migrationTimestamp, migrationTimestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_asset_authorizations
       (tenant_id, authorization_id, asset_id, app_configuration_id, provider, environment, credential_id,
        state, verification_state, verification_source, verification_ref_hash, verified_at,
        subscription_state, projection_state, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'META', 'test', NULL, ?, 'VERIFIED', 'META_API', ?, ?,
               'ACTIVE', 'UNKNOWN', 1, ?, ?)`,
      [input.tenantId, input.authorizationId, input.assetId, input.appConfigurationId,
        input.assetAuthorizationState, randomBytes(32).toString('hex'), migrationTimestamp,
        migrationTimestamp, migrationTimestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_asset_grants
       (tenant_id, authorization_id, asset_id, app_configuration_id, provider, environment,
        grant_name, status, source, observed_at, version)
       VALUES (?, ?, ?, ?, 'META', 'test', 'whatsapp_business_messaging', 'GRANTED', 'META_API', ?, 1)`,
      [input.tenantId, input.authorizationId, input.assetId, input.appConfigurationId, migrationTimestamp],
    );
  };

  const seedAuthorization = async (input: {
    readonly tenantId: string;
    readonly authorizationId: string;
    readonly appConfigurationId: string;
    readonly state: 'ACTIVE';
  }): Promise<void> => {
    await dataSource.query(
      `INSERT INTO ca_meta_authorizations
       (id, tenant_id, app_configuration_id, provider, environment, provider_authorization_id,
        authorization_state, version, observed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'META', 'test', ?, ?, 1, ?, ?, ?)`,
      [input.authorizationId, input.tenantId, input.appConfigurationId,
        `m4-10-auth-${input.authorizationId}`, input.state, migrationTimestamp, migrationTimestamp, migrationTimestamp],
    );
  };

  const persist = async (rawBody: Buffer) => {
    const now = new Date();
    const payload = await protector.protect({
      reference: randomUUID(),
      providerAppId: application.providerAppId,
      environment: application.environment,
      rawBody,
    });
    return repository.persist({
      application,
      items: parseMetaWebhookDelivery(rawBody).items,
      rawBody,
      payload,
      receivedAt: now,
      signatureVerifiedAt: now,
    });
  };

  try {
    await dataSource.query("SET time_zone = '+00:00'");
    await dataSource.query(
      `INSERT INTO ca_meta_tenants (id, status, version, created_at, updated_at)
       VALUES (?, 'ACTIVE', 1, ?, ?), (?, 'ACTIVE', 1, ?, ?)`,
      [tenantA, migrationTimestamp, migrationTimestamp, tenantB, migrationTimestamp, migrationTimestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_app_configurations
       (id, tenant_id, provider, app_external_id, environment, credential_ref, version, created_at, updated_at)
       VALUES (?, ?, 'META', ?, 'test', NULL, 1, ?, ?),
              (?, ?, 'META', ?, 'test', NULL, 1, ?, ?)`,
      [appA, tenantA, providerApp, migrationTimestamp, migrationTimestamp,
        appB, tenantB, providerApp, migrationTimestamp, migrationTimestamp],
    );
    await seedAuthorization({ tenantId: tenantA, authorizationId: authorizationA, appConfigurationId: appA, state: 'ACTIVE' });
    await seedAuthorization({ tenantId: tenantB, authorizationId: authorizationB, appConfigurationId: appB, state: 'ACTIVE' });
    await seedAsset({ tenantId: tenantA, authorizationId: authorizationA, appConfigurationId: appA, assetId: assetA,
      externalId: phoneA, assetAuthorizationState: 'ACTIVE' });
    await seedAsset({ tenantId: tenantA, authorizationId: authorizationA, appConfigurationId: appA, assetId: assetConflict,
      externalId: phoneConflict, assetAuthorizationState: 'ACTIVE' });
    await seedAsset({ tenantId: tenantB, authorizationId: authorizationB, appConfigurationId: appB, assetId: assetB,
      externalId: phoneB, assetAuthorizationState: 'QUARANTINED' });
    await dataSource.query(
      `INSERT INTO ca_meta_asset_claim_quarantine
       (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id,
        identity_hash, reason_code, source, created_at)
       VALUES (?, ?, ?, 'META', 'test', 'WHATSAPP_PHONE_NUMBER', ?, ?,
               'CROSS_TENANT_VERIFIED_OWNER', 'META_API', ?)`,
      [randomUUID(), tenantB, appB, phoneConflict, randomBytes(32), migrationTimestamp],
    );

    const regular = await persist(statusEnvelope({
      phoneNumberId: phoneA,
      messageId: messageA,
      recipientId: phoneB,
      statuses: [
        { status: 'sent', timestamp: statusesTimestamp },
        { status: 'delivered', timestamp: String(Number(statusesTimestamp) + 1) },
      ],
    }));
    assert.deepEqual(regular, { received: 2, inserted: 2, duplicate: 0, quarantined: 0 });
    const routedStatusRows = await dataSource.query(
      `SELECT route_state, tenant_id, app_configuration_id, asset_id
       FROM ca_meta_webhook_events WHERE provider_app_id = ? AND provider_message_id = ?`,
      [providerApp, messageA],
    ) as Array<{ route_state: string; tenant_id: string | null; app_configuration_id: string | null; asset_id: string | null }>;
    assert.equal(routedStatusRows.length, 2);
    assert.ok(routedStatusRows.every((row) => row.route_state === 'ROUTED' && row.tenant_id === tenantA &&
      row.app_configuration_id === appA && row.asset_id === assetA),
    'a verified asset route resolves to its own tenant/app/asset tuple');

    const concurrentClaims = await Promise.all([
      repository.claimNext(workerA),
      repository.claimNext(workerB),
    ]);
    const firstClaim = concurrentClaims.find((claim) => claim !== null);
    assert.ok(firstClaim, 'one concurrent worker claims the first status');
    assert.equal(concurrentClaims.filter((claim) => claim !== null).length, 1,
      'the tenant/app/environment/asset/message lock allows only one concurrent status claim');
    assert.equal(firstClaim.providerStatus, 'sent');
    const firstFence = firstClaim.statusLease;
    assert.ok(firstFence);
    const firstWorker = concurrentClaims[0] === firstClaim ? workerA : workerB;
    await repository.finalize({ eventId: firstClaim.id, workerRef: firstWorker,
      leaseVersion: firstClaim.leaseVersion, state: 'PROCESSED', statusLease: firstFence });

    const secondClaim = await repository.claimNext(workerB);
    assert.ok(secondClaim);
    assert.equal(secondClaim.providerStatus, 'delivered');
    const secondFence = secondClaim.statusLease;
    assert.ok(secondFence);
    assert.ok(secondFence.leaseVersion > firstFence.leaseVersion);
    assert.notEqual(secondFence.leaseToken, firstFence.leaseToken);
    await assert.rejects(repository.finalize({ eventId: secondClaim.id, workerRef: workerB,
      leaseVersion: secondClaim.leaseVersion, state: 'PROCESSED', statusLease: firstFence }),
    /Meta webhook status lock was lost before finalization/u,
    'a stale status fence cannot release or finalize a newer lease');
    const stillRunning = await dataSource.query(
      'SELECT process_state FROM ca_meta_webhook_events WHERE id = ?', [secondClaim.id],
    ) as Array<{ process_state: string }>;
    assert.equal(stillRunning[0]?.process_state, 'RUNNING', 'the rejected stale fence rolls back event finalization');
    await repository.finalize({ eventId: secondClaim.id, workerRef: workerB,
      leaseVersion: secondClaim.leaseVersion, state: 'PROCESSED', statusLease: secondFence });

    const conflictResult = await persist(statusEnvelope({
      phoneNumberId: phoneConflict, messageId: messageConflict, recipientId: phoneA,
      statuses: [{ status: 'sent', timestamp: statusesTimestamp }],
    }));
    assert.equal(conflictResult.quarantined, 1);
    const conflictRows = await dataSource.query(
      `SELECT route_state, process_state, quarantine_reason, tenant_id, app_configuration_id, asset_id
       FROM ca_meta_webhook_events WHERE provider_app_id = ? AND provider_message_id = ?`,
      [providerApp, messageConflict],
    ) as Array<{ route_state: string; process_state: string; quarantine_reason: string | null;
      tenant_id: string | null; app_configuration_id: string | null; asset_id: string | null }>;
    assert.equal(conflictRows.length, 1);
    assert.deepEqual(conflictRows[0], {
      route_state: 'QUARANTINED', process_state: 'BLOCKED', quarantine_reason: 'CONFLICTING_ASSET_OWNER',
      tenant_id: null, app_configuration_id: null, asset_id: null,
    }, 'conflicting owner evidence cannot select a tenant');

    const grantRows = await dataSource.query(
      `SELECT tenant_id, asset_id, status FROM ca_meta_asset_grants
       WHERE (tenant_id = ? AND asset_id = ?) OR (tenant_id = ? AND asset_id = ?)
       ORDER BY tenant_id`,
      [tenantA, assetA, tenantB, assetB],
    ) as Array<{ tenant_id: string; asset_id: string; status: string }>;
    assert.equal(grantRows.length, 2);
    assert.ok(grantRows.some((row) => row.tenant_id === tenantA && row.asset_id === assetA && row.status === 'GRANTED'));
    assert.ok(grantRows.some((row) => row.tenant_id === tenantB && row.asset_id === assetB && row.status === 'GRANTED'));

    const replayRaw = statusEnvelope({
      phoneNumberId: phoneForReplay,
      messageId: messageReplay,
      recipientId: phoneA,
      statuses: [{ status: 'sent', timestamp: statusesTimestamp }],
    });
    const replayPersisted = await persist(replayRaw);
    assert.equal(replayPersisted.quarantined, 1, 'an unknown opaque resource stays tenantless even when another payload field resembles a known ID');
    const replayRows = await dataSource.query(
      `SELECT event.id, event.route_state, event.process_state, event.tenant_id, event.app_configuration_id, event.asset_id,
              delivery.app_configuration_ref, delivery.environment AS delivery_environment
       FROM ca_meta_webhook_events event INNER JOIN ca_meta_webhook_deliveries delivery ON delivery.id = event.delivery_id
       WHERE event.provider_app_id = ? AND event.provider_message_id = ?`,
      [providerApp, messageReplay],
    ) as Array<{ id: string; route_state: string; process_state: string;
      tenant_id: string | null; app_configuration_id: string | null; asset_id: string | null;
      app_configuration_ref: string; delivery_environment: string }>;
    assert.equal(replayRows.length, 1);
    const replayEvent = replayRows[0];
    assert.ok(replayEvent);
    replayEventId = replayEvent.id;
    assert.deepEqual({ route_state: replayEvent.route_state, process_state: replayEvent.process_state,
      tenant_id: replayEvent.tenant_id, app_configuration_id: replayEvent.app_configuration_id, asset_id: replayEvent.asset_id },
    { route_state: 'QUARANTINED', process_state: 'BLOCKED', tenant_id: null, app_configuration_id: null, asset_id: null });
    assert.equal(replayEvent.app_configuration_ref, application.configurationRef,
      'delivery durably preserves the exact public app configuration reference');
    assert.equal(replayEvent.delivery_environment, application.environment,
      'replay retains the original environment on the linked delivery');

    await seedAsset({ tenantId: tenantA, authorizationId: authorizationA, appConfigurationId: appA, assetId: assetReplay,
      externalId: phoneForReplay, assetAuthorizationState: 'ACTIVE' });
    const replayService = new MetaWebhookReplayService([
      webhookProfile(providerApp, 'm4-10-other-profile', 'WHATSAPP_COEXISTENCE'),
      webhookProfile(providerApp, application.configurationRef),
    ], 'test', repository, protector, {
      async assertAuthorized() { return undefined; },
    });
    assert.equal(await replayService.replayQuarantined({
      eventId: replayEvent.id,
      actorRef: 'm4-10-synthetic-operator',
      caseRef: 'm4-10-synthetic-replay-case',
    }), 'ROUTED');
    assert.deepEqual(repository.replayConfigurationRefs, [application.configurationRef],
      'replay selects the original exact profile even when another flow profile shares its provider App ID');
    const replayed = await dataSource.query(
      `SELECT route_state, process_state, tenant_id, app_configuration_id, asset_id
       FROM ca_meta_webhook_events WHERE id = ?`,
      [replayEvent.id],
    ) as Array<{ route_state: string; process_state: string; tenant_id: string | null;
      app_configuration_id: string | null; asset_id: string | null }>;
    assert.deepEqual(replayed[0], { route_state: 'ROUTED', process_state: 'PENDING',
      tenant_id: tenantA, app_configuration_id: appA, asset_id: assetReplay });
    const auditRows = await dataSource.query(
      `SELECT actor_ref, case_ref, outcome FROM ca_meta_webhook_replay_audit WHERE webhook_event_id = ?`,
      [replayEvent.id],
    ) as Array<{ actor_ref: string; case_ref: string; outcome: string }>;
    assert.deepEqual(auditRows, [{ actor_ref: 'm4-10-synthetic-operator',
      case_ref: 'm4-10-synthetic-replay-case', outcome: 'ROUTED' }]);

    const quarantinedGrantResult = await persist(statusEnvelope({
      phoneNumberId: phoneB, messageId: messageB, recipientId: phoneA,
      statuses: [{ status: 'sent', timestamp: statusesTimestamp }],
    }));
    assert.equal(quarantinedGrantResult.quarantined, 1,
      'a GRANTED row does not route a tenant whose asset authorization is quarantined');
    const quarantinedGrantRows = await dataSource.query(
      `SELECT route_state, process_state, tenant_id, app_configuration_id, asset_id
       FROM ca_meta_webhook_events WHERE provider_app_id = ? AND provider_message_id = ?`,
      [providerApp, messageB],
    ) as Array<{ route_state: string; process_state: string; tenant_id: string | null;
      app_configuration_id: string | null; asset_id: string | null }>;
    assert.deepEqual(quarantinedGrantRows[0], { route_state: 'QUARANTINED', process_state: 'BLOCKED',
      tenant_id: null, app_configuration_id: null, asset_id: null });
  } finally {
    try {
      const quarantineEvidenceRows = await dataSource.query(
        `SELECT id FROM ca_meta_asset_claim_quarantine
         WHERE tenant_id = ? AND app_configuration_id = ? AND external_id = ?`,
        [tenantB, appB, phoneConflict],
      ) as Array<{ id: string }>;
      const retainQuarantineEvidence = quarantineEvidenceRows.length > 0;
      const immutableReplayRows = replayEventId
        ? await dataSource.query('SELECT id FROM ca_meta_webhook_replay_audit WHERE webhook_event_id = ?', [replayEventId]) as Array<{ id: string }>
        : [];
      const retainReplayEvidence = Boolean(replayEventId) && immutableReplayRows.length > 0;
      if (retainReplayEvidence && replayEventId) {
        await dataSource.query(
          `UPDATE ca_meta_webhook_events SET process_state = 'PROCESSED', lease_owner = NULL,
             lease_until = NULL, next_attempt_at = NULL, updated_at = UTC_TIMESTAMP(6) WHERE id = ?`,
          [replayEventId],
        );
        await dataSource.query(
          `DELETE FROM ca_meta_webhook_events
           WHERE provider_app_id = ? AND environment = 'test' AND id <> ?`, [providerApp, replayEventId],
        );
      } else {
        await dataSource.query('DELETE FROM ca_meta_webhook_events WHERE provider_app_id = ? AND environment = \'test\'', [providerApp]);
      }
      await dataSource.query('DELETE FROM ca_meta_webhook_deliveries WHERE provider_app_id = ? AND environment = \'test\'', [providerApp]);
      await dataSource.query('DELETE FROM ca_meta_webhook_status_locks WHERE tenant_id IN (?, ?)', [tenantA, tenantB]);
      await dataSource.query('DELETE FROM ca_meta_asset_grants WHERE tenant_id IN (?, ?)', [tenantA, tenantB]);
      if (retainReplayEvidence) {
        await dataSource.query('DELETE FROM ca_meta_asset_authorizations WHERE tenant_id IN (?, ?) AND asset_id <> ?',
          [tenantA, tenantB, assetReplay]);
      } else {
        await dataSource.query('DELETE FROM ca_meta_asset_authorizations WHERE tenant_id IN (?, ?)', [tenantA, tenantB]);
      }
      if (retainReplayEvidence) {
        await dataSource.query('DELETE FROM ca_meta_assets WHERE tenant_id IN (?, ?) AND id <> ?', [tenantA, tenantB, assetReplay]);
        await dataSource.query('DELETE FROM ca_meta_authorizations WHERE tenant_id = ?', [tenantB]);
        // If inserted, the cross-tenant quarantine claim is append-only and references tenantB's app configuration.
      } else {
        await dataSource.query('DELETE FROM ca_meta_assets WHERE tenant_id IN (?, ?)', [tenantA, tenantB]);
        await dataSource.query('DELETE FROM ca_meta_authorizations WHERE tenant_id IN (?, ?)', [tenantA, tenantB]);
        await dataSource.query('DELETE FROM ca_meta_app_configurations WHERE tenant_id = ?', [tenantA]);
        await dataSource.query('DELETE FROM ca_meta_tenants WHERE id = ?', [tenantA]);
      }
      if (!retainQuarantineEvidence) {
        await dataSource.query('DELETE FROM ca_meta_app_configurations WHERE tenant_id = ?', [tenantB]);
        await dataSource.query('DELETE FROM ca_meta_tenants WHERE id = ?', [tenantB]);
      }
    } finally {
      await database.close();
    }
  }
});
