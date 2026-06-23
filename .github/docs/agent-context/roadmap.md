# Roadmap

## 1. Stabilize And Document Current Architecture
- Priority: P0
- Objective: make the current Angular 21 + PHP implementation legible and safe to change
- Current state: partially undocumented, legacy docs diverge
- Dependencies: none
- Risks: wrong refactors from stale assumptions
- Acceptance: progressive docs exist and validation results are recorded
- Likely files: `AGENTS.md`, `docs/agent-context/*`

## 2. Separate Authentication Flows
- Priority: P1
- Objective: stop treating Facebook, Instagram, and WhatsApp as one mandatory auth bundle
- Current state: one PHP login URL asks for all scopes
- Dependencies: contract mapping, Meta doc validation, security decisions
- Risks: app review scope inflation, callback complexity, tenant leakage
- Acceptance: independent flow design and implementation plan approved
- Likely files: `backend/connect.php`, `src/app/features/channels/pages/channel-setup/*`, `meta-integrations.md`

## 3. Facebook Independent Flow
- Priority: P1
- Objective: support Facebook-only connection and management
- Current state: bundled
- Dependencies: auth split foundation
- Risks: callback divergence, Page token handling
- Acceptance: Page onboarding works without Instagram/WhatsApp scopes
- Likely files: setup page, backend auth logic, channel models

## 4. Instagram Independent Flow
- Priority: P1
- Objective: support Instagram onboarding without assuming Facebook-managed combined UX everywhere
- Current state: Instagram discovered through Facebook page lookup
- Dependencies: auth split, product rules validation
- Risks: account linking assumptions, permission mismatches
- Acceptance: documented and implemented Instagram-specific onboarding path
- Likely files: backend auth logic, setup UX, backend contracts

## 5. WhatsApp Embedded Signup
- Priority: P1
- Objective: add the WhatsApp-native onboarding path
- Current state: WhatsApp assets are discovered after unified login; no Embedded Signup
- Dependencies: Meta official validation, iframe/OAuth decision, security review
- Risks: token lifecycle, parent-window flow, app review requirements
- Acceptance: Embedded Signup design and implementation support one tenant safely
- Likely files: setup UX, backend auth/contracts, iframe docs

## 6. Detailed Channel Management
- Priority: P2
- Objective: improve connected-channel visibility and per-channel operations
- Current state: basic listing and message configuration
- Dependencies: auth split, cleaner models
- Risks: hidden differences between WABA, Page, and Instagram rows
- Acceptance: richer channel cards and safer actions by channel type
- Likely files: `channel-list.*`, `channel.model.ts`, backend `/channels`

## 7. Template Management
- Priority: P2
- Objective: strengthen WhatsApp template listing, creation, and lifecycle UX
- Current state: basic listing and create flow only
- Dependencies: stable WhatsApp onboarding
- Risks: approval-state mismatch, placeholder validation drift
- Acceptance: template flows cover creation, status comprehension, and useful validation
- Likely files: `channel-templates.*`, `meta-integration.service.ts`, backend template handlers

## 8. Automations And Replies
- Priority: P2
- Objective: make auto-reply configuration more reliable per platform
- Current state: one save action updates mixed platform behavior
- Dependencies: clearer backend contracts
- Risks: WhatsApp parent-child update confusion, reply mismatch
- Acceptance: platform-specific configuration rules are explicit and tested
- Likely files: `channel-list.*`, `backend/connect.php`

## 9. `suite4` Iframe Integration
- Priority: P1
- Objective: embed safely inside the host platform
- Current state: no handshake, no embed contract
- Dependencies: security decisions, auth ownership decisions
- Risks: tenant spoofing, OAuth breakage, layout problems
- Acceptance: approved technical contract for parent-child communication and auth recovery
- Likely files: setup flow, app shell, future iframe integration code, docs

## 10. Adopt `suite4` Design System
- Priority: P3
- Objective: visually align the module with the host platform
- Current state: independent SCSS-based branding
- Dependencies: iframe integration and host design tokens
- Risks: rework before host contract is stable
- Acceptance: shared visual tokens and embedded-safe layouts
- Likely files: `src/styles.scss`, page/component SCSS, shared UI primitives

## 11. Security And Tenant Isolation
- Priority: P0
- Objective: harden tenant propagation, callback validation, and token boundaries
- Current state: tenant context is weakly trusted from client inputs
- Dependencies: auth redesign and iframe contract
- Risks: cross-tenant data leakage, bad callback attribution
- Acceptance: signed or validated tenant handoff and stricter callback/state handling
- Likely files: backend auth handlers, setup flow, security docs

## 12. Test Suite Repair And Expansion
- Priority: P1
- Objective: restore confidence in Angular 21 behavior
- Current state: build passes, tests fail
- Dependencies: current architecture docs
- Risks: regressions hidden by stale tests
- Acceptance: test suite runs non-interactively and covers key flows
- Likely files: `*.spec.ts`, test config if needed

## 13. Observability
- Priority: P2
- Objective: make flow failures diagnosable without leaking secrets
- Current state: console logs and PHP log helper only
- Dependencies: stable contracts
- Risks: hard-to-debug production incidents
- Acceptance: structured logging and safer frontend/backend diagnostics
- Likely files: Angular error handling, PHP log paths, docs

## 14. Deploy And Rollback Strategy
- Priority: P2
- Objective: make releases safer as the module becomes productized
- Current state: deploy process is not documented in-repo
- Dependencies: git workflow and auth split sequencing
- Risks: mixed-scope releases and poor rollback
- Acceptance: documented release slices and rollback expectations
- Likely files: `git-workflow.md`, future CI/deploy docs
