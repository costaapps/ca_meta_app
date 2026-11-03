import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateEnvironment } from '../src/config/environment.js';
import { deployMigrations } from '../src/database/migrations/migration-runner.js';
import { readMigrationEnvironment } from '../src/database/migrations/migration-environment.js';
import { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { AuditEventWriter } from '../src/privacy/audit.service.js';
import { DeletionRequestService, type DeletionAuthorizationPort } from '../src/privacy/deletion.service.js';
import { RetentionService, type RetentionAuthorizationPort } from '../src/privacy/retention.service.js';

const enabled = process.env.M3_10_TEST === '1';
const timestamp = '2020-01-01 00:00:00.000000';
const uuid64 = (): string => randomUUID().replaceAll('-', '').padEnd(64, '0');
const fixture = JSON.parse(readFileSync(join(__dirname, '../../../../tools/m3-10/fixtures/retention-synthetic.json'), 'utf8')) as {
  classification: 'synthetic-only';
  policy: { environment: 'test'; category: 'MAGIC_LINK_TRANSIENT'; durationSeconds: number; version: string };
  cutoffCases: { expiredAt: string; liveExpiryOffsetSeconds: number; batchSize: number; expectedDeletedRows: number };
  queueStates: { terminal: 'DELIVERED'; leased: 'PROCESSING'; resumedTerminal: 'DEAD' };
};

class AllowRetention implements RetentionAuthorizationPort {
  async authorize(input: Parameters<RetentionAuthorizationPort['authorize']>[0]) {
    return { ...input, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  }
}
class AllowDeletion implements DeletionAuthorizationPort {
  async authorize(input: Parameters<DeletionAuthorizationPort['authorize']>[0]) {
    return { ...input, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  }
}

test('M3.10 MariaDB retention is tenant/category scoped, cutoff based, resumable and audited', {
  skip: enabled ? false : 'Run only in the UUID-scoped synthetic MariaDB harness with M3_10_TEST=1.',
}, async () => {
  const migrationEnvironment = readMigrationEnvironment(process.env);
  await deployMigrations(migrationEnvironment);
  const apiEnvironment = validateEnvironment(process.env);
  const database = new DurableWorkDatabase(apiEnvironment);
  const dataSource = await database.getDataSource();
  const audit = new AuditEventWriter(database);
  const retention = new RetentionService(database, audit, new AllowRetention(), undefined, apiEnvironment.nodeEnv);
  const deletion = new DeletionRequestService(database, audit, new AllowDeletion());
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const principalA = randomUUID();
  const principalB = randomUUID();
  const actorRef = `synthetic-owner-${randomUUID()}`;
  const now = new Date();
  assert.equal(fixture.classification, 'synthetic-only');
  const liveExpiry = new Date(now.getTime() + fixture.cutoffCases.liveExpiryOffsetSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const expiredExpiry = fixture.cutoffCases.expiredAt;

  try {
    await dataSource.query("SET time_zone = '+00:00'");
    await dataSource.query(
      `INSERT INTO ca_meta_tenants (id, status, version, created_at, updated_at)
       VALUES (?, 'ACTIVE', 1, ?, ?), (?, 'ACTIVE', 1, ?, ?)`,
      [tenantA, timestamp, timestamp, tenantB, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_principals (id, kind, issuer, subject, status, version, created_at, updated_at)
       VALUES (?, 'USER', 'https://m3-10.synthetic.invalid', ?, 'ACTIVE', 1, ?, ?),
              (?, 'USER', 'https://m3-10.synthetic.invalid', ?, 'ACTIVE', 1, ?, ?)`,
      [principalA, `member-a-${randomUUID()}`, timestamp, timestamp, principalB, `member-b-${randomUUID()}`, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_memberships (tenant_id, principal_id, principal_kind, roles, status, version, created_at, updated_at)
       VALUES (?, ?, 'USER', JSON_ARRAY('owner'), 'ACTIVE', 1, ?, ?), (?, ?, 'USER', JSON_ARRAY('owner'), 'ACTIVE', 1, ?, ?)`,
      [tenantA, principalA, timestamp, timestamp, tenantB, principalB, timestamp, timestamp],
    );

    const links = {
      aQueued: uuid64(), aProcessing: uuid64(), aNoQueue: uuid64(), aLive: uuid64(), bOld: uuid64(),
    };
    const insertLink = async (tenantId: string, principalId: string, id: string, expiry: string): Promise<void> => {
      await dataSource.query(
        `INSERT INTO ca_meta_magic_links
         (id, token_hash, purpose, principal_id, tenant_id, membership_version, created_at, expires_at, attempt_count, max_attempts, consumed_at)
         VALUES (?, ?, 'PORTAL_LOGIN', ?, ?, 1, ?, ?, 0, 5, NULL)`,
        [id, createHash('sha256').update(randomUUID()).digest('hex'), principalId, tenantId, timestamp, expiry],
      );
    };
    await insertLink(tenantA, principalA, links.aQueued, expiredExpiry);
    await insertLink(tenantA, principalA, links.aProcessing, expiredExpiry);
    await insertLink(tenantA, principalA, links.aNoQueue, expiredExpiry);
    await insertLink(tenantA, principalA, links.aLive, liveExpiry);
    await insertLink(tenantB, principalB, links.bOld, expiredExpiry);
    const insertQueue = async (tenantId: string, linkId: string, status: 'DELIVERED' | 'PROCESSING'): Promise<void> => {
      const id = randomUUID().replaceAll('-', '').slice(0, 32);
      const fingerprint = createHash('sha256').update(id).digest('hex');
      await dataSource.query(
        `INSERT INTO ca_meta_magic_link_mail_queue
         (id, magic_link_id, tenant_id, request_fingerprint, window_start, recipient_ciphertext, status,
          attempt_count, max_attempts, available_at, lease_owner, lease_expires_at, created_at, delivered_at)
         VALUES (?, ?, ?, ?, '2020-01-01 00:00:00', ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        [id, linkId, tenantId, fingerprint, Buffer.from('synthetic-recipient-ciphertext'), status,
          status === 'DELIVERED' ? 1 : 0, timestamp, status === 'PROCESSING' ? randomUUID() : null,
          status === 'PROCESSING' ? '2099-01-01 00:00:00.000000' : null, timestamp,
          status === 'DELIVERED' ? timestamp : null],
      );
    };
    await insertQueue(tenantA, links.aQueued, fixture.queueStates.terminal);
    await insertQueue(tenantA, links.aProcessing, fixture.queueStates.leased);

    const policyId = await retention.createDraftPolicy({
      tenantId: tenantA, environment: fixture.policy.environment, actorRef, retentionSeconds: fixture.policy.durationSeconds,
      policyVersion: fixture.policy.version, correlationId: randomUUID(),
    });
    assert.equal(await retention.activatePolicy({
      tenantId: tenantA, environment: fixture.policy.environment, actorRef, policyId,
      approvalRef: 'fixture-approved-v1', correlationId: randomUUID(),
    }), true);
    const runId = await retention.startPurge({
      tenantId: tenantA, environment: fixture.policy.environment, actorRef, correlationId: randomUUID(),
    });
    const first = await retention.continuePurge({
      tenantId: tenantA, environment: fixture.policy.environment, actorRef, runId, correlationId: randomUUID(), batchSize: fixture.cutoffCases.batchSize,
    });
    assert.equal(first.deleted, 1, 'one terminal queue row is removed in the first bounded batch');
    const paused = await retention.continuePurge({
      tenantId: tenantA, environment: fixture.policy.environment, actorRef, runId, correlationId: randomUUID(), batchSize: fixture.cutoffCases.batchSize,
    });
    assert.equal(paused.status, 'PAUSED', 'an in-flight mail delivery pauses the purge and persists its cursor');
    await dataSource.query(
      `UPDATE ca_meta_magic_link_mail_queue SET status = ?, lease_owner = NULL, lease_expires_at = NULL
       WHERE tenant_id = ? AND magic_link_id = ?`, [fixture.queueStates.resumedTerminal, tenantA, links.aProcessing],
    );

    let result = paused;
    for (let count = 0; count < 10 && result.status !== 'COMPLETED'; count += 1) {
      result = await retention.continuePurge({
        tenantId: tenantA, environment: fixture.policy.environment, actorRef, runId, correlationId: randomUUID(), batchSize: fixture.cutoffCases.batchSize,
      });
    }
    assert.equal(result.status, 'COMPLETED', 'the persisted run resumes after in-flight work reaches a terminal state');
    assert.equal(result.totalDeleted, fixture.cutoffCases.expectedDeletedRows, 'two queue rows and three expired tenant-A links were purged');

    const linkCounts = await dataSource.query(
      `SELECT tenant_id, COUNT(*) AS count FROM ca_meta_magic_links WHERE id IN (?, ?, ?, ?, ?) GROUP BY tenant_id`,
      Object.values(links),
    ) as Array<{ tenant_id: string; count: string | number }>;
    assert.equal(Number(linkCounts.find((row) => row.tenant_id === tenantA)?.count ?? 0), 1, 'tenant A live link remains');
    assert.equal(Number(linkCounts.find((row) => row.tenant_id === tenantB)?.count ?? 0), 1, 'tenant B expired link is untouched');
    const queueCount = await dataSource.query(
      'SELECT COUNT(*) AS count FROM ca_meta_magic_link_mail_queue WHERE tenant_id = ? AND magic_link_id IN (?, ?)',
      [tenantA, links.aQueued, links.aProcessing],
    ) as Array<{ count: string | number }>;
    assert.equal(Number(queueCount[0]?.count ?? 0), 0);

    const deletionInput = {
      tenantId: tenantA, actorRef, targetRef: `asset:${randomUUID()}`, scope: 'ASSET',
      reasonCode: 'PRIVACY_REQUEST', idempotencyKey: randomUUID(), correlationId: randomUUID(),
    } as const;
    const requested = await deletion.request(deletionInput);
    const repeated = await deletion.request(deletionInput);
    assert.equal(repeated.requestId, requested.requestId, 'same request hash replays the original status and evidence');
    await assert.rejects(deletion.request({ ...deletionInput, targetRef: `asset:${randomUUID()}` }), /reused for a different request/);
    const status = await deletion.status({ tenantId: tenantA, actorRef, requestId: requested.requestId });
    assert.equal(status?.status, 'RECEIVED');
    assert.equal('requesterRef' in (status ?? {}), false);
    assert.equal('targetRef' in (status ?? {}), false);
    assert.equal(await deletion.status({ tenantId: tenantB, actorRef, requestId: requested.requestId }), undefined,
      'status lookup is tenant-scoped even with a valid authorization grant');
    assert.equal(await deletion.updateStatus({
      tenantId: tenantA, actorRef, requestId: requested.requestId, nextStatus: 'ASSESSED',
      reasonCode: 'REQUEST_VALIDATED', correlationId: randomUUID(),
    }), true);
    const assessed = await deletion.status({ tenantId: tenantA, actorRef, requestId: requested.requestId });
    assert.equal(assessed?.status, 'ASSESSED');
    assert.notEqual(assessed?.evidenceRef, status?.evidenceRef, 'status transitions replace only the opaque evidence reference');
    const persisted = await dataSource.query(
      `SELECT requester_ref_hash, target_ref_hash, status, evidence_ref
       FROM ca_meta_deletion_requests WHERE tenant_id = ? AND id = ?`, [tenantA, requested.requestId],
    ) as Array<{ requester_ref_hash: string; target_ref_hash: string; status: string; evidence_ref: string }>;
    assert.equal(persisted[0]?.requester_ref_hash === actorRef, false);
    assert.equal(persisted[0]?.status, 'ASSESSED');
    assert.ok(persisted[0]?.evidence_ref);

    const audits = await dataSource.query(
      'SELECT actor_ref_hash, safe_diff FROM ca_meta_audit_events WHERE tenant_id = ? ORDER BY created_at', [tenantA],
    ) as Array<{ actor_ref_hash: string; safe_diff: string }>;
    assert.ok(audits.length >= 6, 'policy, purge and deletion transitions have audit evidence');
    assert.equal(audits.some((row) => row.actor_ref_hash === actorRef), false, 'actor references are hashed');
    assert.equal(JSON.stringify(audits).includes('synthetic-recipient-ciphertext'), false);
  } finally {
    await database.close();
  }
});
