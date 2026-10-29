# Portal journeys and status behavior — M1.08 / #18

**Status:** executable product specification; not an implementation or proof of provider behavior.
**Contract baseline:** M1.07 OpenAPI and event schemas at `083f918deefc3b783da7076d46f3647473889234`.
**UI evidence reviewed:** Angular sources in that same milestone tree, including routes, setup, channels, templates, notifications, and styles listed below.
**Owner:** frontend/product role, to be assigned by the product team.

## Purpose and invariants

Provide a small, recoverable portal for selecting one of four product journeys, seeing resources under the authenticated company's active context, and understanding what the server last confirmed. Keep the existing layout and channel-management functions as the visual and functional reference. The future API is the M1.07 proposed contract; this document does not claim that the new API is running.

1. The server session and current membership identify the tenant. A URL parameter, `cUUID`, browser storage value, provider callback, or client-selected company never grants authority.
2. A connection is ready only when the authoritative server projection says `status=ACTIVE`, `readiness=READY`, the required asset authorization is verified, and the projection is not stale. A provider redirect, callback, HTTP `200`/`202`, or popup `FINISH` alone is not success.
3. Show the active company context and the time of the last confirmed observation. Do not display an arbitrary tenant UUID as a substitute for a company name. The M1.07 `SessionContext` contains `tenantRef` but no user-facing company label. Until a safe `tenantDisplayName` (or equivalent authenticated host context) is returned, show “Identidade da empresa não confirmada”, hide/disable the company switcher, and block all tenant-scoped writes. Keep only server-scoped reads available; do not claim that a UUID is an identifiable company.
4. Connection, asset authorization, provider subscription/webhook, and message-delivery status are separate facts. In particular, `PHONE_NUMBER.status=ACTIVE` does not prove a webhook subscription is active. M1.07 has no typed subscription status in the public connection detail; show it as “Status de eventos não disponível” and do not infer it from a connection or inbox event.
5. Do not automatically retry an external effect after an ambiguous `UNKNOWN` result. Reconcile through the relevant job/operation/connection read first; a new user action requires an explicit, safe next action from the server.
6. Never ask the user to paste a permanent Meta token. Secret material, authorization codes, raw webhook payloads, and message bodies do not appear in status summaries or diagnostics.
7. Disabled flow choices and actions explain the confirmed condition. If the server exposes only `enabled=false` without a reason, state that the option is unavailable in this environment; do not claim Meta ineligibility or promise approval.

## Baseline visual and behavior references

Current Angular evidence at the contract baseline:

- `src/app/app.routes.ts`: `/setup`, product callback routes, `/channels`, and `/templates`.
- `src/app/features/channels/pages/channel-setup/channel-setup.component.{ts,html,scss}`: three cards, the existing intro and Msg4/Agent4 copy, query `cUUID` copied to `localStorage`, and `auth_success=true` treated as a success message before loading authoritative connection state.
- `src/app/features/channels/pages/channel-list/channel-list.component.{ts,html,scss}`: connected-channel cards, automation message fields, notification bell, and hard-coded “Conectado”; GET failure clears loading but is only logged, so it can look like empty content.
- `src/app/features/channels/pages/channel-templates/channel-templates.component.{ts,html,scss}`: WhatsApp number selection, template listing/creation, loading/error/empty feedback.
- `src/app/features/channels/components/notification-bell/notification-bell.component.{ts,html,scss}`: notifications, refresh, empty/error/loading, templates and reply actions.
- `src/styles.scss`: shared typography, spacing and responsive primitives.

Keep the white panels, restrained borders, clear heading hierarchy, platform accent as a secondary cue, existing onboarding story, channel cards, automation editor, templates, and notification entry point. Make only the changes needed to add the fourth choice, active-company/status information, recovery actions, and accessible interactions. Do not copy the current hard-coded success/status behavior into the new journey.

## Four user-facing choices and configured variants

The page presents four choices. The proposed API lists five configured `FlowVariant` values; Instagram login variants remain explicit sub-options when the server enables both.

