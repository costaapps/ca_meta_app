import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CredentialKeyRingConfiguration, EnvironmentValidationError, validateEnvironment } from '../src/config/environment.js';
import { CredentialVaultDeniedError, CredentialVaultIntegrityError, CredentialVaultKeyUnavailableError,
  CredentialVaultOperationError, CredentialVaultRotationError } from '../src/credentials/credential-vault.errors.js';
import { decryptCredential, encryptCredential } from '../src/credentials/credential-vault-crypto.js';
import { ConfiguredCredentialKeyProvider } from '../src/credentials/credential-key-provider.js';
import { CredentialVaultService, FailClosedCredentialVaultAuthorization } from '../src/credentials/credential-vault.service.js';
import type { CredentialBinding, CredentialKeyProvider, CredentialRotationBatchResult, CredentialRotationLease,
  CredentialVaultAuditEntry, CredentialVaultAuthorizationPort, CredentialVaultRepository, CredentialVaultRotationState,
  EncryptedCredential, StoredCredential } from '../src/credentials/credential-vault.types.js';

const actor = { actorRef: randomUUID(), correlationId: randomUUID() };
const binding = (tenantId = randomUUID()): CredentialBinding => ({
  tenantId,
  credentialId: randomUUID(),
  authorizationId: randomUUID(),
  appConfigurationId: randomUUID(),
  provider: 'META',
  environment: 'test',
  family: 'USER_ACCESS',
});

class StaticKeyProvider implements CredentialKeyProvider {
  constructor(private readonly active: string | undefined, private readonly values: ReadonlyMap<string, Buffer>) {}
  activeVersion(): string | undefined { return this.active; }
  keyFor(version: string): Buffer | undefined {
    const key = this.values.get(version);
    return key ? Buffer.from(key) : undefined;
  }
}

class AllowVaultAccess implements CredentialVaultAuthorizationPort {
  async authorize(): Promise<void> {}
}

class InMemoryCredentialVaultRepository implements CredentialVaultRepository {
  readonly records = new Map<string, StoredCredential>();
  readonly auditRows: CredentialVaultAuditEntry[] = [];
  readonly rotations = new Map<string, CredentialVaultRotationState>();
  private readonly leases = new Map<string, CredentialRotationLease>();
  private activeKeyVersion: string | undefined;
  private readonly usedKeyVersions = new Set<string>();

