# SPEC — Cofre criptografado de credenciais

Status: proposed M3.07 implementation; exact-candidate validation pending. Production custody and restore remain **Not confirmed**. Issue: [#32](https://github.com/costaapps/ca_meta_app/issues/32). Contract: [domain and credential model](../03-domain-data-and-credentials.md), [ADR-008](../adrs/ADR-008-credential-vault.md), [credentials](credentials.md).

## Boundaries

- Store only encrypted credential envelopes against an already-created, active `MetaCredential`. The composite identity is tenant, credential, authorization, app configuration, provider and environment.
- Use AES-256-GCM with a fresh 12-byte nonce, 16-byte tag, format version, key version and AAD over the key version and entire composite identity, including credential family. A ciphertext, tag, key-version or binding mismatch fails closed.
- Read key versions through `CredentialKeyProvider`; the runtime configuration currently uses protected `API_CREDENTIAL_KEYRING_JSON` input. A missing active/previous key blocks the operation; startup never creates a replacement key.
- Require an injected server-side authorization port for store, use and global rotation. Default wiring denies all vault actions until a verified service policy is connected. No public decrypt endpoint or browser DTO exists.
- Deliver plaintext only to the internal operation callback, after recording metadata-only audit. Provider exceptions are sanitized before leaving the vault boundary.
- Rotate to the configured active key in bounded batches. DB lease owner/token/expiry fences competing workers. Credential updates, audit rows and the checkpoint commit together. Crashes resume from the last committed credential; invalid ciphertext or missing old key pauses safely.

## Persistence

Migration `202610300009-credential-vault` (schema version 9, after M3.03 v8) adds:

- `ca_meta_credential_secrets`: binary envelope and duplicated context protected by a composite foreign key to credential metadata.
- `ca_meta_credential_rotations`: one versioned rotation state per target key, with resumable cursor and expiring lease.
- `ca_meta_credential_access_audit`: append-style metadata for store/use/rotation without ciphertext or plaintext.

The existing M3.06 metadata table and public read model do not acquire secret fields. Rotation does not revoke provider tokens or erase revoked credentials; those are separate lifecycle operations.

## Reproducible validation

Toolchain: Node `24.22.2`, npm `11.19.1`; the MariaDB profile uses the existing digest-pinned MariaDB `11.8.8` Compose service. Tests generate random synthetic marker secrets and keys in memory; no values are checked in or printed.

From the repository root after `npm ci --ignore-scripts` and the normal contract workspace rebuild:

```powershell
npm exec --workspace=@ca-meta/api -- tsc -p tsconfig.test.json
node --test apps/api/dist-test/test/m3-07-credential-vault.spec.js apps/api/dist-test/test/m3-07-credential-vault-migration.spec.js
pwsh -NoLogo -NoProfile -File tools/m2-05/run-mariadb-tests.ps1
```

The M2.05 script creates and removes only its UUID-named disposable Compose project and generated files. It executes the normal M2.05/M3.06 integration cases and `m3-07-credential-vault.integration.spec.js` against its isolated MariaDB. Expected M3.07 unit coverage is 3 passing cases; the MariaDB case verifies two synthetic tenants, encrypted row contents, one-lease concurrency, crash/checkpoint resume, metadata-only audit, and decrypt recovery using an authorized retained key version. The restore subcase moves a captured ciphertext envelope back into the isolated test table; this models authorized key recovery but is not a physical backup artifact restore.

A local ciphertext restore check is not a substitute for a production backup/restore exercise. KMS custody, DB backup access policy, operational key retention, key-compromise response and real provider credentials remain **Not confirmed**.

## Incident distinction

- **Vault key suspected compromised:** deny credential work and new job claims through the service authorization/control plane, preserve evidence, select a new authorized key version, and decide per exposure whether ciphertext may be safely decrypted for re-encryption. Remove the old key only after every required ciphertext/backup has a planned disposition. If confidentiality of stored tokens may have been lost, rotation alone does not restore secrecy.
- **Provider token suspected compromised:** block that credential and affected jobs, invalidate resolver/cache entries, revoke the provider grant through the authorized provider process, then complete reauthorization. Encrypting it under a new vault key does not revoke the provider token.
- The provider revocation process, production job control plane, cache implementation, approval owner and external incident response remain **Not confirmed** until those services and roles are implemented and tested.
