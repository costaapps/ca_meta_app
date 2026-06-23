# Open Questions

## Meta Official Validation Pending
- Official Meta documentation pages for:
  - Facebook Login for Business
  - WhatsApp Embedded Signup
  - Instagram Platform
  - Graph API access token lifecycle
- Status: not confirmed from this environment during this session
- Missing evidence: direct successful retrieval of current official docs
- Why it matters: future auth split and token decisions should not rely on older assumptions

## Backend Deployment Ownership
- Which repository or deploy process owns the PHP currently exposed at `https://msg4.app/meta/auth`?
- Status: not confirmed
- Missing evidence: versioned backend source or deployment documentation

## `suite4` Tenant Contract
- Will `suite4` provide tenant context via signed query params, `postMessage`, shared session, or another contract?
- Status: not confirmed
- Missing evidence: host platform integration spec

## Callback Ownership In Embedded Mode
- Should OAuth callback return to:
  - the standalone app,
  - a parent `suite4` route,
  - or a popup bridge page?
- Status: not confirmed
- Missing evidence: product and security decision

## Meta `config_id` Lifecycle
- Is the current Business Login `config_id` environment-specific, temporary, or production-stable?
- Status: not confirmed
- Missing evidence: Meta app configuration governance outside this repo

## Notification Scope
- Are `MetaAppReviewNotifications` intended only for Meta app review/demo usage, or are they part of the future product?
- Status: not confirmed
- Missing evidence: backend business requirements

## WhatsApp Template Contract Details
- Are additional template component types needed beyond BODY for the product roadmap?
- Status: not confirmed
- Missing evidence: product requirements and Meta policy alignment

## Test Runner Intent
- Is the team intentionally standardizing on Vitest through Angular 21 tooling, or are the remaining Jasmine specs accidental leftovers?
- Status: inferred leftover, not formally confirmed
- Missing evidence: repo-level testing guideline or updated test examples