| User choice | Contract variant(s) | User-visible distinction |
|---|---|---|
| WhatsApp API | `WHATSAPP_CLOUD_API` | WhatsApp Business Platform connection managed through the API. |
| WhatsApp + aplicativo | `WHATSAPP_COEXISTENCE` | Add a number while it remains in the WhatsApp Business app, if the current server configuration offers this flow. Do not promise eligibility. |
| Instagram | `INSTAGRAM_LOGIN`, `INSTAGRAM_VIA_FACEBOOK_LOGIN` | If one is enabled, show that configured path. If both are enabled, ask the user to choose explicitly using plain labels supplied by a reviewed capability mapping. Never silently change auth family. |
| Facebook | `FACEBOOK_LOGIN` | Connect a Facebook Page under the active company context. |

The UI derives available choices from `GET /api/v1/integrations/flows` and only offers entries whose `enabled` field is true. `requestedCapabilities` are contract data, not proof of grants and not public permission names. The precise mapping to display text and provider authorization remains a reviewed configuration concern; it is **Not confirmed** by M1.07.

## Entry, active company, and return

### Suite4 / Msg4 entry

1. For `SUITE4_EMBED`, first call `POST /api/v1/auth/preauth` in the target browser with the configured exact Origin and Fetch Metadata. The `201` response sets the host-only `__Host-meta_preauth` cookie (browser-managed; never read or expose its value) and returns `challengeRef`.
2. Keep the pre-auth cookie and `challengeRef` in that same browser context. The trusted Suite4 handoff supplies a short-lived one-use `ticket`; call `POST /api/v1/auth/exchanges` with that `ticket` and matching `challengeRef`, sending the browser cookie. The exchange requires both the cookie and challenge/ticket pair and rotates to the portal session. The browser does not choose a tenant or role. Suite4 issuer, keys, handoff mechanics, cookie support in the real host, and origin are **Not confirmed** until the M3.02 integration gate.
3. If the pre-auth response is lost, a fresh challenge may be started; do not reuse a challenge or ticket. If the exchange response is lost, do not replay the one-use ticket: start a fresh pre-auth challenge in the same browser and follow the host handoff again. The contract does not define additional retry semantics; do not invent them.
4. Load `GET /api/v1/session`; render active company context and permitted navigation from server session/membership. If session resolution fails, show the recoverable access state and a top-level portal link where the host contract permits it.
5. A blocked third-party cookie must not be worked around by weakening CSRF or cookie flags. Offer the same authenticated flow at top level.

### Direct portal entry

1. A previously authorized/invited identity opens a one-use magic-link experience. Keep the request response uniform; require a deliberate confirmation POST to consume it so link scanners do not sign a person in.
2. After the session is established, load the same server-derived active company. Do not accept `?cUUID=...`, local storage, or a guessed path as access control.
3. A missing/expired session leads to sign-in/recovery copy, not an empty channel list. “Solicitar novo link” is shown only when the access contract is available; delivery timing/identity cannot be inferred from the response.

### Company change, refresh, and concurrent tabs

- Show the active organization label above every resource list and inside connection detail. The server rotates `tenantContextRef`/version on tenant switch. Each tab must refresh its session/context; a stale request displays “A empresa ativa mudou nesta aba. Atualize para continuar.” and runs no mutation. Until a safe company label is available, omit the switcher and block all writes; this includes onboarding start, connection actions, template/automation writes, notification actions, and company switch.
- An onboarding or job stays bound to the tenant where it started; switching companies never reassigns it. On return, the portal may show an in-progress item in its original context only when the API returns it under that authenticated context.
- If the current server session has several memberships but M1.07 does not provide a friendly tenant label, do not present indistinguishable UUIDs as names. The missing label is an explicit spec-to-contract gate.

## Shared onboarding journey

1. **Choose:** show the four product cards and only server-enabled variants. Provide a short plain-language description and a disabled-state explanation. Keep the current “Ver canais conectados” return route.
2. **Confirm context:** show the active company label and selected product before starting. When the label cannot be proven, the user may view status but cannot start a tenant-mutating action.
3. **Start locally:** on a deliberate click, call `POST /api/v1/onboarding-sessions` with the selected `flowVariant`, configured `requestedCapabilities`, and `returnRoute`. The server resolves tenant/principal and generates provider state. Include origin/Fetch Metadata/CSRF and a new idempotency key. A `201` creates only an onboarding session; it does not mean connected.
4. **Launch provider:** open the server-returned `launchUrl` in the approved popup or top-level flow. Do not build provider URLs, state, or secrets in Angular. Keep the portal tab and selected onboarding reference available for recovery.
5. **Resume:** callback/close/timeout returns to the portal with an opaque onboarding reference. Query `GET /api/v1/onboarding-sessions/{onboardingSessionId}`. Render the server state, `nextAction`, steps, and last update; do not trust query `auth_success=true` as authoritative.
6. **Reconcile:** for `WAIT` or an ambiguous result, allow “Verificar status” through the read endpoint; for a referenced `jobId`, call `GET /api/v1/jobs/{jobId}`. If the outcome is `UNKNOWN`, explain that the provider result is still being confirmed and do not repeat the external effect.
7. **Finish:** only after reloading `GET /api/v1/connections` and, where needed, connection detail, show the resulting connection card(s), asset count, readiness, and observation time. A `PARTIAL` connection remains visible and recoverable.

