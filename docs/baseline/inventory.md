# Baseline inventory and evidence limits

## Scope and source revision

This inventory records the versioned application at `develop` SHA `733e4a6dcccc93ee58a24958ed9830bfcc878e62` (2026-10-28, São Paulo). The isolated `desktop/m1-01` worktree started from that exact commit. It covers the Angular application, the four PHP files tracked at that revision, their visible frontend consumers, and reproducible offline source tracing.

The detailed method, input, side effect, table, response/error, consumer, target, and code-reference catalog is in [endpoint-matrix.csv](endpoint-matrix.csv). [parity-matrix.md](parity-matrix.md) maps observed product behavior to preservation/correction work and tests. The separate [execution report](execution-report.md) records command results, environment, durations, and limits. Historical context documents also describe `backend/connect.php` as the current WhatsApp entrypoint; that conflicts with the tracked `connect_whatsapp.php` reviewed here. Because AGENTS marks the local `connect.php` sensitive, it was not opened; its contents and deployment relationship are **Not confirmed**.

Only these PHP sources were inspected: [`connect_whatsapp.php`](../../backend/connect_whatsapp.php), [`connect_facebook.php`](../../backend/connect_facebook.php), [`connect_instagram.php`](../../backend/connect_instagram.php), and [`meta_auth_helper.php`](../../backend/meta_auth_helper.php). Local-only `backend/connect.php` and `backend/connect_old.php` were not opened or copied. The baseline repository contains no evidence sufficient to describe the PHP code actually deployed to Hostinger.

## Confirmed application shape

