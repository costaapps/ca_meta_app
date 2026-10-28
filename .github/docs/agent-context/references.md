# References

## Angular

### Angular Signals
- URL: https://angular.dev/guide/signals
- Topic: Signals overview and reactive model
- Applicable version: Angular 21 codebase, doc page currently served by Angular docs
- Consulted on: 2026-06-23
- Decision used here:
  - Signals are available and mature enough to use selectively, but this repo does not currently use them and should not be force-migrated without a concrete state need.

### RxJS Interop With Signals
- URL: https://angular.dev/ecosystem/rxjs-interop
- Topic: `@angular/core/rxjs-interop`, `toSignal`, subscription lifecycle
- Applicable version: Angular 21 codebase, doc page currently served by Angular docs
- Consulted on: 2026-06-23
- Decision used here:
  - If Signals are introduced later, bridge Observables intentionally and create each signal once instead of repeatedly.

### HttpClient Overview
- URL: https://angular.dev/guide/http
- Topic: typed responses, error handling, interception, testing
- Applicable version: Angular 21 codebase, doc page currently served by Angular docs
- Consulted on: 2026-06-23
- Decision used here:
  - Continue using `HttpClient` with typed response shapes as the primary backend boundary.

### Angular Style Guide
- URL: https://angular.dev/style-guide
- Topic: consistency, file naming, project structure, `src/main.ts`
- Applicable version: Angular 21 codebase, doc page currently served by Angular docs
- Consulted on: 2026-06-23
- Decision used here:
  - Preserve standalone, feature-oriented structure and keep file naming aligned with primary identifiers.

## Meta

### Facebook Login for Business
- URL: https://developers.facebook.com/docs/facebook-login/facebook-login-for-business
- Topic: Business Login flow
- Consulted on: 2026-06-23
- Status: not confirmed from this environment
- Decision:
  - No project decision was derived from a successful fresh read during this session. Current documentation relies on code evidence only.

### WhatsApp Embedded Signup
- URL: https://developers.facebook.com/docs/whatsapp/embedded-signup
- Topic: Embedded Signup
- Consulted on: 2026-06-23
- Status: not confirmed from this environment
- Decision:
  - Treat Embedded Signup as future work requiring official re-validation before implementation.

### Instagram Platform
- URL: https://developers.facebook.com/docs/instagram-platform
- Topic: Instagram platform capabilities and auth context
- Consulted on: 2026-06-23
- Status: not confirmed from this environment
- Decision:
  - Do not infer a standalone Instagram auth architecture from current code alone.

### Graph API Access Tokens
- URL: https://developers.facebook.com/docs/graph-api/overview/access-tokens
- Topic: token types and lifecycle
- Consulted on: 2026-06-23
- Status: not confirmed from this environment
- Decision:
  - Token redesign work must re-check official Meta docs before implementation.

### M1.03 verification update
- Consulted on: 2026-10-28
- Evidence record: [Meta capability matrix](../../../docs/meta-v2/meta-capability-matrix.md)
- Accessible primary material: Meta-authored WhatsApp Business Platform Postman workspace and Cloud API / Embedded Signup collections; Meta's official Instagram API Postman collection.
- The Instagram collection includes an Instagram Login Send API example at `POST https://graph.instagram.com/{api_version}/{ig_user_id}/messages` and says the recipient must initiate the conversation. This is collection guidance, not app-grant or Sandbox evidence.
- Retrieval limitation: direct `developers.facebook.com` pages for Facebook Login for Business, WhatsApp Coexistence, Instagram variants and Graph webhooks returned HTTP 429 in this check; the Graph access-token guide was not accessible through the research tool.
- Decision: use accessible collection claims only within their stated flow/endpoint scope; keep app/dashboard state, Facebook Login details, Coexistence-specific behavior and Sandbox authorization **Not confirmed** until independently evidenced. Do not treat the 2026-06-23 statuses above as current retrieval results.
- Version note: tracked PHP calls use Graph API `v24.0`; deployed/current support status is **Not confirmed**. The official Postman requests reviewed parameterize the version.