### Four distinct journeys

Each journey shares the steps above but preserves a unique `flowVariant`, current tenant binding, configured capability set, and callback route. The synthetic walkthrough exercises all five API variants.

- **WhatsApp API (`WHATSAPP_CLOUD_API`):** select this path, inspect the server-enabled configuration, start an independent onboarding, choose only server-presented account/number steps, then verify every returned phone/account asset. A number appearing in the provider window is not ready until the server projection confirms it.
- **WhatsApp + aplicativo (`WHATSAPP_COEXISTENCE`):** explain the proposed coexistence path before launch. Let the user add numbers one at a time. Each successful onboarding creates a distinct connection reference; later starts append, never overwrite previous refs. The UI is designed for four independently visible Coexistence connections, without asserting an upstream Meta quota or eligibility. Do not claim chat-history import or subscription success without corresponding typed server evidence.
- **Instagram:** keep `INSTAGRAM_LOGIN` distinct from `INSTAGRAM_VIA_FACEBOOK_LOGIN`. If both are available, present a clear selection before redirect. On callback or failure, recover through the matching onboarding session; do not fall back to Facebook or reuse its credentials automatically.
- **Facebook (`FACEBOOK_LOGIN`):** connect/select only Page assets the server offers for the active tenant, then verify Page and authorization status. Do not treat a Facebook login as proof that Instagram or WhatsApp is connected.

### Closing, canceling, and timeouts

- Closing the popup is an interruption, not proof of cancel or success. Return focus to the launch button; retain the onboarding card and offer “Continuar configuração” / “Verificar status”. Read server status before deciding whether to relaunch.
- A provider `CANCELLED`, `EXPIRED`, or `FAILED` state is shown with a safe reason if present and the contract's `nextAction`. Starting again creates a new onboarding only after confirming that no prior session is still active; do not replay a one-use authorization code.
- Browser timeout/network loss shows “Não foi possível confirmar o resultado. Verifique o status antes de tentar novamente.” Read status first. Do not auto-resubmit the create/code exchange, message send, template submission, or disconnect effect.
- On two tabs, the first tab can continue its original onboarding, but a changed tenant context invalidates its next write. The user must refresh the session and re-select the company before mutating.

## Connection list, detail, and actions

Each card shows product/variant, a stable distinct connection reference, number of assets, a textual state plus non-color icon, `readiness`, `observedAt` in the user's locale, and a stale marker. Card order is stable within a fetched page. Until the API supplies a safe display name/masked number, use “Conexão WhatsApp Coexistence · ref. …” derived from an opaque *public resource reference*; do not display the complete provider ID. The `SessionContext` tenant label and asset names are contract gaps to close before production copy.

Detail expands to a per-asset list with kind, status, authorization status, observed time and staleness. It separates:

- **Connection:** `ACTIVE`, `PARTIAL`, `REAUTH_REQUIRED`, `UNKNOWN`, `DISCONNECTED`.
- **Readiness:** `READY`, `PARTIAL`, `UNKNOWN`.
- **Asset:** `ACTIVE`, `INACTIVE`, `UNKNOWN`, `STALE`; authorization `VERIFIED`, `REVOKED`, `UNKNOWN`.
- **Provider subscription/webhook:** not present as a typed public field in M1.07. State `Not confirmed` unless a typed field is later added; do not equate webhook delivery, an `ACTIVE` number, and subscription readiness.

Actions are rendered from server state, user role, and capability:

