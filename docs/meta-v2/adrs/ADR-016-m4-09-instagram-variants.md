# ADR-016 — Keep Instagram authentication variants isolated

- **Status:** Accepted for the M4.09 implementation boundary; provider behavior and app eligibility remain **Not confirmed**
- **Date:** 2026-11-10
- **Issue:** [#51](https://github.com/costaapps/ca_meta_app/issues/51)
- **Spec:** [M4.09 Instagram onboarding variants](../specs/instagram-integration.md)

## Context

The current product flow is Instagram via Facebook Login. Instagram Login is an optional technical variant, not an additional required product journey. Meta's maintained [Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api) distinguishes the variants. Its Facebook Login example uses `GET /me/accounts?fields=name,access_token,tasks,instagram_business_account` and returns a Page token for a Page linked to a professional Instagram account; the same collection excludes consumer accounts from that path. Its Instagram Login section shows different `instagram_business_*` permission names and a separate API setup. These collection examples do not establish this app's grants, app review, token exchange/refresh contract, subscription behavior or Graph version.

The accepted M4.03 saga supports separate onboarding callback/auth variants and rejects mismatches. Its persisted authorization tuple maps `INSTAGRAM_VIA_FACEBOOK_LOGIN` to `INSTAGRAM` / `FACEBOOK_LOGIN_FOR_BUSINESS`. The credential resolver is asset-scoped, so it cannot resolve an initial User Access Token before a verified asset exists. M3.07 has no atomic tenant-scoped enrollment boundary for initial token metadata and secret. M4.11 currently has no confirmed Instagram subscription provider. The existing M4.03 runtime adapter is not registered by default.

## Options

| Option | Benefit | Cost/risk | Evidence |
|---|---|---|---|
| Adopt Instagram Login as the first production implementation | Direct account model and separate API family | It changes the existing baseline and introduces new scope, exchange, refresh, webhook and account eligibility requirements | No app-specific or Sandbox evidence; rejected for now |
| Preserve Instagram via Facebook Login baseline; keep Instagram Login separate and optional | Matches the observed baseline and official collection's explicit variant split | Initial token resolution, Page-token enrollment, grants and Page subscription contract are still absent | Official collection describes the linked Page discovery shape; exact app behavior remains **Not confirmed** |
| Share one generic Instagram/Facebook token and scope setup | Fewer code paths | Blurs authorization family, can select the wrong credential and creates false capabilities | Rejected by M1.03 and M3.08 boundaries |

## Decision

1. Preserve Instagram via Facebook Login as the baseline production choice. Keep Instagram Login as a distinct optional variant; do not enable it based on collection examples alone.
2. Match the M4.03 callback flow and auth variant exactly before any provider call. Map the callback variant explicitly to the persisted M3.06 authorization variant; never let a browser choose either mapping.
3. Use separate server configuration, host, scopes, credential selection and operation capability for each auth variant. Reject known scope-family markers from the other variant; this is only a mixing guard and not a minimum/approval policy. The Facebook Login variant requires a same-authorization Page relation. Instagram Login has no Page relation.
4. Keep raw tokens inside a future vault-owned provider port. Persist a complete discovered asset set atomically with opaque internal credential references and verified relation evidence. Zero accounts and incomplete discovery remain partial/recoverable.
5. Block successful readiness until every required selected asset has a confirmed active subscription and projection. Unknown/partial results do not authorize readiness or a blind write retry.
6. Add an Instagram-specific saga adapter seam and synthetic contract tests. Do not register it until the initial authorization handle, tenant-scoped vault enrollment, app-specific grants and subscription/webhook semantics are implemented and reviewed.
7. Do not add message/comment mutations in this package while operation-specific grants, response contracts and authorized Sandbox behavior remain **Not confirmed**.

## Security, effects and reversibility

- **Tenant and asset authority:** M4.03 binds onboarding to the verified session; the adapter consumes only its server-owned tenant/config context and internal asset references. Same-authorization Page lineage must be verified by the persistence/credential catalog.
- **Credential custody:** provider code exchanges and vault writes remain behind future server-side ports. No tokens or app secrets enter adapter results, fixtures, logs or browser DTOs.
- **External effects:** read-only discovery requires a complete result before persistence. Unknown code exchange is never replayed. Subscriptions are blocked unless the provider returns an observed active receipt for the same asset set.
- **Reversibility:** the adapter is not registered by default. It can be enabled after the enrollment/subscription contracts and external evidence are available; no schema migration or provider effect is performed by this decision.
- **Boundaries:** no Instagram Login adoption, Facebook product connection side effect, WhatsApp credential reuse, message send, comment reply, or live Meta action is included.

## Proof, rollout and recovery

The synthetic harness is `node tools/m4-09/run-focused-test.mjs`. It covers variant mismatch, Page-link rules, empty and partial discovery, atomic persistence receipts, subscription evidence and read-only reconciliation. It is not a real Meta test. The M4 coordinator will record command, Node/npm versions and candidate SHA after rebasing. Real app, grants, Sandbox assets, Graph version and webhook delivery remain **Not confirmed**.

Before provider registration: complete a tenant-scoped initial user-token handle and atomic vault-enrollment API; verify variant-specific M4.01 config/grants; add exact Instagram subscription behavior to M4.11; add guarded selection/status UX if required; run the account/link/subscription/webhook/message/comment Sandbox matrix. Roll back by disabling the provider profile. Do not delete prior Facebook, Instagram or WhatsApp assets to recover a partial Instagram onboarding.

## Revisit when

The initial credential resolver and vault enrollment are available and current official documentation plus authorized app-specific Sandbox evidence establish a variant's exchange, scopes, eligible account/Page relationship, token lifecycle, subscriptions, webhooks and approved message/comment behavior. Update M4.01 capability evidence, M3.08 resolver policy, M4.11 subscriptions, this spec, adapter and tests together.
