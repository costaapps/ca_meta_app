import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { validateEnvironment } from '../src/config/environment.js';
import { deployMigrations } from '../src/database/migrations/migration-runner.js';
import { readMigrationEnvironment } from '../src/database/migrations/migration-environment.js';
import { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { IdentityDeniedError } from '../src/identity/identity.errors.js';
import { IdentityAssertionVerifier, PlatformIdentityAdminAuthority } from '../src/identity/identity.trust.js';
import {
  MagicLinkEmailProofVerifier,
  MagicLinkIdentityProvisioningService,
  type VerifiedMagicLinkEmailIdentity,
} from '../src/auth/magic-link-identity.js';
import { MysqlMagicLinkStore } from '../src/auth/mysql-magic-link.store.js';
import { hashMagicLinkEmail } from '../src/auth/magic-link.service.js';

const enabled = process.env.M3_03_TEST === '1';
const timestamp = '2026-11-03 12:00:00.000000';

class SyntheticEmailProofVerifier extends MagicLinkEmailProofVerifier {
  private readonly proofs = new Map<string, {
    readonly email: string;
    readonly principalId: string;
    readonly proofGeneration: number;
  }>();
  private readonly proofGenerationReader: Pick<MysqlMagicLinkStore, 'readProofGeneration'>;

  constructor(
    private readonly recoveryKeyForFixture: string,
    generationReader: Pick<MysqlMagicLinkStore, 'readProofGeneration'>,
  ) {
    super(recoveryKeyForFixture, generationReader);
    this.proofGenerationReader = generationReader;
  }

  async add(input: { readonly email: string; readonly principalId: string; readonly proofReference: string }): Promise<string> {
    const proofGeneration = await this.proofGenerationReader.readProofGeneration(
      hashMagicLinkEmail(input.email, this.recoveryKeyForFixture),
    );
    this.proofs.set(input.proofReference, { email: input.email, principalId: input.principalId, proofGeneration });
    return input.proofReference;
  }

  override async verifyProof(proofReference: string): Promise<VerifiedMagicLinkEmailIdentity | undefined> {
    const proof = this.proofs.get(proofReference);
    return proof ? this.issueVerifiedIdentity({
      ...proof,
      proofReference,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }) : undefined;
  }
}

class SyntheticIdentityAssertionVerifier extends IdentityAssertionVerifier {
  issue() { return this.issueVerifiedAssertion('https://identity.synthetic.invalid', `admin-${randomUUID()}`); }
}

test('M3.03 MariaDB email identity association consumes proofs once and revokes/reactivates without changing principal', {
  skip: enabled ? false : 'Run in the disposable M2.05/M3 MariaDB profile with M3_03_TEST=1.',
}, async () => {
  await deployMigrations(readMigrationEnvironment(process.env));
  const environment = validateEnvironment(process.env);
  const database = new DurableWorkDatabase(environment);
  const dataSource = await database.getDataSource();
  const store = new MysqlMagicLinkStore(environment);
  const associations = new MagicLinkIdentityProvisioningService(store);
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const principalA = randomUUID();
  const principalB = randomUUID();
  const orphanPrincipal = randomUUID();
  const email = `m3-03-${randomUUID()}@example.test`;
  const recoveryKey = environment.portalSessionRecoveryKey;
  const emailHash = hashMagicLinkEmail(email, recoveryKey);
  const proofVerifier = new SyntheticEmailProofVerifier(recoveryKey, store);

  try {
    await dataSource.query("SET time_zone = '+00:00'");
    await dataSource.query(
      `INSERT INTO ca_meta_tenants (id, status, version, created_at, updated_at)
       VALUES (?, 'ACTIVE', 1, ?, ?), (?, 'ACTIVE', 1, ?, ?)`,
      [tenantA, timestamp, timestamp, tenantB, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_principals (id, kind, issuer, subject, status, version, created_at, updated_at)
       VALUES (?, 'USER', 'https://m3-03.synthetic.invalid', ?, 'ACTIVE', 1, ?, ?),
              (?, 'USER', 'https://m3-03.synthetic.invalid', ?, 'ACTIVE', 1, ?, ?),
              (?, 'USER', 'https://m3-03.synthetic.invalid', ?, 'ACTIVE', 1, ?, ?)`,
      [principalA, `member-a-${randomUUID()}`, timestamp, timestamp,
        principalB, `member-b-${randomUUID()}`, timestamp, timestamp,
        orphanPrincipal, `orphan-${randomUUID()}`, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_memberships (tenant_id, principal_id, principal_kind, roles, status, version, created_at, updated_at)
       VALUES (?, ?, 'USER', JSON_ARRAY('viewer'), 'ACTIVE', 1, ?, ?),
              (?, ?, 'USER', JSON_ARRAY('viewer'), 'ACTIVE', 1, ?, ?),
              (?, ?, 'USER', JSON_ARRAY('operator'), 'ACTIVE', 1, ?, ?)`,
      [tenantA, principalA, timestamp, timestamp, tenantB, principalA, timestamp, timestamp,
        tenantB, principalB, timestamp, timestamp],
    );

    const firstProofReference = await proofVerifier.add({ email, principalId: principalA, proofReference: `proof-${randomUUID()}` });
    const firstProof = await proofVerifier.verifyProof(firstProofReference);
    assert.ok(firstProof);
    const concurrentAssociation = await Promise.allSettled([
      associations.associate(firstProof),
      associations.associate(firstProof),
    ]);
    assert.equal(concurrentAssociation.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(concurrentAssociation.filter((result) => result.status === 'rejected').length, 1);
    await assert.rejects(associations.associate(firstProof), IdentityDeniedError, 'the same proof cannot be consumed again');

    const conflictingReference = await proofVerifier.add({ email, principalId: principalB, proofReference: `proof-${randomUUID()}` });
    const conflictingProof = await proofVerifier.verifyProof(conflictingReference);
    assert.ok(conflictingProof);
    await assert.rejects(associations.associate(conflictingProof), IdentityDeniedError, 'a verified email cannot move to a different principal');
    const orphanReference = await proofVerifier.add({ email: `orphan-${randomUUID()}@example.test`, principalId: orphanPrincipal, proofReference: `proof-${randomUUID()}` });
    const orphanProof = await proofVerifier.verifyProof(orphanReference);
    assert.ok(orphanProof);
    await assert.rejects(associations.associate(orphanProof), IdentityDeniedError, 'an email cannot create an identity without active membership');

    const initialTarget = await store.findEligibleTarget(emailHash);
    assert.ok(initialTarget);
    assert.equal(initialTarget.principalId, principalA);
    assert.ok(initialTarget.tenantId === tenantA || initialTarget.tenantId === tenantB);
    const pendingLinkTokenHash = createHash('sha256').update(randomUUID(), 'utf8').digest('hex');
    assert.equal(await store.enqueueForInvitedIdentity({
      emailHash, recipient: email, target: initialTarget, linkId: randomUUID(), tokenHash: pendingLinkTokenHash,
    }), true);
    const pendingSessionCookie = `${randomUUID()}${randomUUID()}`;
    const pendingCsrfToken = `${randomUUID()}${randomUUID()}`;
    const pendingContextRef = `${randomUUID()}${randomUUID()}`;
    const pendingSessionMaterial = {
      sessionId: randomUUID(),
      sessionCookie: pendingSessionCookie,
      sessionCookieHash: createHash('sha256').update(pendingSessionCookie, 'utf8').digest('hex'),
      csrfToken: pendingCsrfToken,
      csrfTokenHash: createHash('sha256').update(pendingCsrfToken, 'utf8').digest('hex'),
      contextRef: pendingContextRef,
      contextRefHash: createHash('sha256').update(pendingContextRef, 'utf8').digest('hex'),
    };

    const assertionVerifier = new SyntheticIdentityAssertionVerifier();
    const adminAssertion = assertionVerifier.issue();
    const actor = new PlatformIdentityAdminAuthority([{ issuer: adminAssertion.issuer, subject: adminAssertion.subject }])
      .verify(adminAssertion);
    const proofIssuedBeforeRevocationReference = await proofVerifier.add({
      email, principalId: principalA, proofReference: `proof-${randomUUID()}`,
    });
    const proofIssuedBeforeRevocation = await proofVerifier.verifyProof(proofIssuedBeforeRevocationReference);
    assert.ok(proofIssuedBeforeRevocation);
    assert.equal(proofIssuedBeforeRevocation.proofGeneration, 0);
    const proofNotYetConsumedBeforeRevocationReference = await proofVerifier.add({
      email, principalId: principalA, proofReference: `proof-${randomUUID()}`,
    });
    await associations.revoke(actor, emailHash, principalA, 'IDENTITY_CORRECTION');
    assert.equal(await store.findEligibleTarget(emailHash), undefined, 'revocation blocks magic-link lookup for every tenant');
    const [revokedLinkRows] = await dataSource.query(
      `SELECT l.consumed_at, q.status FROM ca_meta_magic_links AS l
       INNER JOIN ca_meta_magic_link_mail_queue AS q ON q.magic_link_id = l.id
       WHERE l.token_hash = ?`, [pendingLinkTokenHash],
    ) as [Array<{ consumed_at: string | null; status: string }>, unknown];
    assert.ok(revokedLinkRows[0]?.consumed_at, 'revocation consumes outstanding link tokens');
    assert.equal(revokedLinkRows[0]?.status, 'DEAD', 'revocation prevents queued email delivery');
    await assert.rejects(
      store.consumeAndIssueSession(pendingLinkTokenHash, pendingSessionMaterial), IdentityDeniedError,
      'a link issued before identity revocation cannot create a session',
    );
    await assert.rejects(
      associations.associate(proofIssuedBeforeRevocation),
      IdentityDeniedError,
      'a proof capability from the pre-revocation generation cannot restore the identity',
    );
    await assert.rejects(
      proofVerifier.verifyProof(proofNotYetConsumedBeforeRevocationReference),
      IdentityDeniedError,
      'a provider proof issuance record from the prior generation cannot mint a capability after revocation',
    );
    await assert.rejects(associations.revoke(actor, emailHash, principalA, 'IDENTITY_CORRECTION'), IdentityDeniedError);

    const reverificationReference = await proofVerifier.add({ email, principalId: principalA, proofReference: `proof-${randomUUID()}` });
    const reverificationProof = await proofVerifier.verifyProof(reverificationReference);
    assert.ok(reverificationProof);
    assert.equal(reverificationProof.proofGeneration, 1);
    await associations.associate(reverificationProof);
    assert.equal((await store.findEligibleTarget(emailHash))?.principalId, principalA);

    const [eventRows] = await dataSource.query(
      `SELECT event_type, proof_ref_hash, email_hash, principal_id, actor_kind, actor_ref_hash, reason_code
       FROM ca_meta_magic_link_identity_events WHERE email_hash = ? AND principal_id = ? ORDER BY created_at, id`,
      [emailHash, principalA],
    ) as [Array<{ event_type: string; proof_ref_hash: string | null; email_hash: string; principal_id: string;
      actor_kind: string; actor_ref_hash: string | null; reason_code: string }>, unknown];
    assert.equal(eventRows.length, 3);
    const associationEvents = eventRows.filter((row) => row.event_type === 'ASSOCIATED');
    const revocationEvent = eventRows.find((row) => row.event_type === 'REVOKED');
    assert.equal(associationEvents.length, 2);
    assert.equal(revocationEvent?.actor_kind, 'PLATFORM_IDENTITY_ADMIN');
    assert.equal(revocationEvent?.reason_code, 'IDENTITY_CORRECTION');
    assert.equal(revocationEvent?.proof_ref_hash, null);
    assert.match(revocationEvent?.actor_ref_hash ?? '', /^[a-f0-9]{64}$/);
    assert.equal(associationEvents.some((row) => row.proof_ref_hash === firstProof.proofReferenceHash), true);
    assert.equal(associationEvents.every((row) => row.actor_kind === 'EMAIL_PROOF_VERIFIER' &&
      row.actor_ref_hash === null && row.reason_code === 'VERIFIED_EMAIL' && row.proof_ref_hash !== null), true);
    assert.equal(eventRows.every((row) => row.email_hash === emailHash && row.principal_id === principalA), true);
    assert.equal(JSON.stringify(eventRows).includes(email), false);
    await assert.rejects(
      dataSource.query(
        `UPDATE ca_meta_magic_link_identity_events SET reason_code = 'CHANGED'
         WHERE email_hash = ? AND principal_id = ?`, [emailHash, principalA],
      ), /magic-link identity events are append-only/i,
    );
    await assert.rejects(
      dataSource.query(
        'DELETE FROM ca_meta_magic_link_identity_events WHERE email_hash = ? AND principal_id = ?', [emailHash, principalA],
      ), /magic-link identity events are append-only/i,
    );
  } finally {
    await store.onApplicationShutdown();
    await database.close();
  }
});