- **Refresh status:** `POST /api/v1/assets/{assetId}/refresh` may return `202` and a job. Say “Atualização solicitada”, keep the previous timestamp visible, and read the job/asset again. `202` is not a fresh status.
- **Reauthorize:** `POST /api/v1/connections/{connectionId}/reauthorizations` creates local onboarding state and does not revoke the previous verified grant. The current M1.07 response is only `JobAccepted`; `JobStatus` does not expose the onboarding session or launch URL. Therefore the user-facing launch action stays disabled with an explanation until the contract provides a safe session/launch reference. Once added, say “Reautorização iniciada”; open the explicit user step and preserve the prior connection while valid.
- **Disconnect:** show confirmation for the selected connection only, list the asset scope the server returned, and say local access is being removed while provider cleanup is separate. `DELETE /connections/{id}` returns an asynchronous job; do not say disconnected until reconciled connection state does. An ambiguous outcome is `UNKNOWN`; no automatic repeat. Preserve other connections and shared subscriptions required by them.
- **Message/template/automation actions:** expose only the action the API returned and a capability-checked endpoint supports. Never render enabled-looking buttons for unsupported operations.

## Existing features to preserve

- **Templates:** keep `/templates`, WhatsApp-number selection, list, status and creation. New contract path is `GET/POST /api/v1/whatsapp/accounts/{assetId}/templates`; it is WhatsApp-account scoped and requires `MANAGE_TEMPLATES`. Show `PENDING`, `APPROVED`, `REJECTED`, `PAUSED`, `UNKNOWN` as distinct plain-language states. The current Angular form includes language/examples/body; the M1.07 `TemplateCreateRequest` only specifies name/language/category/bodyText. Until the contract preserves the existing language/example inputs, disable template creation with the explanation “Não é possível enviar este formulário sem preservar o idioma e os exemplos.” Never submit a reduced payload or imply that a disabled button is an error in the user's account.
- **Automation/messages:** keep the private welcome and, where supported by current product behavior, public/private comment reply settings. New contract endpoint is `GET/PATCH /api/v1/assets/{assetId}/automation-config`, ETag-protected. The M1.07 `AutomationConfig` currently has only `enabled` and one `replyText`, not the baseline's private welcome/public comment/private comment fields. Keep the current editor read-only or save disabled with a clear compatibility explanation until a typed contract maps every existing field by channel. On a stale `412`, reload and let the user review before saving again. A saved local configuration is not proof the provider delivered a message.
- **Notifications:** retain bell, loading/empty/error/refresh, and supported actions. New `GET /api/v1/notifications` only returns `safeSummary` and references; the baseline notification card uses `MessageText`. Keep a concise safe summary and status, but do not silently substitute it for a message transcript. The full message/reply-context contract is a gate before migration of message display. Render `actions[]` only through approved labels; `MARK_READ`/`DISMISS` are local. `REPLY` is an external effect and returns a pending job; keep it disabled with an explanation until authorized message context and the reply path are available. When an action outcome is unknown, reconcile before offering another send.
- **No feature removal:** differences between the legacy UI and the proposed API are contract migration work. Do not remove template fields, notification actions, language, message behavior, or status detail without an explicit product decision and the affected tests.

## Accessibility, responsive behavior, and embed

