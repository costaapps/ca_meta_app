# M4.01 — Meta app configuration and capability review runbook

**Package:** M4.01 / issue [#42](https://github.com/costaapps/ca_meta_app/issues/42)
**Base:** `develop` at `b35e0ddae5ce09df2ca2ce09785be4332e653803`
**Evidence date:** 2026-11-06
**Status:** Local runtime registry and fail-closed bootstrap implemented; app-specific Meta approval and Sandbox evidence are **Not confirmed**.

## Configuration boundary

`API_META_APP_CONFIGS_JSON` is server-only process configuration. It is optional: when absent, API
startup succeeds and every flow reports `CONFIGURATION_MISSING`. When present, it must be a JSON
array with one profile per exact `(environment, flowVariant, authVariant)` pair. The registry keeps
the four product journeys distinct and the Instagram Facebook Login and Instagram Login variants
separate. A profile carries `providerAppIdRef`, never the numeric app ID.

The numeric provider ID is resolved only from `API_META_TRUSTED_APP_IDS_JSON`, a separate protected
allowlist mounted for the current environment. Each row binds `environment`, `flowVariant`,
`authVariant`, `providerAppIdRef` and `providerAppId`; the parser rejects rows whose environment is
not exactly `NODE_ENV` and rejects profiles whose reference has no exact allowlist match. Keep this
source environment-specific in the deployment system. Code cannot infer the real Meta environment
from a numeric app ID, so staging allowlist values must come from the independently managed staging
Meta app record; do not copy production IDs into it.

The API validates the profile environment against `NODE_ENV` and requires `appMode=LIVE` only in
production. Development, test and staging require `appMode=DEVELOPMENT`; a staging profile therefore
cannot select a production/live app mode. App IDs are separately allowlisted per runtime environment,
and app-secret/token refs must have the exact `NODE_ENV` namespace segment. The callback URI and redirect allowlist must use exact HTTPS
origins already configured in `API_ALLOWED_ORIGINS`, and normalized `appDomain` must equal the callback host.
The Graph host is derived from the allowlisted auth variant. User-supplied URLs, wildcard hosts and
redirect URIs are not forwarded to Meta.

The profile contains references such as `vault://meta-app/staging/wa-coexistence/app-secret`, never app
secret or access-token values. Staging rejects a `production` ref namespace even when the profile
declares `appMode=DEVELOPMENT`. The public `GET /api/v1/meta/bootstrap` route requires a verified
portal session and projects only allowlisted fields. It omits secret references, Graph endpoint,
callback and redirect URIs. Public app/config IDs are hints for the UI and confer no tenant authority.
The onboarding session and tenant membership checks remain the authority boundary.

## Versioned capability evidence

The server capability manifest is
[`apps/api/src/meta-config/capability-manifest.ts`](../../apps/api/src/meta-config/capability-manifest.ts),
current version `m4.04-2026-11-10.1` (the M4.01 baseline was bumped by M4.04 to add the exclusive-only
conventional phone registration operation). Its permission candidates extend (and do not replace) the
[M1.03 capability matrix](../../meta-v2/meta-capability-matrix.md) and synthetic offline harness.
The M1.03 fixture IDs and version labels remain synthetic; its negative Coexistence registration
case is preserved.

Each profile carries separate evidence for Graph API, JavaScript SDK and Embedded Signup. A version
may be marked `VERIFIED` only with an official Meta URL and verification date. The current source
review found Meta's v27.0 announcement from 2026-11-04 while the available changelog snapshot still
showed v26.0 as latest. Therefore endpoint compatibility and the production Graph version are
**Not confirmed**; neither v26.0 nor v27.0 is an automatic default. SDK and Embedded Signup versions
are independent values.

The manifest records, by flow/auth variant and operation:

| Evidence field | Current M4.01 value |
|---|---|
| Permission names | Candidate examples from official Meta collections, otherwise `NOT_CONFIRMED` |
| Permission-to-operation mapping | `EXAMPLE_ONLY` or `NOT_CONFIRMED`; app-specific minimum is not proven |
| Required access level | `NOT_CONFIRMED`, except documented Embedded Signup entries marked `ADVANCED` |
| App Review requirement | `NOT_CONFIRMED`, or required where Advanced Access is documented |
| Per-permission review status | `NOT_CONFIRMED` |
| Per-permission Sandbox status | `NOT_TESTED` |
| Per-permission approval owner | `UNASSIGNED` |
| Per-permission evidence shape | Each required permission has its own mapping, access, App Review, Sandbox, evidence URL and owner fields; incomplete or pending rows block the operation |

This is why code-level profile presence and `enabled=true` do not by themselves enable a product
action. The flow stays unavailable until its exact version evidence and every required
`ASSET_DISCOVERY` permission's mapping, access-level, App Review and Sandbox gates pass. Other
operations remain independently unavailable until all evidence rows for their own permissions pass.
A successful bootstrap check is not proof of OAuth completion,
asset ownership, provider grant or connection readiness.

## Local-only configuration example

The following profile is intentionally incomplete and cannot enable Coexistence. All identifiers,
domain and secret references are placeholders. Do not copy it to staging or production or replace a
reference with a secret value.

```json
[
  {
    "configurationRef": "wa-coexistence-stage-v1",
    "environment": "staging",
    "flowVariant": "WHATSAPP_COEXISTENCE",
    "authVariant": "WHATSAPP_BUSINESS_APP_ONBOARDING",
    "providerAppIdRef": "wa-coexistence-stage-app",
    "publicConfigId": "synthetic-public-config",
    "appMode": "DEVELOPMENT",
    "appDomain": "meta-stage.example.invalid",
    "callbackUri": "https://meta-stage.example.invalid/api/v1/meta/callback/whatsapp-coexistence",
    "redirectAllowlist": [
      "https://meta-stage.example.invalid/api/v1/meta/callback/whatsapp-coexistence"
    ],
    "appSecretRef": "vault://meta-app/staging/wa-coexistence/app-secret",
    "tokenConfigurationRef": "vault://meta-app/staging/wa-coexistence/token-config",
    "capabilityManifestVersion": "m4.04-2026-11-10.1",
    "enabled": false,
    "versions": {
      "graphApi": { "value": "v0.0", "status": "NOT_CONFIRMED" },
      "javascriptSdk": { "value": "v0.0", "status": "NOT_CONFIRMED" },
      "embeddedSignup": { "value": "v0.0", "status": "NOT_CONFIRMED" }
    },
    "capabilityEvidence": []
  }
]
```

Set `API_ALLOWED_ORIGINS=https://meta-stage.example.invalid` only in the matching staging profile.
Separately mount the staging `API_META_TRUSTED_APP_IDS_JSON` row for
`wa-coexistence-stage-app`; source its numeric ID from the staging app record. The example deliberately
uses `v0.0` sentinels, not Meta versions, and has no provider ID or secret value.

## App Review and test evidence checklist

Before a permission or operation is marked available, record a separate evidence row for each required
permission against the exact app ID, environment, flow/auth variant and operation. Do not reuse
approval across permissions, Instagram variants or WhatsApp exclusive/Coexistence. The operation
remains disabled until every required permission row has confirmed mapping, required access, approved
review, passed Sandbox evidence, a named owner and a sanitized evidence URL.

1. Confirm the operation's permission mapping and access level against the current official Meta
   documentation for the relevant endpoint/version. Link the source and date in the versioned
   capability manifest.
2. Confirm app mode, business portfolio ownership, test-user/asset eligibility, redirect URI and
   required privacy, deauthorization and data-deletion URLs. Do not move an app or portfolio to bypass
   a review restriction.
3. Submit each exact permission for App Review when required. Store its result and review evidence
   link in that permission's evidence row; `SUBMITTED`, rejected, absent or inferred approval keeps the
   operation disabled.
4. Run only the corresponding authorized Meta Sandbox scenario for each required permission, identify
   the synthetic/test asset safely, record the version, operation, permission and result, and verify the
   server-selected credential context. A fixture or local adapter is not a Sandbox result.
5. Assign a named approval owner and sanitized evidence reference to each permission row. Update the
   manifest version only after independent review. Never store tokens, app secrets or customer data in
   the manifest or report.

The privacy/deauthorization/data-deletion endpoints and account-level review state for this product
are **Not confirmed**. The existing privacy page in the web workspace is a source artifact, not proof
that a public URL or Meta App Dashboard setting is deployed.

## Change and rollback procedure

1. Copy the currently active profile to a new `configurationRef`; keep its environment, flow and auth
   variant explicit. Never edit a running profile's version in place.
2. Verify Graph, SDK and Embedded Signup versions independently. Add official source URL/date for each
   version and update the code manifest when its operation/permission evidence changes.
3. Set `rollbackConfigurationRef` to a syntactically valid reference for the immutable prior profile
   retained outside the active registry. The API validates only the reference shape; it does not load
   or certify the referenced profile. Before redeploying that snapshot, confirm its exact environment,
flow and auth variant match the target profile, and its versions, app/redirect settings and capability
evidence remain compatible and independently reviewed. A profile must not point to itself.
4. Deploy first to the isolated staging environment with a development-mode Meta app and test assets.
   Confirm `/api/v1/meta/bootstrap` reports the expected flow and action reasons; exercise the approved
   scenario only when an authorized Sandbox and operator are available.
5. Promote through the normal reviewed deployment process. Do not place production origins, live app
   IDs or production secret references in staging configuration.
6. To roll back, retrieve the exact archived prior profile and manifest version, complete the review in
   step 3, and deploy that snapshot as the active profile. The runtime registry does not resolve the
   rollback reference. Do not downgrade Graph or Embedded Signup based on assumption; the rollback
   profile must retain its own evidence. Re-run only the version/configuration checks affected by the
   change.

Malformed runtime configuration fails startup with only the relevant variable name
(`API_META_APP_CONFIGS_JSON` or `API_META_TRUSTED_APP_IDS_JSON`) in the diagnostic. Missing profiles
are a safe disabled state; profiles without their trusted app-ID allowlist fail startup closed.

## Reproducible local checks

Coordinator evidence: `npm run test:m4-01 --workspace=@ca-meta/api` passed 10/10 on implementation SHA `95f2acaa9d43827b060a685972f7956bde147b50` with Node `v24.22.1` and npm `11.19.1`. On final contract candidate `513cddc`, `npm run test:contract` passed 8/8 and `npm run check:generated` confirmed the generated client and 53 compatibility rows. The focused command below reproduces the synthetic API run:

```powershell
npm run test:m4-01 --workspace=@ca-meta/api
```

Canonical contract generation after an intentional OpenAPI edit:

```powershell
npm run generate --workspace=@ca-meta/contracts
```

These local checks cover parser isolation, safe bootstrap serialization and disabled reasons with
synthetic values. They do not prove account grants, App Review, Sandbox eligibility, live webhook
delivery or production endpoints.
