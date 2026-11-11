import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { ApiEnvironment } from '../src/config/environment.js';
import { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { DurableJobStore } from '../src/jobs/job-store.js';
import type { IdentityRepository } from '../src/identity/identity.repository.js';
import type { TenantMembership } from '../src/identity/identity.types.js';
import { hashTenantContextReference, ServiceTenantAuthorizationService, TenantAuthorizationService, TenantContextService } from '../src/identity/identity.service.js';
import { PortalSessionVerifier, type VerifiedPortalSession } from '../src/identity/identity.trust.js';
import { NotificationsService, NotificationActionUnresolvedError, NotificationExternalActionUnavailableError, NotificationNotFoundError } from '../src/notifications/notifications.service.js';
import { notificationActionFinalizer } from '../src/notifications/notification-action.worker.js';
import type { ClaimedJob } from '../src/jobs/job-store.js';

const enabled = process.env.M5_06_NOTIFICATION_TEST === '1';
const principalId = '90000000-0000-4000-8000-000000000061';
const contextA = 'm5-06-synthetic-current-context-aaaaaaaa';
const contextB = 'm5-06-synthetic-current-context-bbbbbbbb';

class SyntheticIdentityRepository implements IdentityRepository {
  constructor(private readonly memberships: ReadonlyMap<string, TenantMembership>) {}
  async findPrincipalByIssuerSubject() { return undefined; }
  async findMembership(requestPrincipalId: string, tenantId: string) {
    return requestPrincipalId === principalId ? this.memberships.get(tenantId) : undefined;
  }
  async listActiveMemberships() { return []; }
  async findServiceTenantGrant() { return undefined; }
  async findLegacyTenantMapping() { return undefined; }
}

async function verifiedSession(tenantId: string, contextRef: string): Promise<VerifiedPortalSession> {
  const cookie = `m5-06-test-session-${tenantId}-${randomUUID()}-with-more-than-32-bytes`;
  const expected = createHash('sha256').update(cookie, 'utf8').digest();
  const result = await new PortalSessionVerifier({
    async findActiveBySecretHash(hash) {
      return Buffer.from(hash).equals(expected) ? {
        sessionId: randomUUID(), principalId, tenantId, contextVersion: 1,
        contextRefHash: hashTenantContextReference(contextRef), csrfTokenHash: 'a'.repeat(64), entryMode: 'PORTAL_TOP_LEVEL' as const,
      } : undefined;
    },
  }).verify(cookie);
  if (!result) throw new Error('Synthetic verified portal session could not be created.');
  return result;
}

test('notifications stay isolated by company tenant, paginate, and local actions are transactionally idempotent', { skip: !enabled }, async () => {
  const required = ['API_DATABASE_HOST', 'API_DATABASE_PORT', 'API_DATABASE_NAME', 'API_DATABASE_USER', 'API_DATABASE_PASSWORD'] as const;
  assert.deepEqual(required.filter((key) => !process.env[key]), [], 'isolated API database environment is required');
  const environment = { database: {
    host: process.env.API_DATABASE_HOST!, port: Number(process.env.API_DATABASE_PORT), name: process.env.API_DATABASE_NAME!,
    user: process.env.API_DATABASE_USER!, password: process.env.API_DATABASE_PASSWORD!, connectTimeoutMs: 5000,
  } } as ApiEnvironment;
  const database = new DurableWorkDatabase(environment);
  const source = await database.getDataSource();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const appA = randomUUID();
  const appB = randomUUID();
  const assetA = randomUUID();
  const assetB = randomUUID();
  const notificationA = randomUUID();
  const notificationA2 = randomUUID();
  const notificationB = randomUUID();
  const memberships = new Map<string, TenantMembership>([tenantA, tenantB].map((tenantId) => [tenantId, {
    tenantId, principalId, principalKind: 'USER', principalStatus: 'ACTIVE', tenantStatus: 'ACTIVE', roles: ['owner'], status: 'ACTIVE', version: 1,
  }]));
  const identities = new SyntheticIdentityRepository(memberships);
  const contexts = new TenantContextService(identities);
  const authorization = new TenantAuthorizationService(identities);
  const jobs = new DurableJobStore(database);
  const service = new NotificationsService(database, contexts, authorization, new ServiceTenantAuthorizationService(identities));
  const queueService = new NotificationsService(database, contexts, authorization, new ServiceTenantAuthorizationService(identities), jobs, true);
  const sessionA = await verifiedSession(tenantA, contextA);
  const sessionB = await verifiedSession(tenantB, contextB);
  const actionKey = `m5-06-idempotency-${randomUUID()}`;

  try {
    for (const [tenantId, appId, assetId, legacyCompanyId] of [
      [tenantA, appA, assetA, `company-a-${randomUUID()}`],
      [tenantB, appB, assetB, `company-b-${randomUUID()}`],
    ] as const) {
      await source.query(`INSERT INTO ca_meta_tenants (id,status,version,created_at,updated_at) VALUES (?,'ACTIVE',1,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))`, [tenantId]);
      await source.query(`INSERT INTO ca_meta_tenant_legacy_maps (id,tenant_id,legacy_database_id,legacy_company_id,environment,created_at)
        VALUES (?,?,?,?, 'test',UTC_TIMESTAMP(6))`, [randomUUID(), tenantId, 'same-id-database-m5-06', legacyCompanyId]);
      await source.query(`INSERT INTO ca_meta_app_configurations
        (id,tenant_id,provider,app_external_id,environment,credential_ref,version,created_at,updated_at)
        VALUES (?,?,'META',?,'test',NULL,1,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))`, [appId, tenantId, `synthetic-app-${tenantId}`]);
      await source.query(`INSERT INTO ca_meta_assets
        (id,tenant_id,app_configuration_id,provider,environment,asset_kind,external_id,display_name,external_name,version,created_at,updated_at)
        VALUES (?, ?, ?, 'META', 'test', 'WHATSAPP_PHONE_NUMBER', ?, 'Synthetic phone', 'Synthetic phone', 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
      [assetId, tenantId, appId, `synthetic-waba-${tenantId}`]);
    }
    for (const [tenantId, assetId, id, secondsAgo] of [
      [tenantA, assetA, notificationA, 2], [tenantA, assetA, notificationA2, 1], [tenantB, assetB, notificationB, 0],
    ] as const) {
      await source.query(`INSERT INTO ca_meta_notifications
        (id,tenant_id,asset_id,kind,message_ref,provider_target_ref,source_event_hash,status,safe_summary,created_at,updated_at)
        VALUES (?,?,?,'MESSAGE_RECEIVED',NULL,?,?, 'UNREAD','Synthetic summary',DATE_SUB(UTC_TIMESTAMP(6), INTERVAL ? SECOND),UTC_TIMESTAMP(6))`,
      [id, tenantId, assetId, `private-target-${randomUUID()}`, createHash('sha256').update(randomUUID()).digest(), secondsAgo]);
    }

    const firstPage = await service.list(sessionA, contextA, 1, undefined, 'req-m5-06-list-a');
    assert.equal(firstPage.items.length, 1);
    assert.ok(firstPage.items[0]?.id === notificationA2 || firstPage.items[0]?.id === notificationA);
    assert.notEqual(firstPage.items[0]?.id, notificationB);
    assert.equal(firstPage.items[0]?.safeSummary, 'A new WhatsApp message is available.');
    assert.equal(firstPage.items[0]?.actions.includes('SEND_MESSAGE'), false);
    assert.ok(firstPage.nextCursor);
    const secondPage = await service.list(sessionA, contextA, 1, firstPage.nextCursor, 'req-m5-06-list-next');
    assert.equal(secondPage.items.length, 1);
    assert.notEqual(secondPage.items[0]?.id, firstPage.items[0]?.id);
    const pageB = await service.list(sessionB, contextB, 100, undefined, 'req-m5-06-list-b');
    assert.deepEqual(pageB.items.map((item) => item.id), [notificationB]);
    await assert.rejects(service.act(sessionB, contextB, notificationA, `m5-06-forged-${randomUUID()}`,
      { action: 'MARK_READ' }, 'req-m5-06-cross-company'), NotificationNotFoundError);

    const initial = await service.act(sessionA, contextA, notificationA, actionKey, { action: 'MARK_READ' }, 'req-m5-06-read');
    assert.equal(initial.status, 'READ');
    const duplicate = await service.act(sessionA, contextA, notificationA, actionKey, { action: 'MARK_READ' }, 'req-m5-06-read-replay');
    assert.equal(duplicate.status, 'READ');
    const concurrentKey = `m5-06-idempotency-${randomUUID()}`;
    const concurrent = await Promise.all([
      service.act(sessionA, contextA, notificationA2, concurrentKey, { action: 'DISMISS' }, 'req-m5-06-dismiss-1'),
      service.act(sessionA, contextA, notificationA2, concurrentKey, { action: 'DISMISS' }, 'req-m5-06-dismiss-2'),
    ]);
    assert.deepEqual(concurrent.map((item) => item.status), ['DISMISSED', 'DISMISSED']);
    const receiptRows = await source.query(`SELECT COUNT(*) AS count FROM ca_meta_notification_action_receipts WHERE tenant_id = ?`, [tenantA]) as Array<{ count: number | string }>;
    assert.equal(Number(receiptRows[0]?.count), 2, 'same-key concurrent requests create only one receipt');

    await assert.rejects(service.act(sessionA, contextA, notificationB, `m5-06-send-${randomUUID()}`,
      { action: 'SEND_TEMPLATE', templateName: 'synthetic template', language: 'en', parameters: [] }, 'req-m5-06-send'),
    NotificationExternalActionUnavailableError);
    await assert.rejects(service.act(sessionB, contextB, notificationB, `m5-06-reply-${randomUUID()}`,
      { action: 'REPLY_COMMENT', replyText: 'Synthetic reply, never delivered.' }, 'req-m5-06-reply'),
    NotificationExternalActionUnavailableError);
    await assert.rejects(service.act(sessionB, contextB, notificationB, `m5-06-message-${randomUUID()}`,
      { action: 'SEND_MESSAGE', messageText: 'Synthetic message, never delivered.' }, 'req-m5-06-message'),
    NotificationExternalActionUnavailableError);
    const stillUnread = await source.query(`SELECT status FROM ca_meta_notifications WHERE id = ? AND tenant_id = ?`, [notificationB, tenantB]) as Array<{ status: string }>;
    assert.equal(stillUnread[0]?.status, 'UNREAD', 'unavailable send cannot mark notification read');

    const externalKey = `m5-06-external-${randomUUID()}`;
    const externalAction = { action: 'SEND_TEMPLATE', templateName: 'synthetic_template', language: 'en', parameters: ['never delivered'] } as const;
    const acceptedAttempts = await Promise.allSettled([
      queueService.act(sessionB, contextB, notificationB, externalKey, externalAction, 'req-m5-06-external-1'),
      queueService.act(sessionB, contextB, notificationB, externalKey, externalAction, 'req-m5-06-external-2'),
    ] as const);
    const [firstAttempt, secondAttempt] = acceptedAttempts;
    if (firstAttempt.status === 'rejected') throw new Error(`Concurrent external action failed: ${firstAttempt.reason.name}: ${firstAttempt.reason.message}`);
    if (secondAttempt.status === 'rejected') throw new Error(`Concurrent external action failed: ${secondAttempt.reason.name}: ${secondAttempt.reason.message}`);
    const firstAccepted = firstAttempt.value;
    const secondAccepted = secondAttempt.value;
    assert.ok('operationId' in firstAccepted && 'operationId' in secondAccepted);
    if (!('operationId' in firstAccepted) || !('operationId' in secondAccepted)) throw new Error('External action was not accepted.');
    assert.equal(firstAccepted.operationId, secondAccepted.operationId, 'concurrent idempotent external requests share one operation');
    const operationId = firstAccepted.operationId;
    const jobRows = await source.query(`SELECT id FROM ca_meta_jobs WHERE tenant_id = ? AND job_type = 'NOTIFICATION_ACTION'`, [tenantB]) as Array<{ id: string }>;
    assert.deepEqual(jobRows.map((row) => row.id), [operationId], 'one durable notification action job is created');

    await source.query(`UPDATE ca_meta_jobs SET status = 'UNKNOWN', attempt = 1,
      last_safe_error_code = 'PROVIDER_RESULT_UNKNOWN', last_safe_error_action = 'CHECK_STATUS',
      completed_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6) WHERE tenant_id = ? AND id = ?`, [tenantB, operationId]);
    const actionJob = { id: operationId, tenantId: tenantB, type: 'NOTIFICATION_ACTION',
      payload: { kind: 'NOTIFICATION_ACTION', notificationId: notificationB, assetId: assetB,
        appConfigurationId: appB, environment: 'test', request: externalAction } } as unknown as ClaimedJob;
    await notificationActionFinalizer(source.manager, actionJob,
      { status: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN', safeErrorAction: 'CHECK_STATUS' });
    const operation = await service.operation(sessionB, contextB, operationId, 'req-m5-06-operation');
    assert.equal(operation?.status, 'UNKNOWN');
    assert.equal(operation?.nextAction, 'CHECK_STATUS');
    assert.equal('payload' in (operation ?? {}), false, 'operation status never returns the action body');
    assert.equal(await service.operation(sessionA, contextA, operationId, 'req-m5-06-operation-foreign'), undefined,
      'an operation identifier cannot cross tenant scope');
    const replay = await queueService.act(sessionB, contextB, notificationB, externalKey, externalAction, 'req-m5-06-external-replay');
    assert.ok('operationId' in replay);
    if ('operationId' in replay) assert.equal(replay.status, 'UNKNOWN');
    await assert.rejects(queueService.act(sessionB, contextB, notificationB, `m5-06-new-key-${randomUUID()}`,
      externalAction, 'req-m5-06-external-no-blind-retry'), NotificationActionUnresolvedError);
    const afterUnknown = await source.query(`SELECT status FROM ca_meta_notifications WHERE id = ? AND tenant_id = ?`, [notificationB, tenantB]) as Array<{ status: string }>;
    assert.equal(afterUnknown[0]?.status, 'UNREAD', 'ambiguous action never marks notification read');
  } finally {
    for (const tenantId of [tenantA, tenantB]) {
      await source.query('DELETE FROM ca_meta_notification_action_receipts WHERE tenant_id = ?', [tenantId]);
      await source.query('DELETE FROM ca_meta_jobs WHERE tenant_id = ?', [tenantId]);
      await source.query('DELETE FROM ca_meta_notifications WHERE tenant_id = ?', [tenantId]);
      await source.query('DELETE FROM ca_meta_assets WHERE tenant_id = ?', [tenantId]);
      await source.query('DELETE FROM ca_meta_app_configurations WHERE tenant_id = ?', [tenantId]);
      await source.query('DELETE FROM ca_meta_tenant_legacy_maps WHERE tenant_id = ?', [tenantId]);
      await source.query('DELETE FROM ca_meta_tenants WHERE id = ?', [tenantId]);
    }
    await database.close();
  }
});
