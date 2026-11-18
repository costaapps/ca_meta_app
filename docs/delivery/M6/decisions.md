# M6 execution decisions

## 2026-11-18 — entry base and evidence boundaries

- **Issue / gate:** M6 entry requires M5 and all earlier dependencies actually delivered on `develop`.
- **Evidence:** `develop@b54bde1ed170a4304e281383f70ded6ed0a4f5dc` is the squash of consolidated PR #166. GitHub reports #166 merged with base `develop`; M5 handoff lists package PRs #152–#165 and their evidence.
- **Decision:** Start M6 from that SHA. Treat M5 code as available for local fixture-driven work, while retaining its stated real-runtime gaps: Msg4/PHP callers, enterprise destinations, and shadow/pilot/cutover remain **Not confirmed**.
- **Consequence:** M6 evidence may prove local behavior and release preparation, but cannot certify external consumers, permissions, staging, or production.

## 2026-11-18 — operational authorization boundary

- **Issue / gate:** M6.06–M6.10 distinguish local release preparation from publishing, deployment, data migration, canary, production stabilization, and decommission.
- **Evidence:** Prompt M6 and the M6 issue bodies explicitly reserve those effects for concrete authorization and real environment access. The current request authorizes preparation and a consolidated PR, not production changes.
- **Decision:** Build and verify local/synthetic artifacts only. Do not publish images, deploy, migrate real data, send messages, change Meta assets, run canary, or remove PHP/Hostinger. Keep M6.07–M6.10 marked with their specific external evidence still pending.
- **Consequence:** The consolidated PR will be ready for human review as a release candidate with explicit gates; it will not claim the entire operational milestone is complete.

## 2026-11-18 — efficient validation

- **Issue / gate:** Package and cumulative checks must cover the M6 criteria without duplicating full suites across subagents.
- **Decision:** Each package owner runs only the focused harness/checks they introduce or materially affect. The coordinator runs one cumulative relevant set after integration; reviewers use the recorded command, environment, and SHA unless a concrete gap requires a new check.
- **Consequence:** Re-run only checks invalidated by changes to their source, contracts, base, or environment.

## 2026-11-18 — refresh of public Meta acceptance references

- **Issue / gate:** M6.07 must confirm current App Review/access requirements and the Embedded Signup version used by each WhatsApp mode before enabling it.
- **Evidence:** On 2026-11-18, the official Meta [WhatsApp Business app onboarding (Coexistence)](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/) page stated that Embedded Signup v2 and v3 were deprecated on 2026-10-15 and directs integrations to v4; it also identifies the Tech Provider/Solution Partner, webhook and session logging prerequisites. The official [App Review introduction](https://developers.facebook.com/docs/resp-plat-initiatives/app-review/introduction) describes per-permission/feature approval and reviewer access/recording requirements. In this checkout, `embeddedSignupVersion` is configuration data, and the Coexistence provider adapter remains disabled; no deployed configuration or app-specific approval is available here.
- **Decision:** Keep the Coexistence activation gate closed until an authorized owner confirms the real per-flow configuration is v4 or newer and supplies app-specific permission/eligibility evidence. Use current dashboard state for exact permission names and approval status; public docs do not prove this app is approved.
- **Consequence:** Local fixtures cannot clear M6.07 or M6.08 for Coexistence. Record the checked documentation date and leave any deployed version/approval **Not confirmed** until independently evidenced.
