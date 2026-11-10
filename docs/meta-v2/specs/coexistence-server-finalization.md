# SPEC · WhatsApp Business App Coexistence server finalization

Status: implemented local boundary; provider adapter remains disabled. Issue: [#52](https://github.com/costaapps/ca_meta_app/issues/52). Depends on [M4.05 browser correlation](coexistence-embedded-signup.md), [M4.11 subscription reconciliation](meta-subscriptions.md), M3.06 asset/authorization catalog, and M3.08 credential resolution. ADR: [ADR-014](../adrs/ADR-014-m4-06-coexistence-server-finalization.md). Functional owner: Meta integration.

## Goal and bounded behavior

The generic M4.03 saga has durable checkpoints for authorization, asset verification, subscription and projection. This package provides a separate `WHATSAPP_COEXISTENCE`/`WHATSAPP_BUSINESS_APP_ONBOARDING` adapter boundary for that saga. The one-use code is passed only to a code-exchange port that owns vault persistence; the generic saga receives an internal authorization reference. Asset discovery takes the server authorization and onboarding ID, returns internal asset references only, and requires one verified phone-to-business-account pair. Subscription goes through M4.11 using a verified worker service scope. READY continues to depend on the existing saga's owned authorization/assets and successful subscription/projection checkpoints.

The adapter exposes no phone registration, deregistration or asset deletion method. It does not call Graph directly or accept provider IDs from the browser. Its disabled runtime ports perform no provider work. No new migration or public endpoint is introduced in this slice.

## Invariants and authorization

- The adapter rejects any flow/auth pair except `WHATSAPP_COEXISTENCE` + `WHATSAPP_BUSINESS_APP_ONBOARDING` before a port is called.
- The exchange port must use the exact server-pinned app/config/environment and flow contract. It stores any returned credential in `CredentialVaultService` and returns only an internal authorization reference. Raw code/token values cannot appear in the saga's output or projection contract.
- Discovery is limited to the exact tenant, onboarding authorization, app and environment. It verifies a current phone grant and a `PHONE_TO_ACCOUNT` relation before returning an internal phone ref and internal WhatsApp business-account ref. A missing/ambiguous result fails the asset stage; the browser cannot choose a provider object ID.
- M4.11 receives an internal phone asset ref and internal authorization ref. A verified service scope is resolved from the worker identity and tenant derived from the durable job. The subscription stage is successful only when M4.11 reports `ACTIVE`, desired `SUBSCRIBED`, and observed `SUBSCRIBED`.
- An ambiguous M4.11 result is never converted to success. The generic saga retains per-stage checkpoint state. Subscription retries use the stable `${onboardingId}:subscription` idempotency key and reuse the saved authorization/asset checkpoints; they do not exchange the one-use code again.
- Ambiguous subscription reconciliation uses a separate read-only observation port. `MetaSubscriptionService.reconcile` is not used as a read-only check because it may reconcile provider state and perform a subscription write.
- App credentials and root tokens are not fallbacks. No code uses `SYSTEM_ROOT_USER_TOKEN` or another global token.

## Contract and scenarios

| ID | Scenario | Local behavior/evidence source | Remaining proof |
|---|---|---|---|
| M4.06.AC01 | Number remains usable in WhatsApp Business and API access is validated | The server adapter requires verified grant/asset evidence and observed subscription before this saga can progress. | **Not confirmed**; authorized Sandbox test with the exact application, token family and number is required. |
| M4.06.AC02 | Coexistence never makes conventional registration or destructive calls | Adapter ports provide no register/deregister/delete operation; the M4.08/M4.04 transport adapters are separate. | Run the focused transport-spy harness on the package candidate; actual provider path stays disabled. |
| M4.06.AC03 | Incompatible code/asset/grant never becomes ready | Exchange returns only an internal authorization ref; verified assets must be internal UUIDs and owned by the exact saga authorization in M4.03 checkpoint validation. | Contract tests on synthetic inputs; real code/grants remain **Not confirmed**. |
| M4.06.AC04 | Subscription retry does not repeat authorization or duplicate resources | M4.03 checkpoints retain authorization and asset refs; M4.11 owns stable bindings, target lock, idempotent read-before-write and verification. | Synthetic tests planned in `tools/m4-06`; Sandbox/provider duplicate behavior remains **Not confirmed**. |
| M4.06.AC05 | Four phone grants remain associated under distinct or shared authorizations | Each saga binds one phone ref to an exact authorization ref; M4.11 binding identity includes asset and authorization while shared WABA target state is refcounted. | Synthetic four-phone test planned; real four-number Sandbox completion remains **Not confirmed**. |

## Asset selection and partial outcomes

An omitted browser asset ID is not a reason to use a guessed ID. The server-owned discovery port must paginate the authorized scope and prove phone/account linkage. It returns one selected verified pair or `NO_ELIGIBLE_PHONE`, `GRANT_NOT_CONFIRMED` or `SELECTION_REQUIRED`; non-verified outcomes cannot advance the saga. The current package has no authenticated endpoint for the user to choose among multiple discovered phones. Until a reviewed selection contract is available, ambiguous discovery remains partial and the product provider adapter stays disabled. No asset is arbitrarily selected.

The existing M4.03 saga persists status/next-action and the four stage checkpoints. The local adapter maps success only from owned internal refs and confirmed M4.11 observation; `UNKNOWN` and `NO_EFFECT` remain distinct so an ambiguous effect is not blindly repeated. The local runtime has no configured Coexistence exchange, discovery, subscription-worker actor, projection, or read-only observation adapter.

## Credential and asset persistence

The exchange port owns the full authorization/credential persistence operation: it writes token bytes only through M3.07's vault service and returns an authorization ref. The asset verifier uses M3.06 `MetaAssetsRepository` with trusted provider evidence; the internal credential handle is stored only in the existing credential/asset authorization relation. The worker's `assertOwnedOnboardingSagaEvidence` then verifies each reference against the same tenant, app, environment, flow and authorization before checkpointing it. This package adds no duplicate credential tables or schema migration.

## Provider evidence and external limits

The [official Meta Embedded Signup Postman collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup) describes common Embedded Signup operations, including conventional registration and WABA subscription. It does not establish the exact Coexistence code-exchange endpoint, Business Integration token family, grants, expiry, returned assets or current subscription eligibility. Those details are **Not confirmed**. Do not transfer standard WhatsApp Cloud `/register` steps or permissions to Coexistence. No app-specific Sandbox or real Meta operation has been executed.

The local adapter is intentionally not installed by `configuredMetaOnboardingSagaAdapter()` in `apps/api/src/worker/main.ts`. M4.05 browser launch and code submission also remain unavailable without exact current first-party SDK/event evidence and an enabled reviewed profile. M4.07 owns history/state/echo ingestion; those optional streams do not gate this package's local subscription boundary unless later requirements prove otherwise.

## Validation and recovery

Focused harness: [`tools/m4-06/README.md`](../../../tools/m4-06/README.md). Command: `node tools/m4-06/run-focused-test.mjs`. It compiles the small adapter dependency graph into an OS temp folder and cleans it in `finally`; the fixtures contain only generated UUIDs, synthetic code, synthetic assets and fake service results. The coordinator runs it once on the exact package candidate. It has not been run by the implementer.

No migration is needed. Recovery uses M4.03 stage actions: authorization is never resumed with the same code; asset/subscription work may resume only from persisted authorization and verified assets; ambiguous effects require read-only reconciliation. If app grants, token family, asset relation or subscription target cannot be proven, keep the session partial/action-required and do not publish READY.

## Rollout and rollback

There is no rollout flag that can enable a provider adapter by itself. The worker remains unconfigured. A future implementation must add exact Meta primary-source evidence, a token/asset/subscription adapter, authenticated selection when needed, a read-only reconciliation route, and tests/reviews on the exact configuration before the runtime can be wired. Rollback is omission of that adapter; existing M4.03/M4.11 records remain untouched. No destructive cleanup is used as compensation.
