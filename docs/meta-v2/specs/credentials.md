# SPEC — Provider credentials and grant resolution

Status: proposed. Issues: [#14](https://github.com/costaapps/ca_meta_app/issues/14), [#16](https://github.com/costaapps/ca_meta_app/issues/16). Contracts: [domain model](../m1-05-domain-model.md), [ADR-005](../adrs/ADR-005-secrets-legacy.md), [error catalog](../contracts/error-catalog.md). Functional owner: backend/security; people unassigned. Provider grant, expiry and revocation observations: **Not confirmed**.

## Problem and scope

Select an authorized credential for one tenant, app, environment, provider, asset and operation without a shared root token or browser-visible secret. This covers storage references, resolution, observed health and selective revocation; real KMS, app configs and provider grants are later gates.

## Invariants

- A credential is owned by an authorization/grant and its tenant, provider/app/environment, family, scopes and version; it is not a global company/app/number token.
- Plaintext token, authorization code, ciphertext, nonce, KMS handle and raw provider response are backend-only. DTOs/logs contain only safe references and allowlisted status.
- Resolver fails closed unless session membership, asset grant, operation, app configuration, environment and credential family all match.
- Expiry is `KNOWN`, `UNKNOWN`, or provider-declared no-expiry with provenance. An absent expiry or literal `Never` is not proof of validity.
- Reauth creates a new authorization/credential version. Revoking one grant or asset does not erase another valid authorization.

## Contract and data

Use `MetaAuthorization`, `MetaCredential`, `AssetAuthorization`, and `MetaAppConfig` from `m1-05-domain-model.md`; secrets use `secret_ref`, version and server-side encrypted storage. Operation resolution follows the flow/capability registry and M1.07 safe error contract. No actual key service or token family is declared verified here.

## Scenarios

| ID | Given | When | Then | Evidence |
|---|---|---|---|---|
| CRED-01 | Grant and asset belong to same tenant/app/environment and allow operation | Resolver selects credential | Only opaque server reference is returned to adapter | M1.05 readiness/tenant fixture |
| CRED-02 | Credential is for another tenant, app, environment or operation | Resolver is asked to use it | Deny; no fallback to root/global token; no provider call | M1.05 security scenarios + future resolver tests |
| CRED-03 | Expiry observation is absent/stale or revocation is partial | Status is refreshed | Preserve `UNKNOWN`/`STALE` with provenance; do not claim validity | M1.02 mapping and M1.09 operation matrix |

## Implementation, migration and recovery

Use a versioned secret adapter and narrow access role; migration records refs/metadata, never prints or copies plaintext. Dry-run legacy credential mappings and ambiguity into quarantine. Rollback fences the new resolver by tenant/app/operation; it must not re-enable a global token. Real secret storage, key rotation, restore and provider grant validation block production enablement.
