# ADR-021: M5.07 tenant-bound internal service operations

- **Status:** Accepted for local implementation; provider and deployment gates remain open
- **Date:** 2026-11-11
- **Issue:** [#62](https://github.com/costaapps/ca_meta_app/issues/62)
- **Spec:** [Internal service asset operations](../specs/internal-service-operations.md)
- **Related decisions:** [M3.08 credential resolver](../specs/credential-resolver.md), [M4.02 Graph boundary](ADR-011-m4-02-graph-transport-boundary.md), [M4.11 subscription reconciliation](ADR-020-m4-11-subscription-reconciliation.md), [M4.14 certification evidence](../../delivery/M4/M4.14.md)
- **Evidence base:** `c3e9baa75ea793d74292e62038e0d8d11bb61295`; runtime consumers and production deployment are **Not confirmed**.

## Context

The M5.07 issue requires `/internal/v1/assets/:id/operations`, least-privilege machine authentication, tenant context derived from the service identity, typed operations, per-asset grants, idempotency, status for ambiguous sends, and no global token fallback. Versioned PHP sources show global-token template/send/subscription paths; external operational consumers and the deployed PHP rewrite are not available in this repository.

The earlier M1.07 v1 proposal at that path is already frozen in `openapi-v1.baseline.yaml`: it uses `kind` values `SEND_REPLY`, `MARK_READ`, and `REFRESH_STATUS`, a `JobAccepted` response with a `Location` header, HTTP 412/413/422/429 outcomes, and the original `internalServiceAuth` contract. Replacing that schema with M5's operation union, hash-mapped proof, status-only result, and reduced response set generated 25 breaking-diff items. The checker is correct; those changes cannot be called additive on v1.

Existing code supplies the required boundaries: M3.08 issues one-use credential handles after checking service scope, asset, grant, lifecycle and policy; M3.09 records lifecycle state; M3.10 provides metadata-only redacted audit; M4.14/Graph client restrict provider transport and keep real Meta capability gates closed. The Meta-assets module installs fail-closed credential policy/audit adapters, and no real asset-operation provider adapter exists.

## Options

| Option | Benefit | Cost/risk | Evidence |
|---|---|---|---|
| Trust `company_uuid`, an arbitrary provider ID, or a shared root token | Simple legacy compatibility | Recreates cross-tenant/global-token risk and bypasses M3.08 selection | Rejected by M1.01/M1.07 and tenant/credential contracts |
| Verify a signed self-contained workload token | Supports issuer-managed short lifetimes | Issuer, audience, key rotation and Suite4/runtime issuance are not confirmed | No deployment issuer or proof was found in the assigned sources |
| Hash-only server-configured proof mapped to one principal and tenant; recheck dynamic database grants per request | Smallest local boundary; no tenant claims supplied by caller; rotation/revocation can be rehearsed locally | Requires protected configuration rollout and a real caller identity owner; revocation of the proof requires all replicas to reload | M3.01 service scope model; local verifier tests; external distribution remains **Not confirmed** |

## Decision and consequence

Implement the third option for the local internal API. `API_INTERNAL_SERVICE_CREDENTIAL_HASHES_JSON` stores only SHA-256 digests and exact principal/tenant UUID mappings. Proofs must be high-entropy (at least 32 bytes). Every POST verifies the proof, resolves current service grant, checks `META_CONNECTION_EXECUTE` and `CREDENTIAL_USE`, loads one verified active asset authorization under that derived tenant, checks the server capability profile, resolves any recipient/comment reference within that tenant and asset, and asks M3.08 for a one-use credential handle. Status reads are bound to the same principal and tenant. Caller payloads cannot select tenant, auth flow, app configuration, provider object ID, credential, or Graph URL. The Msg4 target-directory adapter is absent, so send/reply commands remain unavailable.

Preserve the v1 path, schema, security scheme and responses exactly as frozen in `openapi-v1.baseline.yaml`. Publish the M5 typed-proof request and status result additively at `POST /internal/v2/assets/{assetId}/operations` and `GET /internal/v2/operations/{operationId}`, using the separately named `InternalAssetOperationV2Request`, `InternalAssetOperationV2Result`, and `internalServiceProofV2` contract. Runtime exposes the v2 surface only; v1 is not an alias for v2. The issue's originally requested path version therefore changes and needs owner acceptance before PR acceptance. Do not edit the baseline or suppress the breaking checker.

Allow only the typed operations declared in the canonical OpenAPI contract. `UNKNOWN` idempotency records are inserted before adapter invocation and never automatically retried. The ledger stores hashes and metadata, and M3.10 audit events store only fixed status/reason codes. Optional provider references are hashed before internal persistence. No success is fabricated when the operation adapter, current provider capability evidence, or credential policy is unavailable.

The v2 routes are excluded from Nest's `/api/v1` prefix, but still pass host and request security middleware. POST without a browser Origin is admitted only on the exact v2 operations path and only to reach the controller's mandatory bearer verification. This is not a browser session or public portal path. The earlier v1 proposal is retained in the canonical contract but is not implemented by this typed-proof bridge.

## Security, effects, and reversibility

- **Tenant boundary:** tenant derives from the verified proof mapping and is rechecked against current service grants; the asset query includes both tenant and internal asset UUID and requires exactly one active verified authorization. A mismatch returns a safe unavailable result.
- **Credential boundary:** only M3.08 selects credentials. No root/system token lookup, generic decrypt path, arbitrary Graph URL, token response, or web storage is used.
- **Least privilege:** require both `META_CONNECTION_EXECUTE` and `CREDENTIAL_USE` before operation claim, then the resolver rechecks `CREDENTIAL_USE` at resolution and handle consumption.
- **Ambiguous effect:** the metadata idempotency claim is committed first. A thrown adapter response becomes `UNKNOWN`; a duplicate key returns the saved operation without another call. A raw provider message ID is not persisted; only an optional hash is retained.
- **Rotation/revocation:** overlap hash mappings, roll all replicas, switch the caller, then remove the old hash and roll again; database grants are revalidated per request. Real caller secret distribution and rotation schedule remain **Not confirmed**.
- **Rollback:** disable the route/adapter or restore one legacy writer before effects are enabled. Never run shadow-send/two writers. A sent message cannot be rolled back, and `UNKNOWN` requires reconciliation first.
- **Bounded scope:** this ADR does not implement a provider adapter, PHP compatibility facade, deployed routing, Suite4 issuer, Meta approval, actual migration, or production credential distribution.

## Proof, deployment, and recovery

The package harness uses synthetic principals, assets, proof strings, typed payloads, and fake repositories/adapters. It covers proof rotation/revocation, missing scopes, tenant/asset mismatch, schema rejection, concurrent idempotency, conflict, `UNKNOWN` no-retry, audit/status redaction, and exact middleware path bypass. It does not prove a real grant, external PHP parity, Meta Sandbox, App Review, Suite4, or production behavior. Exact commands and result environment are recorded in the M5.07 handoff and PR; no deployment or real API call is authorized by this decision.

## Review trigger

Revisit when the service identity issuer/distribution and revocation owner are confirmed, a production Meta adapter is independently reviewed, or a consumer requires a contract not represented by the closed operation union. Any contract change updates the OpenAPI spec, consumer map, adapter, redaction tests and migration evidence together.