  async store(context: CredentialBinding, envelope: EncryptedCredential, audit: CredentialVaultAuditEntry): Promise<void> {
    this.activeKeyVersion ??= envelope.keyVersion;
    if (this.activeKeyVersion !== envelope.keyVersion) throw new Error('credential-key-version-not-active');
    this.usedKeyVersions.add(envelope.keyVersion);
    const previous = this.records.get(context.credentialId);
    this.records.set(context.credentialId, Object.freeze({ ...context, envelope, version: (previous?.version ?? 0) + 1 }));
    this.auditRows.push(audit);
  }
  async findActive(context: CredentialBinding): Promise<StoredCredential | undefined> {
    const row = this.records.get(context.credentialId);
    if (!row || row.tenantId !== context.tenantId || row.authorizationId !== context.authorizationId ||
        row.appConfigurationId !== context.appConfigurationId || row.environment !== context.environment || row.family !== context.family) return undefined;
    return row;
  }
  async audit(entry: CredentialVaultAuditEntry): Promise<void> { this.auditRows.push(entry); }
  async ensureRotation(target: string): Promise<CredentialVaultRotationState> {
    if (this.activeKeyVersion && this.activeKeyVersion !== target) {
      if (this.usedKeyVersions.has(target)) throw new Error('credential-key-version-reuse-denied');
      const previous = this.rotations.get(this.activeKeyVersion);
      if (previous?.state === 'RUNNING') {
        this.rotations.set(this.activeKeyVersion, Object.freeze({ ...previous, state: 'PAUSED', lastSafeErrorCode: 'ROTATION_FAILED' }));
      }
      this.leases.delete(this.activeKeyVersion);
      this.usedKeyVersions.add(this.activeKeyVersion);
    }
    this.activeKeyVersion = target;
    this.usedKeyVersions.add(target);
    const current = this.rotations.get(target) ?? Object.freeze({ targetKeyVersion: target, state: 'RUNNING' as const, cursorCredentialId: null, lastSafeErrorCode: null });
    this.rotations.set(target, current);
    return current;
  }
  async acquireRotationLease(target: string, owner: string, token: string): Promise<CredentialRotationLease | undefined> {
    if (this.activeKeyVersion !== target) throw new Error('stale-rotation-key-version');
    const state = this.rotations.get(target);
    if (!state || state.state !== 'RUNNING' || this.leases.has(target)) return undefined;
    const lease = Object.freeze({ targetKeyVersion: target, owner, token });
    this.leases.set(target, lease);
    return lease;
  }
  async rotateBatch(lease: CredentialRotationLease, batchSize: number,
    transform: (record: StoredCredential) => EncryptedCredential,
    auditFor: (record: StoredCredential, newKeyVersion: string) => CredentialVaultAuditEntry): Promise<CredentialRotationBatchResult> {
    if (this.activeKeyVersion !== lease.targetKeyVersion) throw new Error('stale-rotation-key-version');
    const currentLease = this.leases.get(lease.targetKeyVersion);
    assert.equal(currentLease?.token, lease.token);
    const state = this.rotations.get(lease.targetKeyVersion);
    assert.ok(state);
    const rows = [...this.records.values()]
      .filter((record) => record.envelope.keyVersion !== lease.targetKeyVersion &&
        (state.cursorCredentialId === null || record.credentialId > state.cursorCredentialId))
      .sort((left, right) => left.credentialId.localeCompare(right.credentialId)).slice(0, batchSize);
    for (const row of rows) {
      const envelope = transform(row);
      this.records.set(row.credentialId, Object.freeze({ ...row, envelope, version: row.version + 1 }));
      this.auditRows.push(auditFor(row, envelope.keyVersion));
    }
    const cursor = rows.at(-1)?.credentialId ?? state.cursorCredentialId;
    const more = [...this.records.values()].some((record) => record.envelope.keyVersion !== lease.targetKeyVersion &&
      (cursor === null || record.credentialId > cursor));
    const done = rows.length === 0 || !more;
    this.rotations.set(lease.targetKeyVersion, Object.freeze({ ...state, state: done ? 'COMPLETED' : 'RUNNING', cursorCredentialId: cursor }));
    this.leases.delete(lease.targetKeyVersion);
    return Object.freeze({ processed: rows.length, done });
  }
  async pauseRotation(lease: CredentialRotationLease, safeErrorCode: string): Promise<void> {
    if (this.leases.get(lease.targetKeyVersion)?.token !== lease.token) return;
    const state = this.rotations.get(lease.targetKeyVersion);
    if (state) this.rotations.set(lease.targetKeyVersion, Object.freeze({ ...state, state: 'PAUSED', lastSafeErrorCode: safeErrorCode }));
    this.leases.delete(lease.targetKeyVersion);
  }
  async getRotationState(target: string): Promise<CredentialVaultRotationState> {
    const state = this.rotations.get(target);
    if (!state) throw new Error('not-found');
    return state;
  }
  async resumeRotation(target: string): Promise<CredentialVaultRotationState> {
    if (this.activeKeyVersion !== target) throw new Error('stale-rotation-key-version');
    const state = await this.getRotationState(target);
    const resumed = Object.freeze({ ...state, state: state.state === 'PAUSED' ? 'RUNNING' as const : state.state, lastSafeErrorCode: null });
    this.rotations.set(target, resumed);
    return resumed;
  }
}

test('credential envelope uses fresh nonces and authenticates tenant, credential, app, environment and ciphertext', () => {
  const key = randomBytes(32);
  const provider = new StaticKeyProvider('v1', new Map([['v1', key]]));
  const context = binding();
  const first = encryptCredential(context, 'synthetic-marker-token', 'v1', provider);
  const second = encryptCredential(context, 'synthetic-marker-token', 'v1', provider);
  assert.notDeepEqual(first.nonce, second.nonce);
  assert.notDeepEqual(first.ciphertext, Buffer.from('synthetic-marker-token'));
  assert.equal(decryptCredential(context, first, provider.keyFor('v1')!), 'synthetic-marker-token');
  assert.throws(() => decryptCredential({ ...context, tenantId: randomUUID() }, first, provider.keyFor('v1')!), CredentialVaultIntegrityError);
  assert.throws(() => decryptCredential({ ...context, family: 'PAGE_ACCESS' }, first, provider.keyFor('v1')!), CredentialVaultIntegrityError);
  assert.throws(() => decryptCredential(context, { ...first, keyVersion: 'v2' }, provider.keyFor('v1')!), CredentialVaultIntegrityError);
  const tampered = { ...first, ciphertext: Buffer.from(first.ciphertext) };
  tampered.ciphertext[0] = (tampered.ciphertext[0] ?? 0) ^ 0x01;
  assert.throws(() => decryptCredential(context, tampered, provider.keyFor('v1')!), CredentialVaultIntegrityError);
  key.fill(0);
});

