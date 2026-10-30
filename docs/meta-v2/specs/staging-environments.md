# SPEC — Isolated Meta staging and deployment inventory

Status: implemented locally; external evidence pending. Issue: [M2.10 / #36](https://github.com/costaapps/ca_meta_app/issues/36). Dependencies: M2.07/#29, M2.08/#30, M2.09/#33, M1.03/#12 and M1.06/#15.

## Objective

Prepare an environment matrix, deployment inventory and fail-closed preflight so an authorized operator can later configure isolated staging and record evidence without changing existing Hostinger production. This local package does not provision hosts, DNS, TLS, secret stores, Meta apps or test assets.

## Invariants

- Environment selection is server/operator-owned. The staging config requires targetEnvironment=staging and the visible label STAGING; a production or unknown target is rejected.
- Staging database, secret-store, tenant-catalog and Meta app-config references are distinct from production. An app/account ID or secret value is never used as tenant authorization.
- Deployment uses one verified M2.09 release manifest and an M2.07 digest-pinned release lock whose image digests, source SHA and schema compatibility fields exactly match. The current contract is schema v3.
- Four product journeys remain separate: FACEBOOK_LOGIN, Instagram via Facebook Login and Instagram Login as separate variants within the Instagram journey, WHATSAPP_CLOUD_API and WHATSAPP_COEXISTENCE.
- Every OpenAPI variant has its own configuration-reference and availability record; the Instagram variants can be assessed independently. A Meta app may serve both only when its owner confirms the approved configuration supports each variant.
- Provider callback and webhook paths remain the canonical OpenAPI contract. They are not runtime endpoints until handlers and public ingress are independently implemented and verified.
- App-level webhook challenge/field configuration and per-asset subscriptions are separate records and evidence gates.
- Secrets are passed by opaque runtime references. No secret bytes or customer data enter this inventory.
- No Meta message, subscription, callback setting, production database, Hostinger rewrite or live tenant is touched by M2.10 local work.

## API surface and external gates

The current OpenAPI defines GET /api/v1/meta/{variant}/callback; GET and POST /api/v1/webhooks/meta/{appConfigRef}; /health; and /ready. Its callback variant path uses facebook, instagram and whatsapp; selected flowVariant/state remains server-side. Deauthorization and data-deletion routes are not currently specified. Meta provider handshake, app-secret signatures, grants, callback allowlists, and the route support in the deployed runtime are Not confirmed.

M1.03/#12 authorizes distinct local capability records but does not prove app permissions, review, Coexistence eligibility or Sandbox assets. M1.06/#15 proves only local issuer/CSRF/tenant-boundary fixtures, not an operational Suite4 secret store or callback. Neither removes the need for staging-specific external evidence.

## Preflight and traceability

Run the one-fixture local scenario in tools/m2-10/README.md. It checks release manifest to lock consistency and distinct staging/production resource references, then rejects a target swap to production. It makes no network request and always returns deploymentReady=false.

| Issue #36 criterion | Local artifact | External evidence still required |
|---|---|---|
| Staging uses no production DB/secrets and is clearly labelled | Static preflight compares protected resource references; environment label fixed to STAGING | Real references, access-policy proof, UI/config deployment label |
| Callback/webhook arrives over valid HTTPS and signature verifies | Canonical paths and verification contract inventoried | Actual handlers, DNS/TLS, app config, signature key, Meta test delivery |
| Stack is reconstructible from manifest/config | Release manifest and matching M2.07 lock structurally checked | Published M2.09 images/attestations, protected config and actual operator run |
| Four authorized journeys or explicit blockers | All four and Instagram variants listed separately | Four authorized Meta test-resource/evidence sets |
| Hostinger continues during homologation | This package performs no production operation | Runtime observation before/through any future deployment |

M2.10 remains implemented locally with external evidence pending. The presence of a preflight fixture must not be reported as a live staging environment or as completion of issue #36.
