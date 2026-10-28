# Meta API and Embedded Signup compatibility experiment

## Purpose and status

Use this experiment before changing the Graph API version or any Facebook JavaScript SDK / Embedded Signup SDK, configuration, or feature type. It compares a verified incumbent setup with a candidate in an isolated Meta Sandbox and records behavior without storing codes, tokens, secrets, customer payloads, or operational identifiers.

**Offline fixture experiment: Passed locally in the current M1.03 worktree on 2026-10-28.** The synthetic check below selects configured version/capability proposals and rejects incompatible or unresolved inputs. This is a local policy experiment only; the supervisor must record validation against its post-edit checkpoint SHA for exact reviewed-revision provenance.

**Meta Sandbox compatibility comparison: Not run.** The inspected PHP source uses Graph API `v24.0`, but the deployed version and currently supported version are **Not confirmed**. Accessible Meta Postman requests use a `{{Version}}` variable. No active app/config export, candidate release, authorized Sandbox assets, or provider test run was supplied.

The repository source baseline `6095a1990c89c39e3399c774b3a9aca6138af9a2` and earlier package snapshot `7adf06997b9446b445778290a1a684de433a5f37` are historical provenance only. This run used the synthetic fixtures and checker from the current worktree based on that earlier package snapshot, including the uncommitted documentation updates. Neither SHA is presented as the final reviewed package revision. The supervisor checkpoint/PR records final review provenance after the supervisor commits the edits.

## Ownership

- Accountable function: **Backend / Meta integration**, matching the responsibility in `docs/meta-v2/07-acceptance-risk-and-governance.md`.
- Project operator coordinates access to sanitized app/config inventory and authorized Sandbox resources. The dependent flow package owner (M4.01, M4.05, M4.08, or M4.09 as applicable) validates evidence before integration/certification.
- Named individual operator/package assignees: **Not confirmed** in the supervisor packet. A named compatibility decision owner must be assigned before accepting a provider version/config candidate.
- Required reviewers: Meta integration and QA; include Security for callback, token, permission, or asset-scope changes.
- A person must record the decision and test artifact before changing the pinned production/staging configuration. This document does not assign a person or authorize a deployment.

## Controlled variables

Record sanitized values for each run; never include secret values.

| Variable | Incumbent | Candidate |
|---|---|---|
| Graph API version | Not confirmed operationally; repository source `v24.0` only | To be selected from current official Meta support evidence |
| Facebook JavaScript SDK version | Not confirmed | Candidate version and release evidence required |
| Embedded Signup configuration / `featureType` | Not confirmed per app and flow | Candidate config/feature type with owner-approved change record |
| Meta app, mode and portfolio | Sanitized internal alias only; none supplied | Isolated Sandbox app/portfolio alias only |
| Redirect URI registration | Not confirmed | Exact allowlisted URI verified without publishing tenant/customer values |
| Test asset eligibility and consent | Not confirmed | Authorized assets only; document consent and role state |

Do not change more than one variable family in a single comparison. Graph API version, SDK version, login configuration, and `featureType` are independent dimensions. If the candidate changes more than one, run separate comparisons or explicitly mark attribution inconclusive.

## Executed offline fixture experiment

The fixture set is [`meta-capability-fixtures.json`](meta-capability-fixtures.json), marked synthetic and containing no app IDs, credentials, tenant IDs, or provider run results. The checker [`check_meta_capabilities.py`](check_meta_capabilities.py) uses only the Python standard library. It requires exact app alias, environment, Graph API version, flow, config alias, and operation; only `documented-proposal` and `repo-observed-proposal` records can be selected. A successful selection is explicitly a design candidate and cannot authorize a live provider operation.

Command run from the package root in the current worktree:

```text
python3 experiments/check_meta_capabilities.py
```

Result:

```text
PASS select WhatsApp Cloud SEND_MESSAGE: graph=v24.0 status=documented-proposal scopes=whatsapp_business_messaging
PASS select Facebook Page READ_STATUS: graph=v24.0 status=repo-observed-proposal scopes=pages_show_list,pages_read_engagement
PASS select Instagram Facebook Login READ_STATUS: graph=v24.0 status=repo-observed-proposal scopes=pages_show_list,instagram_basic
PASS select Instagram Login SEND_MESSAGE: graph=v24.0 status=documented-proposal scopes=instagram_business_manage_messages
PASS reject unconfigured Graph version: Graph API version v25.0 not configured; fixture versions: v24.0
PASS reject Cloud config on Coexistence flow: config alias fixture-wa-cloud-exclusive is incompatible with flow whatsapp_coexistence
PASS reject unconfirmed Coexistence capability: capability whatsapp_coexistence/SEND_MESSAGE is not-confirmed; evidence gate is unresolved
PASS reject unmatched production environment: no profile for requested app/environment/flow
PASS distinct flow/config variants: WhatsApp Cloud exclusive, WhatsApp Coexistence, Facebook Page, Instagram via Facebook Login, and separate optional Instagram Login
LIMITATION synthetic offline selection only; no Meta or Sandbox result
```

The fixture's `v24.0` value is a repository-source example, not a claim of current Meta support. The `v25.0` rejection only checks that an unconfigured request fails closed; it makes no claim that this version exists or is supported. This local run does not certify Meta permissions, app configuration, or Sandbox behavior. The supervisor's post-edit validation record is still needed to bind the result to the committed review SHA.

No build, Angular tests, PHP, network API call, Meta app, or Sandbox operation was part of this local documentation/fixture check.