test('configured credential key ring rejects malformed configuration without echoing key material', () => {
  const key = randomBytes(32);
  const marker = key.toString('base64');
  const keyRing = new ConfiguredCredentialKeyProvider(new CredentialKeyRingConfiguration('key-v1', [{ version: 'key-v1', key }]));
  assert.equal(keyRing.activeVersion(), 'key-v1');
  const copy = keyRing.keyFor('key-v1');
  assert.equal(copy?.length, 32);
  copy?.fill(0);
  assert.equal(keyRing.keyFor('missing'), undefined);
  assert.ok(!JSON.stringify(keyRing).includes(marker));
  const validEnvironment: NodeJS.ProcessEnv = {
    NODE_ENV: 'test', API_PORT: '0', API_BIND_ADDRESS: '127.0.0.1', API_ALLOWED_HOSTS: 'localhost',
    API_TRUSTED_PROXIES: 'none', API_DATABASE_HOST: '127.0.0.1', API_DATABASE_PORT: '3306',
    API_DATABASE_NAME: 'ca_meta_test', API_DATABASE_USER: 'ca_meta_api', API_DATABASE_PASSWORD: 'synthetic-only',
    API_DATABASE_CONNECT_TIMEOUT_MS: '1000',
  };
  const environment = validateEnvironment({ ...validEnvironment, API_CREDENTIAL_KEYRING_JSON: JSON.stringify({ activeVersion: 'key-v1', keys: { 'key-v1': marker } }) });
  assert.equal(environment.credentialKeyRing?.activeVersion(), 'key-v1');
  assert.ok(!JSON.stringify(environment).includes(marker), 'generic environment serialization omits key bytes');
  assert.throws(() => validateEnvironment({ ...validEnvironment, API_CREDENTIAL_KEYRING_JSON: JSON.stringify({ activeVersion: 'key-v1', keys: { 'key-v1': 'not-a-key' } }) }), EnvironmentValidationError);
  key.fill(0);
});

