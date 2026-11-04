# SPEC — Tenant-scoped Meta flow and asset catalog

Status: M3.12 implementation candidate; issue [#40](https://github.com/costaapps/ca_meta_app/issues/40). Contract: [OpenAPI catalog routes and schemas](../contracts/openapi.yaml); domain inputs: [M1.03 capability matrix](../meta-capability-matrix.md) and [M3 credential model](../03-domain-data-and-credentials.md). Functional owner role: platform; supporting roles: backend/domain and security; people unassigned. Provider grants, tenant feature flags, Meta app eligibility and onboarding-to-asset bindings are **Not confirmed**.

## Problema e comportamento pretendido

The portal needs a bounded view of configured flow choices, tenant connections and verified Meta assets. Reads must use the current server-resolved tenant and environment, present observation freshness and safe operational capabilities, and never expose credentials or raw provider payloads. A successful local read is not evidence that Meta has approved or enabled the flow.

The catalog groups the five existing authorization journeys into four Meta flow families: Facebook, Instagram, WhatsApp exclusive and WhatsApp Coexistence. The legacy `variant` field continues to identify a journey; the optional `flowVariant` field identifies its family, and `journeys` lists all journeys in that family. Missing app configuration, adapter or confirmed tenant feature flag leaves a flow disabled with a safe availability reason. The current runtime has no registered flow or refresh adapter, so `enabled` remains false and actual provider eligibility is **Not confirmed**.

## Invariantes e autorização

- `PortalSessionGuard`, verified portal session, current tenant context and `TenantAuthorizationService` authorize every catalog read. `tenantId` comes from the server-resolved scope; `cUUID`, a supplied UUID, app ID or browser flag never grants access.
- Repository reads bind tenant, app configuration and environment in SQL joins/filters. No shared cache is used; request reads are scoped directly to the authenticated tenant. If a cache is added later, it requires a separate decision and keys covering tenant, role, app, environment, asset and version.
- Viewers can read only records permitted by their membership and receive all administrative capabilities as `false`. Capability booleans are advisory snapshots; each action must be authorized again at execution time.
- Positive `canSend` evidence must match both the flow and auth variant, have a fresh `HEALTHY` observation, a fresh expiry observation proving a future expiry (or explicit provider-declared no-expiry), and a fresh known future data-access expiry. The catalog uses a conservative one-hour observation bound; the resolver still applies its authoritative operation policy at use time. Instagram Login and WhatsApp exclusive Embedded Signup remain advisory mappings only. WhatsApp send is shown only on a verified phone-number asset; a WABA is a parent container. `canManageTemplates` and `canSubscribe` stay `false` until the accepted capability matrix confirms their operation-specific grants; expired, revoked, stale, unknown or action-required credentials never produce positive operation flags.
- `canReauthorize` includes an authorization explicitly in `REAUTH_REQUIRED` and an asset with an open M3.09 reauthorization intent (`PENDING` or `ACKNOWLEDGED`). The impact read is bound to the same tenant, environment, app, authorization and asset; a resolved intent does not remain actionable.
- Stale evidence remains explicitly stale and does not by itself assert disconnection. A separate, current Meta authorization observation may report a disconnected/revoked state.
- Public serializers use explicit allowlists. Access tokens, app secrets, raw provider payloads, external account identifiers and the internal app-configuration ID on asset/connection records are not returned. The flow catalog exposes an opaque app-configuration reference to distinguish configured contexts.
- Onboarding session rows have no persisted authorization or asset reference in the current schema. The catalog therefore reports onboarding status/readiness/action as `UNKNOWN`; a tenant-and-flow match is not enough to claim an asset binding.

## Contrato e dados

The canonical OpenAPI contract declares `GET /api/v1/integrations/flows`, `GET /api/v1/connections?cursor=&limit=&channel=&number=&status=`, `GET /api/v1/connections/{connectionId}`, `GET /api/v1/assets?cursor=&limit=&channel=&number=&status=`, `GET /api/v1/assets/{assetId}`, and `POST /api/v1/assets/{assetId}/refresh` (`202` with an accepted job). Reads return `200`; validation, session, authorization and missing-resource failures use the documented `400`, `401`, `403` and `404` responses; refresh also documents safe `503` unavailability. See the operation response tables for the complete status set.

Lists use bounded cursor pagination (maximum 100); filters cover channel, phone number, and status. Connection detail has a bounded asset projection. The SQL read model returns `lastVerifiedAt`, `verificationSource`, `stale`, safe capabilities and aggregate diagnostics across onboarding, token lifecycle, Meta authorization, webhook subscription and projection. Unknown, conflicting or unbound facts stay `UNKNOWN`. A verified asset observation older than 24 hours is marked stale; this is an application display threshold, not a Meta token-validity rule.

Reads use bounded SQL queries and one batched grant/evidence query for each asset page; no list render calls Graph or performs per-asset provider requests. Refresh is an asynchronous tenant-scoped durable job and coalesces duplicate active requests for the same tenant/asset. Adapter absence fails closed after the resource is looked up within tenant scope.

## Cenários verificáveis

| ID | Dado | Quando | Então | Evidência/teste |
|---|---|---|---|---|
| AC-01 | Viewer session in tenant A and records in A/B | Lists or reads catalog data | Only server-scoped records are returned; admin capability flags are false | `apps/api/test/m3-12-asset-catalog.spec.ts` |
| AC-02 | Verified evidence older than the local freshness window | Asset or connection is read | Response reports `stale`/`STALE` without inferring disconnection from age alone | `apps/api/test/m3-12-asset-catalog.spec.ts`; tenant-scoped SQL read model |
| AC-03 | WhatsApp exclusive and Coexistence configurations | Flow catalog is read | Separate variants/journeys and per-app/environment prerequisites are returned | `apps/api/test/m3-12-asset-catalog.spec.ts`; OpenAPI `FlowList` |
| AC-04 | Two sessions resolve different tenants | Both read their catalog | Each query carries its own server-resolved tenant; no cross-tenant cache is present | `apps/api/test/m3-12-asset-catalog.spec.ts`; repository SQL filters |
| AC-05 | Many assets and no registered provider adapter | Portal lists or refreshes an asset | List is paginated with batched local SQL; reads do not call Graph; refresh returns accepted job only when an adapter exists | `apps/api/test/m3-12-asset-catalog.spec.ts`; API test command below |
| AC-06 | No app configuration, provider binding or confirmed onboarding relation | Flows and diagnostics are read | Availability is explicit and unsupported onboarding/provider facts remain disabled or `UNKNOWN` | `apps/api/test/m3-12-asset-catalog.spec.ts`; synthetic OpenAPI examples |
| AC-07 | Token health or expiry evidence is stale, expired, incomplete, or on a WABA parent | Capabilities are calculated | `canSend` is false unless current valid token/data-access evidence supports a phone-number target | `apps/api/test/m3-12-asset-catalog.spec.ts` |
| AC-08 | M3.09 has a pending/acknowledged or resolved reauthorization impact | The catalog reads an asset | Only open, tenant/environment/app/authorization/asset-scoped intents make `canReauthorize` available | `apps/api/test/m3-12-asset-catalog.spec.ts`; bounded SQL query |

## Implementação em fatias

1. Keep the existing authorization boundary and bounded list/detail route behavior.
2. Add tenant/app/environment-scoped SQL projections for freshness, grants, token lifecycle, subscription and projection summaries.
3. Serialize explicit four-variant flow choices and capability/diagnostic allowlists; keep unknown prerequisites disabled.
4. Retain the coalesced refresh job boundary and fail closed when no Meta adapter is installed.
5. Update canonical OpenAPI, generated contract artifacts and synthetic assertions together.

## Migração, rollout e recuperação

No schema migration or provider effect is introduced by this catalog slice. Reads are projections over existing M3.06–M3.09 tables. There is no cache to invalidate. The 24-hour stale threshold is reversible in the read-model query. Refresh effects remain gated by an installed adapter; current provider behavior and production configuration are **Not confirmed**. Rollback removes the catalog projection/route code without deleting provider authorizations or assets.

## Validação e evidência

Focused command for coordinator CI: `npm run test:m3-12 --workspace=@ca-meta/api`. The canonical OpenAPI client outputs were regenerated once with `npm run generate --workspace=@ca-meta/contracts` and `npm run generate --prefix tools/m1-07`. Tests, build, lint, typecheck and generated-output check commands were not run per the coordinator's time-saving instruction. Synthetic fixture assertions are not provider, tenant-production, App Review or permission evidence. Environment and accepted candidate SHA are recorded in the package handoff/PR, not embedded before commit.

## Alterações de escopo

The issue names an onboarding aggregate, but current onboarding-session storage has no foreign key or binding to an authorization or asset. Reporting `UNKNOWN` is the safe current contract; creating a guessed join or inventing DDL would overstate readiness. Confirming that relationship, tenant feature flags, Meta permissions, app approvals and actual flow availability remains **Not confirmed** and requires separately evidenced contracts/adapters.