## Preconditions

1. Use a Sandbox app and portfolio separate from the portfolio that owns the production app. Use only accounts, Pages, Professional Instagram accounts, WABAs and phone numbers authorized for testing.
2. Capture a sanitized snapshot of app mode, roles, review/access levels, business verification, login configs, redirect allowlists, webhook fields and currently pinned versions.
3. Confirm incumbent and candidate versions/configurations from current primary Meta documentation. A 429, inaccessible page, operator recollection, mock or UI event is not version evidence.
4. Prepare server-side callback/code-exchange instrumentation that stores only correlation IDs, outcome, token family/type, returned expiry metadata, granted scope names, asset types/IDs in a restricted test store, and redacted errors. Never persist raw OAuth codes or access tokens in the experiment report.
5. Define the exact endpoint and fields for each operation (`SEND_MESSAGE`, `MANAGE_TEMPLATES`, `READ_STATUS`, `SUBSCRIBE_WEBHOOKS`) and obtain required human consent/review before sending any test message.

## Procedure

Run incumbent and candidate in the same isolated conditions, one flow at a time. Keep a server-side trace ID across browser, callback, code exchange, asset discovery and subscription. Record both successful and failure/cancel outcomes.

### For each enabled flow

1. Start the flow with the intended config. Record effective SDK/config/version and the redirect/callback selected. Exercise cancel and provider error paths without restarting automatically.
2. Complete authorization only with the approved test user. Record the sanitized browser event type/schema and timestamps. Treat `postMessage`, QR completion or `FINISH` as a UI signal only.
3. Exchange the code on the server. Record whether exchange succeeded, token family/type, returned expiry/refresh metadata, granted scope names and app identity metadata. Verify these server-side; do not copy the credential value.
4. Discover assets using the returned grant and check each returned asset's type and parent relation. Do not infer ownership from an event field or UI label.
5. Run only the approved read/status/template/message operation for the flow. Record endpoint/version, operation, result category and required scope; mask IDs and provider payloads. Do not send a message without documented test-recipient authorization and consent.
6. Configure the app-level webhook product/fields and subscribe the app to the flow's actual provider asset target. Record the target type, field names, server response and one observed test event. Prove subscription separately from a browser callback.
7. Revoke/remove only test grants/assets when permitted. Record the documented flow-specific offboarding result; do not use destructive production operations.

### Additional WhatsApp Coexistence checks

1. Use the current Business App onboarding configuration and eligibility documented by Meta. Record the exact documented `featureType` and relevant event schema.
2. Exercise onboarding success, cancel, retry and code/event arrival in both orders. Verify the server-side exchange and WABA/phone-number grants independently of the browser event.
3. If history is offered and consented, record the actual requested interval, event/field schema, pagination/checkpoint behavior, and result. Do not infer or hard-code a history window from a previous run.
4. Record state-sync and message-echo behavior only when the selected current config/documents expose it. Verify duplicates and order without copying message content into the report.
5. Add a transport assertion that fails the experiment if the Coexistence path calls conventional phone `/register`, `/deregister`, or delete operations. Test the documented Coexistence offboarding separately. A failed/missing document blocks the flow; it does not trigger Cloud API fallback.

### Variant separation

- Test Instagram via Facebook Login and Instagram Login in separate runs, with separate configs and scope allowlists. Do not accept one variant's token, Page requirement, webhook target or permission names as proof for the other.
- Test Facebook Login for Business with a Page/grant assigned to the test user; record Page tasks and the exact subscription target.
- Test WhatsApp Cloud exclusive separately from Coexistence, even when both use Embedded Signup UI components.

## Comparison and decision rules

Compare incumbent and candidate for each flow across:

- login config and callback behavior, including cancel/error;
- code exchange outcome, token type and returned expiry/refresh metadata;
- granted scopes and asset-level tasks;
- asset types, IDs, and verified parent relationships;
- operation result, permission errors and pagination shape;
- webhook subscription target, fields and observed event schema;
- Coexistence-specific consent/history/state/echo and offboarding behavior;
- retry safety and absence of unintended registration/deletion calls.

Accept a candidate only when every intended operation has current primary-document evidence and the authorized Sandbox result matches the new server contract. Any unexplained difference, 429, missing grant, ambiguous asset, absent event, or untested rollback keeps the candidate blocked. Do not use a test app's admin-only success as evidence of a customer-authorized production flow.

Rollback evidence must show that the incumbent configuration remains available and that no migration or irreversible provider action was performed. Record a provider configuration change as a new experiment; do not silently move a pin.

## Sanitized run record template

```text
Experiment ID:
Date and operator:
Named accountable owner:
Sandbox app/portfolio aliases:
Flow variant:
Incumbent Graph / SDK / config / feature type:
Candidate Graph / SDK / config / feature type:
Primary Meta references and retrieval date:
Authorized test asset types (IDs masked):
Operation and required scope names:
Server exchange result / token family / returned expiry metadata:
Verified asset relationships:
Webhook target / fields / observed event result:
Coexistence history/state/echo/offboarding observations (if applicable):
Conventional register/deregister/delete call count for Coexistence:
Incumbent vs candidate differences:
Rollback result:
Decision: pass / fail / blocked
Artifacts (sanitized references only):
Reviewer and date:
```

Do not fill this template with synthetic results and label them Sandbox evidence. Until an authorized run is attached, the **Meta Sandbox compatibility comparison** remains Not run; the offline fixture experiment above is a separate local check.