test('vault authorizes store/use, audits metadata only, fails closed without a key and resumes rotation from its checkpoint', async () => {
  const repo = new InMemoryCredentialVaultRepository();
  const v1 = randomBytes(32);
  const v2 = randomBytes(32);
  const oldKeys = new StaticKeyProvider('v1', new Map([['v1', v1]]));
  const oldWriter = new CredentialVaultService(repo, oldKeys, new AllowVaultAccess());
  const first = binding();
  const second = binding();
  await Promise.all([
    oldWriter.store({ ...first, ...actor, secret: 'synthetic-credential-A' }),
    oldWriter.store({ ...second, ...actor, secret: 'synthetic-credential-B' }),
  ]);
  await oldWriter.beginRotation(actor);

  let exposed = '';
  const activeKeys = new StaticKeyProvider('v2', new Map([['v1', v1], ['v2', v2]]));
  const vault = new CredentialVaultService(repo, activeKeys, new AllowVaultAccess());
  const callbackReturnsSecret = (async (secret: string) => secret) as unknown as (secret: string) => Promise<void>;
  const value = await vault.withCredential({ ...first, ...actor, operation: 'MESSAGE_SEND' }, callbackReturnsSecret);
  assert.equal(value, undefined, 'vault never returns a callback result that could contain the plaintext');
  await vault.withCredential({ ...first, ...actor, operation: 'MESSAGE_SEND' }, async (secret) => { exposed = secret; });
  assert.equal(exposed, 'synthetic-credential-A');
  assert.ok(!JSON.stringify(repo.auditRows).includes('synthetic-credential-A'));

  const noKeys = new CredentialVaultService(repo, new StaticKeyProvider(undefined, new Map()), new AllowVaultAccess());
  await assert.rejects(noKeys.store({ ...binding(), ...actor, secret: 'synthetic-no-key' }), CredentialVaultKeyUnavailableError);
  await assert.rejects(noKeys.withCredential({ ...first, ...actor, operation: 'MESSAGE_SEND' }, async () => {}), CredentialVaultKeyUnavailableError);
  const noAccess = new CredentialVaultService(repo, activeKeys, new FailClosedCredentialVaultAuthorization());
  await assert.rejects(noAccess.withCredential({ ...first, ...actor, operation: 'MESSAGE_SEND' }, async () => {}), CredentialVaultDeniedError);
  const authorizedVault = new CredentialVaultService(repo, activeKeys, new AllowVaultAccess());
  const rotation = await authorizedVault.beginRotation(actor);
  await assert.rejects(noAccess.rotationState(actor, rotation.targetKeyVersion), CredentialVaultDeniedError);
  const firstBatch = await authorizedVault.rotateNextBatch(actor, rotation.targetKeyVersion, 1);
  assert.equal(firstBatch.processed, 1);
  assert.equal(firstBatch.done, false);
  const lateBinding = { ...binding(), credentialId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' };
  await assert.rejects(
    oldWriter.store({ ...lateBinding, ...actor, secret: 'synthetic-stale-writer-token' }),
    CredentialVaultOperationError,
  );

  const staleV2Lease = await repo.acquireRotationLease(rotation.targetKeyVersion, 'stale-v2-worker', randomUUID());
  assert.ok(staleV2Lease);
  const v3 = randomBytes(32);
  const activeKeysV3 = new StaticKeyProvider('v3', new Map([['v1', v1], ['v2', v2], ['v3', v3]]));
  const v3Vault = new CredentialVaultService(repo, activeKeysV3, new AllowVaultAccess());
  const rotationV3 = await v3Vault.beginRotation(actor);
  let staleTransformCalls = 0;
  await assert.rejects(repo.rotateBatch(staleV2Lease, 1, (record) => {
    staleTransformCalls += 1;
    return record.envelope;
  }, (record, keyVersion) => ({
    tenantId: record.tenantId, credentialId: record.credentialId, actorRef: actor.actorRef,
    correlationId: actor.correlationId, action: 'ROTATE', operation: 'CREDENTIAL_KEY_ROTATION', keyVersion,
  })));
  assert.equal(staleTransformCalls, 0, 'a v2 worker cannot transform after v3 becomes active');
  await assert.rejects(authorizedVault.resumeRotation(actor, rotation.targetKeyVersion), CredentialVaultRotationError);

  const v3FirstBatch = await v3Vault.rotateNextBatch(actor, rotationV3.targetKeyVersion, 1);
  assert.equal(v3FirstBatch.processed, 1);
  assert.equal(v3FirstBatch.done, false);
  const restartedWorker = new CredentialVaultService(repo, activeKeysV3, new AllowVaultAccess());
  const resumedBatch = await restartedWorker.rotateNextBatch(actor, rotationV3.targetKeyVersion, 1);
  assert.equal(resumedBatch.processed, 1);
  assert.equal(resumedBatch.done, true);
  assert.equal((await restartedWorker.rotationState(actor, rotationV3.targetKeyVersion)).state, 'COMPLETED');
  await assert.rejects(oldWriter.beginRotation(actor), CredentialVaultRotationError, 'a retired v1 cannot become active again');
  await assert.rejects(oldWriter.resumeRotation(actor, 'v1'), CredentialVaultRotationError);
  await assert.rejects(
    oldWriter.store({ ...lateBinding, ...actor, secret: 'synthetic-stale-writer-after-completion' }),
    CredentialVaultOperationError,
  );
  const recovered: string[] = [];
  await Promise.all([first, second].map((context) =>
    restartedWorker.withCredential({ ...context, ...actor, operation: 'MESSAGE_SEND' }, async (secret) => { recovered.push(secret); })));
  assert.deepEqual(new Set(recovered), new Set(['synthetic-credential-A', 'synthetic-credential-B']));
  assert.ok(repo.auditRows.filter((entry) => entry.action === 'ROTATE').length >= 2);
  assert.ok(!JSON.stringify([...repo.records.values()]).includes('synthetic-credential-A'));
  v1.fill(0);
  v2.fill(0);
  v3.fill(0);
});