- The frontend is standalone Angular 21 with three user-facing routes: [`/setup`](../../src/app/app.routes.ts#L8), [`/channels`](../../src/app/app.routes.ts#L33), and [`/templates`](../../src/app/app.routes.ts#L37). Setup also registers four callback route aliases, including the historical `/setup/callback`.
- Setup presents three cards: WhatsApp, Facebook, and Instagram. `MetaAuthService` maps them to three direct PHP filenames. WhatsApp is one UI path; the code does not distinguish WhatsApp Cloud API exclusive from Coexistence as separate journeys.
- Setup reads an optional `cUUID` query parameter into `localStorage['cUUID']`, then uses that value as `company_uuid` when starting a connection. This is tenant context supplied by the browser; the code does not establish that it is an authenticated identity or company membership.
- The channels page loads connected assets and message settings. It embeds the notification bell. The templates page selects a WhatsApp number and lists or creates templates.
- [`environment.ts`](../../src/environments/environment.ts) sets `backEndUrl` to `https://msg4.app/meta/auth`; its inline comment says “Backend Node.js rodando localmente”. That comment is inconsistent with the source tree and the PHP endpoints described by `AGENTS.md`; no Node backend is present in this checkout.
- [`MetaIntegrationService`](../../src/app/core/services/meta-integration.service.ts) sends `company_uuid` and asset identifiers as request context. No frontend route or service proves a server-side session, membership check, or tenant authorization.

## PHP source and endpoint behavior

The route block in `connect_whatsapp.php` selects GET `/login-url`, GET `/facebook/callback`, GET/POST `/whatsapp/templates`, GET `/channels`, POST `/save_auto_reply`, GET `/notifications`, and POST `/notifications/action`. It also handles OPTIONS and sends 404 for unmatched paths; exceptions produce a generic 500 response. The source uses substring matching against `REQUEST_URI` after removing `/api` from the path.

The frontend builds the WhatsApp start URL by appending `/connect_whatsapp.php?company_uuid=...` to `backEndUrl`. That path does not contain the router's `/login-url` or `/facebook/callback` selector. If the PHP router sees that original URI unchanged, it falls through to its 404 branch. `scope-decisions.md` records the operator's report that Hostinger uses a shared `public_html/meta/auth` deployment and rewrites missing paths to `connect.php`; this is an operator report, not a reproduced or verified configuration. The deployed rule, local sensitive `connect.php` contents, deployed code, and actual incoming `REQUEST_URI` are **Not confirmed**. The fixture records the source-level mismatch only; it does not establish production behavior.

`connect_facebook.php` and `connect_instagram.php` are direct script entrypoints with initiation and callback branches. Both call the shared helper for bootstrap, OAuth URL construction, state decoding, company lookup, Graph API requests, and frontend redirects. The Instagram source discovers an Instagram professional account through a Facebook Page (`instagram_business_account`); this is not evidence of the Instagram Login variant.

The WhatsApp callback contains Graph API calls and writes to `Company`, `MetaConnectedPages`, and `MetaConnectedNumbers`; paths may also subscribe pages/WABAs. The WhatsApp channel, notification, and template handlers read or update `Company`, `MetaConnectedPages`, `MetaConnectedNumbers`, and `MetaAppReviewNotifications`. The direct Facebook/Instagram callbacks write `MetaConnectedPages`. These are table names seen in code, not confirmed physical DDL, indexes, replication, or production records.

The WhatsApp template and message paths use a server-side global root-token variable in the versioned code. No token values are reproduced here. The notification action API has branches for multiple action types; the source includes an incomplete/no-op send branch and can mark a notification read without proving that a message was sent. A returned HTTP success therefore is not enough evidence that the external action completed.

The shared auth helper encodes company context in JSON/Base64 state and later decodes it. A session binding or one-time nonce store is not demonstrated by these files. Callback code accepts OAuth query values and performs external Graph requests; actual app grants, scopes, eligibility, webhook delivery, and production OAuth behavior remain **Not confirmed**.

See the endpoint catalog for every public route and all 20 declared functions across the four PHP files. Internal helper rows identify callers and observable behavior; `N/A` means a helper is not an HTTP endpoint. No schema was inferred from PHP SQL beyond names and relationships expressed in the source.

## Screens and current user-visible behavior

| Screen | Current behavior to preserve | Observable gap or migration concern |
|---|---|---|
| `/setup` | Three connection cards; stores pending product in session storage; reads `auth_success`/`error`; successful callback shows a message and navigates to channels after a delay. | cUUID is browser-provided context. WhatsApp exclusive and Coexistence are not separate. Direct WhatsApp file path conflicts with the router selectors in source unless a rewrite changes it. |
| `/channels` | Lists connected channels; edits private welcome/comment reply fields; embeds a notification bell. | UI treats the response as a list and HTTP success as save success. Membership checks and exact tenant scoping are not evidenced by the frontend. |
| `/templates` | Selects a WhatsApp number; lists templates; validates name/body and placeholder examples; sends a create request. | UI success is based on an HTTP response. The backend calls the provider using a global credential path; no tenant grant is shown. |

The notification bell refreshes review notifications, displays an update time, loads WhatsApp templates for the notification destination, and sends actions such as message/template/comment replies. After a successful `response.success`, it removes the notification from the local list. The backend action outcome is not consistently proven by the versioned implementation.

## Consumers and operational boundary

Consumers confirmed in this repository are the three Angular screens, `MetaIntegrationService`, `MetaAuthService`, and `NotificationBellComponent`; their exact mappings are in [endpoint-matrix.csv](endpoint-matrix.csv). `AGENTS.md` describes the PHP endpoints as behind `https://msg4.app/meta/auth`, while this source trace does not reproduce the remote deployment.

The following are **Not confirmed** from this checkout and were not invented: deployed `connect.php` behavior; Hostinger rewrite/include/bootstrap configuration; code actually serving `msg4.app/meta/auth`; other Suite4/Msg4 consumers; webhook registrations and callbacks in production; cron/background jobs; GeneralSettings readers/writers; company database DDL/indexes; external replication/projection processes; token ownership/configuration; and the owner/version of any operational contract. Reconcile these before choosing a legacy cutover or data migration. They do not prevent design work against the versioned source and synthetic fixtures.

## Baseline validation

Validation was executed in the isolated M1.01 worktree before implementation, on the starting revision above:

| Command | Result |
|---|---|
| `npx ng version` | Angular 21.0.8; Angular CLI 21.0.5; Node 22.17.0; npm 10.9.2; TypeScript 5.9.3; RxJS 7.8.2; Vitest 4.0.16; Windows x64. |
| `npm ci` | Passed; installed 505 packages. npm reported 46 vulnerabilities (1 low, 11 moderate, 30 high, 4 critical). This is a dependency finding for later triage, not a confirmed exploit. |
| `npm run build` | Passed; Angular production bundle generated. |
| `npm test -- --watch=false` | Passed; 2 test files and 5 tests. |
| `php -l` on each of the four versioned PHP files | Passed on PHP CLI 8.3.30; syntax check only, not PHP integration or Hostinger evidence. |
| `python tools/baseline/trace_versioned_routes.py` | Passed: 20 declared PHP functions, 8 GET/POST WhatsApp selectors plus 1 OPTIONS preflight (9 router branches total), 9 Angular route declarations, and 12 synthetic request cases were traced against source and matrix. |

The route harness reads only versioned source and synthetic fixtures. It makes no HTTP call, runs no PHP endpoint, opens no database, performs no Meta OAuth/token exchange, and has no side effects. The OPTIONS fixture asserts that the versioned preflight branch returns source status 200. The WhatsApp direct-file mismatch is reported as “no matching source-router selector; default branch is 404” from static code; it does not claim an observed HTTP response.

Re-run the source trace from the repository root with `python tools/baseline/trace_versioned_routes.py`. Baseline Angular commands use the root lockfile; no lint script exists in `package.json`.
