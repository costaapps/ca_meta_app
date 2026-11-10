# ADR-014 — Facebook Login for Business Pages

**Status:** Accepted for the M4.08 implementation boundary; external provider behavior remains **Not confirmed**

**Date:** 2026-11-10

**Issue:** [#50](https://github.com/costaapps/ca_meta_app/issues/50)

## Context

Facebook Pages use an independent Login for Business authorization family. The Meta-maintained Facebook API collection documents Page discovery through `/me/accounts` using a User Access Token, returning Page IDs, names, Page Access Tokens and tasks with pagination. The current checkout does not contain an authorized provider configuration, current app-specific scope evidence or a tenant-scoped credential-enrollment path. M4.11 supports WABA subscriptions only and Page Webhooks docs did not confirm a Page endpoint, permissions or field set.

M3.07 requires credential metadata to exist before the vault can store a secret. No tenant-scoped credential enrollment service currently creates that metadata and binds an asset credential safely. M4.03 deliberately leaves the saga adapter unconfigured when no provider implementation is available.

## Decision

1. Keep Facebook Login for Business isolated to `FACEBOOK_LOGIN` / `FACEBOOK_LOGIN_FOR_BUSINESS`. Do not reuse Instagram or WhatsApp scopes, callbacks, tokens or auth state.
2. Paginate the complete managed-Page list before persisting any Page from the result. Use Page-specific tokens per Page asset. Never return tokens in saga evidence, browser status, logs or audit data.
3. Treat Page tasks as observed role context, never as grants. Page capabilities remain disabled until the exact operation-to-permission map and current app grants are confirmed in M4.01.
4. Store Page selection through M4.11's existing target and binding tables, keyed by tenant/app/environment/Page asset and authorization. No schema v19 migration is required for selection state. Desired state and provider-observed state remain separate.
5. Extend the M4.11 catalog and service for only the exact `FACEBOOK` + `FACEBOOK_LOGIN_FOR_BUSINESS` + `FACEBOOK_PAGE` tuple. The existing Graph provider returns `PAGE_SUBSCRIPTION_NOT_CONFIRMED` without a Page Graph call. Do not infer a Page endpoint or subscribed field from WABA behavior.
6. Keep default provider/asset enrollment/projection adapters fail-closed. Do not insert credential metadata by ad-hoc SQL or create synthetic credentials in runtime code. Register a real onboarding adapter only after a tenant-scoped vault enrollment service and exact M4.01 config evidence exist.
7. Zero Pages and subscription/projection failure remain partial and recoverable. No Facebook flow may mutate WhatsApp templates or phone assets.

## Alternatives considered

- **Reuse the WABA subscription provider for Page:** rejected because Page endpoint, fields and grants are not confirmed.
- **Create Page-specific subscription tables:** rejected because M4.11 already stores tenant/app/environment/target intent and grant bindings in generic schema v18.
- **Insert credential metadata directly from the Facebook adapter:** rejected because it bypasses the missing shared enrollment boundary and could leave vault/asset binding inconsistent.
- **Treat Page tasks as messaging grants:** rejected because tasks are role observations and the operation permission mapping is unconfirmed.
- **Report READY after OAuth or Page discovery:** rejected because Page token enrollment, explicit selection, subscriptions and projection are still independently unverified.

## Consequences

The repository now has exact-variant Facebook onboarding orchestration, bounded pagination, Page selection through M4.11, safe capability projection, and a synthetic focused harness. The production path remains unavailable until a vault-backed enrollment provider, app-specific scopes/grants, Page subscription evidence, projection consumer, API action route and registered M4.03 adapter exist. This package does not claim external certification.

## Revisit when

The tenant-scoped credential enrollment service is available and first-party Meta documentation plus current app-specific Sandbox evidence confirm the required scopes, Page tasks/grants, token lifecycle, Graph version, subscribed endpoint and fields. Update M4.01 capability evidence, the M4.11 provider, Facebook Pages spec, this ADR and focused tests together.
