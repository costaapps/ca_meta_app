# M2 environment matrix

Status: local delivery contract prepared; real staging configuration and external evidence are Not confirmed. Issue: [M2.10 / #36](https://github.com/costaapps/ca_meta_app/issues/36).

## Environment boundaries

| Boundary | Developer / local | Staging | Existing production |
|---|---|---|---|
| Purpose | Disposable Compose project and synthetic fixtures | Isolated candidate validation with authorized Meta test resources | Existing Hostinger deployment remains the current owner until a separately accepted cutover |
| Host and ingress | Docker Desktop/Compose local; harness binds a loopback development port | VPS/platform, owner, address, ingress rules and budget not selected | Operator-reported Hostinger deployment; source/rewrite and live consumers are Not confirmed |
| Database | UUID-scoped MariaDB volume in the M2.07 harness; no production data | Separate private/managed DB, schema, backup and restore evidence required; all Not confirmed | Live DB identity, sharing and access policy Not confirmed |
| Secrets | Synthetic random DB passwords kept in temporary files by the harness | Secret manager, access roles, rotation and recovery Not confirmed | Existing secret storage and sharing are Not confirmed |
| Meta apps/config | Synthetic references only | Separate authorized app/config and test assets per allowed flow; identities and permissions Not confirmed | Existing app ownership/configuration and callback consumers Not confirmed |
| Tenant catalog | Synthetic resource identifiers | Staging-only tenant catalog and data provenance required; Not confirmed | Production catalog and consumer/write ownership Not confirmed |
| Public origin and TLS | None; local HTTP is not public evidence | Stable staging hostname, DNS, valid TLS, headers and clock evidence Not confirmed | Current public routing is not inferred from the checkout |
| Release | Synthetic manifest + schema-v3 lock fixture; M2.09 release metadata is not a publication | One verified release manifest and digest-pinned lock; actual registry/staging evidence Not confirmed | Production deployment must use a separately homologated manifest; no promotion performed here |

Staging must have distinct database, secret-store, tenant-catalog and Meta app-config references from production. Reusing a cloud account or DNS zone can be acceptable only when ownership, scopes and resource-level isolation are documented; this matrix does not approve such reuse.

## Four independent Meta journeys

The four product choices remain distinct even though Instagram has two OpenAPI auth variants. Product configuration/login setup is separate from each product's asset-level webhook subscription.

| Journey | Contract variant(s) | Staging resource needed | Current evidence | Gate before enabling |
|---|---|---|---|---|
| Facebook | FACEBOOK_LOGIN | Authorized Facebook app config, Page/test user and a Page grant scoped to the selected operation | M1.03 capability matrix and synthetic tests; real app, permissions, App Review and Page assets Not confirmed | Confirm app owner/config, grants, sandbox/test assets, least scopes, login and callback round trip |
| Instagram | `INSTAGRAM_VIA_FACEBOOK_LOGIN` and `INSTAGRAM_LOGIN`; each has its own app-config reference and availability record | Authorized Instagram-capable app config and professional account/test Page relation appropriate to each variant; one Meta app may support both only when confirmed by its owner | The current legacy path observes Instagram through Facebook Login; current provider behavior and approved variant Not confirmed | Assess each variant independently; verify its grant/account relation, app review, subscription and callback round trip |
| WhatsApp exclusive | WHATSAPP_CLOUD_API | Dedicated authorized test business, WABA/phone resources and consented test number | M1.03 fixture only; real eligibility, permissions and test assets Not confirmed | Verify dedicated-number path, assets, grants, webhook and non-production message consent before any send |
| WhatsApp Coexistence | WHATSAPP_COEXISTENCE | Authorized test business, active app number, QR/consent path and suitable test assets | M1.03 fixture only; real eligibility, active-app state and Coexistence resources Not confirmed | Verify Coexistence-specific onboarding/state/history and no conventional register/deregister fallback |

The contract variants come from [OpenAPI FlowVariant](../../meta-v2/contracts/openapi.yaml) and [the onboarding spec](../../meta-v2/specs/meta-onboarding.md). An OpenAPI variant or fixture is not proof of Meta authorization. Keep auth state, app configuration, grants, credentials and subscription state tied to the server-selected app/environment/flow.

## Callback and webhook routes

The canonical OpenAPI currently describes:

- Provider callback: GET /api/v1/meta/{variant}/callback, correlated by one-use server state. Its path segment currently distinguishes facebook, instagram and whatsapp; it is not a tenant identifier and does not itself distinguish WhatsApp exclusive from Coexistence.
- Webhook verification challenge: GET /api/v1/webhooks/meta/{appConfigRef}.
- Signed webhook ingress: POST /api/v1/webhooks/meta/{appConfigRef}; verify the exact raw body before trusting fields.
- Deauthorization and data deletion callback paths are not defined in the current OpenAPI contract; their exact route, ownership, verification and response semantics remain Not confirmed.

The paths above are contract entries, not deployed runtime handlers. The current API source has health/readiness handlers only for these surfaces; M2.10 does not implement callback/webhook endpoints. Do not register Meta dashboard callbacks against a route that is not live and verified. Distinguish app-level webhook field configuration from asset-level subscriptions.

## Current blockers

- Target host/VPS, DNS domain, public ingress/firewall owner, TLS certificate and budget: Not confirmed.
- Runtime secret manager, scoped access, rotation, backup and recovery: Not confirmed.
- Staging DB, tenant catalog, separate Meta apps/configs and authorized test assets for all four flows: Not confirmed.
- Callback/webhook runtime handlers, exact provider allowlists/signature evidence, deauthorization and data-deletion contract routes: Not confirmed.
- External HTTPS health, clock, headers and callback delivery smoke: not run; there is no staging endpoint to probe.
- Existing Hostinger behavior and production connections are not altered or certified by this package.

## Safe local preflight

The synthetic descriptor under tools/m2-10/fixtures is used only by the local preflight harness. The operator form must remain outside the repository and contain only opaque resource references, never secret values. See [deployment inventory](deployment-inventory.md), [preflight README](../../../tools/m2-10/README.md), and [M2.10 evidence](packages/M2.10-evidence.md).