This is a specification checklist, not a conformance claim. References consulted 2026-10-29: [WCAG 2.2 Recommendation](https://www.w3.org/TR/WCAG22/) (including Focus Visible/Not Obscured, Reflow, Target Size, and contrast criteria), [WAI: Labeling Controls](https://www.w3.org/WAI/tutorials/forms/labels/), and [WAI: Form Instructions](https://www.w3.org/WAI/tutorials/forms/instructions/).

- Use semantic headings, `main`/`nav`/`section`, real buttons/links and a visible focus ring. Keep keyboard order aligned with reading order. Popup close returns focus to its initiating button; dialogs trap focus, support Escape when safe, and restore focus on close.
- Give every input a persistent associated label. Put required/optional and format instructions before the form or bind them with `aria-describedby`; do not rely on placeholder text.
- Status uses words and icons, not color alone. Announce async changes with a restrained `role=status`/polite live region; use `role=alert` for blocking error only. Do not move focus for background polling.
- Confirm destructive action in a clearly named dialog. State the exact affected connection/resource, the local effect, and the separately confirmed provider effect. Offer Cancel as the safe default.
- At narrow widths, reflow cards and detail rows without horizontal page scrolling, clipping, or losing actions. Preserve readable order in iframe/embedded width; if embed cannot provide cookie/auth support, offer the approved top-level route.
- Use at least the current WCAG 2.2 AA color/text contrast requirements, visible keyboard focus, unobscured focus, and target-size checks. For target size, specify and verify WCAG 2.2 SC 2.5.8 AA: pointer targets are at least 24×24 CSS px or a formally applicable SC 2.5.8 exception (such as spacing, inline, user-agent control, or essential) is documented and verified. No WCAG audit has been run on the current Angular UI, so compliance is **Not confirmed**.

## Acceptance traceability

| Issue #18 acceptance | Specification evidence | Local executable walkthrough |
|---|---|---|
| Company/resource ownership and status time | Active-context rules, connection/asset details, and explicit missing-label gate above | `CTX-01`, `CONN-01` |
| Suite4 exchange uses browser-bound preauth before one-use ticket exchange | Suite4 entry sequence and retry/lost-response rules | `ENTRY-01`, `ENTRY-03` |
| Four Coexistence connections distinguished | WhatsApp Coexistence journey and stable distinct refs | `COEX-01` |
| loading/empty/error/partial/stale/reauth + recovery | status matrix and wireframes | `STATE-01` through `STATE-08` |
| Templates/messages/notifications preserved | preservation section + screen/API map | `FEATURE-01` through `FEATURE-03` |
| No permanent token paste | invariant and security walkthrough | `SEC-01` |
| Four distinct product choices and variants | flow choice table and per-flow journeys | `FLOW-01` through `FLOW-05` |
| Callback close/cancel/timeout/multiple tabs | shared onboarding recovery sections | `REC-01` through `REC-04` |
| Popup/modal accessibility and company switching | accessibility checklist and company change section | manual checklist in `tools/m1-08/README.md` |

Run `node tools/m1-08/walkthrough.mjs` from the repository root. It validates the fixture, the five variants, four distinct Coexistence refs, tenant scoping, status/recovery invariants and documentation trace links. It does not run Angular, a browser, Meta, Suite4, a provider, or the proposed API.

## External evidence and gates

| Gate | Needed before | Owner | Current state |
|---|---|---|---|
| Session carries safe company display label and assets expose useful masked labels | Company switcher and four-number identity in the real portal | API/identity + product | M1.07 lacks these fields; **Not confirmed** |
| Suite4 issuer/host origin/bootstrap and cookies work end-to-end | Real embedded and direct entry | Suite4 identity + platform | M1.06 proposal only; M3.02 real issuer integration gate |
| Flow enablement, Meta permissions, account/asset eligibility, webhook subscriptions | Enable/certify each provider path | Meta app owner | **Not confirmed**; local fixture is not a grant |
| Four consecutive Coexistence signups retain separate connections in the real environment | Certify Coexistence UX/capacity | Meta/product | Local journey supports four distinct refs; real provider quota/eligibility **Not confirmed** |
| Reauthorization `202` returns a usable safe onboarding/launch reference | Enable the reauthorization button | API | M1.07 returns only a job reference; `JobStatus` lacks onboarding ID/launch URL, so action remains disabled until the contract is extended |
| Automation schema maps all current channel-specific message fields | Enable legacy message editor writes | API/product | Current schema has only `enabled`/`replyText`; per-channel field mapping is **Not confirmed** |
| Notification safe summary includes enough authorized context for reply, or a scoped message-detail read exists | Enable notification replies and replace current `MessageText` | API/product/security | M1.07 exposes safe summary/reference only; full context is **Not confirmed** |
| Safe labels/capabilities for legacy automation, templates, notification actions | Replace the current PHP client | API/product | Current PHP deployment and old frontend↔PHP behavior are not reproduced here; map below marks the proposed contract boundary |
| WCAG 2.2 keyboard/screen reader/reflow/contrast verification | Release the portal UI | Frontend/QA | Criteria specified; no browser audit executed in M1.08 |

## Sources reviewed

- `docs/meta-v2/contracts/openapi.yaml` and `docs/meta-v2/contracts/events/{inbox-event.schema.json,outbox-event.schema.json}` at M1.07 base `083f918`.
- `docs/meta-v2/04-identity-api-and-security.md`, `docs/meta-v2/03-domain-data-and-credentials.md`, `docs/meta-v2/05-meta-flows-and-webhooks.md`.
- Angular baseline files listed under “Baseline visual and behavior references”. Sensitive local PHP reference files were not read.
