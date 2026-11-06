# M4 decisions

## M4.01 — server-owned Meta profile registry

**Issue / criteria:** #42, configuration by flow and environment; secure public bootstrap; fail-closed app/review/version readiness.
**Decision:** Store platform Meta app profiles as validated server process configuration (`API_META_APP_CONFIGS_JSON`) and keep tenant-scoped `ca_meta_app_configurations` as the separate asset/auth foreign-key boundary. Do not repurpose that tenant table for platform secrets or app review data.
**Reason:** Profile ownership, app mode, redirect allowlists, provider versions and secret-manager references are platform deployment inputs. M3 tenant/app/asset rows do not prove provider permission. Adding tenant identity to a globally controlled app profile would blur the trust boundary.
**Consequence:** Missing config keeps the API available while all Meta profiles are disabled. A later storage-backed configuration service may replace the runtime source only with a reviewed migration and audit contract.
**Gate:** A verified portal session can read the safe bootstrap DTO; onboarding still revalidates the session, tenant membership and exact flow/config server-side.

## M4.01 — five exact profile/auth variants

**Issue / criteria:** #42 and the existing FlowVariant/MetaFlowVariant contracts.
**Decision:** Register Facebook, Instagram via Facebook Login, Instagram Login, WhatsApp exclusive Embedded Signup and WhatsApp Business App Coexistence as separate profile keys. Do not copy permission, SDK, Graph or Embedded Signup versions between them.
**Reason:** Instagram auth variants use separate scopes/token families, while exclusive WhatsApp and Coexistence have different lifecycles.
**Consequence:** Registry rejects duplicate or incompatible flow/auth pairs. `enabled` is not authorization evidence.
**Gate:** No profile can be selected by browser tenant ID, `cUUID`, public config ID or arbitrary URL.

## M4.01 — no implicit Graph API default

**Issue / criteria:** #42, verified version and safe rollback.
**Decision:** Store Graph, JavaScript SDK and Embedded Signup versions independently with source/date evidence. Do not pin the then-current public announcement as a verified product version.
**Reason:** On 2026-11-06 the official Meta news index announced Graph API v27.0, while an available official changelog snapshot still listed v26.0. Endpoint compatibility, current SDK/Signup version and this app's approved version remain **Not confirmed**.
**Consequence:** Unverified versions make the flow unavailable. A version update requires a new immutable profile, official evidence and a syntactically valid reference to an archived prior profile; runtime compatibility is not inferred from that reference.
**Gate:** Current endpoint and app-specific Sandbox checks remain external evidence for the affected scenario.

## M4.01 — reuse the M1.03 capability evidence

**Issue / criteria:** #42 operation/permission/access/review/Sandbox matrix.
**Decision:** Extend and reference the M1.03 capability matrix and preserve its synthetic offline harness. The runtime manifest contains candidate permission mappings, evidence status and owners; unknown mappings stay `NOT_CONFIRMED`.
**Reason:** The M1.03 package already provides flow-specific documentation and offline mismatch cases, including a negative Coexistence conventional-registration case.
**Consequence:** Candidate scopes from official collections are not treated as grants; app review, access level, Sandbox status and owner remain separately gated.
**Gate:** No flow is represented as externally certified until an authorized provider scenario supplies the missing evidence.
