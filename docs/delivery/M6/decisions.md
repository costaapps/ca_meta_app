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

## 2026-11-19 — refresh Meta Embedded Signup version evidence

- **Issue / gate:** M6.07 must use the correct WhatsApp Embedded Signup contract and keep Coexistence distinct from exclusive onboarding.
- **Evidence:** M6.07 review checked the official Meta versioning, v5, Coexistence, Access Levels, Tech Provider, App Review and Instagram login sources on 2026-11-18. Meta lists Embedded Signup v5 as the current version; v2/v3 were deprecated on 2026-10-15. v5 changes Coexistence session-info fields (`messaging_account_ids`, `primary_waac_ids`, `is_on_biz_app`). M4.05 still has no confirmed provider contract/configuration for that version.
- **Decision:** Supersede the prior v4-specific wording: require the deployed configuration and adapter contract to be confirmed against the current supported version before Coexistence activation. Keep all app-specific permissions, customer grants, eligible assets and Suite4/Msg4 behavior **Not confirmed**.
- **Consequence:** The M6.07 checklist is preparation only; no flow is cleared to activate and no Coexistence compatibility is claimed.

## 2026-11-19 — preserve M6.02 security gate failure

- **Issue / gate:** M6.02/#70 requires the unchanged M2.08 security comparison to pass before dependency changes can be integrated.
- **Evidence:** PR #167 head `9a67dff70e437c1bdf52445198493c30fd9886c8`, CI run `44398836758`: desktop-candidate, MariaDB and image scans passed; `m2-08-security` failed on one new moderate dev-only `pacote`/`sigstore` tuple under `node_modules/pacote`, with zero severity escalations. The full audit has zero high/critical findings and production audit has zero findings. No safe semver-compatible Angular 21 resolution was confirmed.
- **Decision:** Keep PR #167 open and exclude its dependency changes from `desktop/milestone-m6` and the consolidated PR while the required check is red. Do not weaken the M2.08 scanner, invent a waiver or close #70.
- **Consequence:** M6.06's M6.01–M6.05 release gate remains **Not confirmed**. The consolidated PR may present the other locally deliverable packages for review, but it must say M6 is not complete while this P0 dependency remains unresolved.

## 2026-11-19 — refresh pinned NGINX image after M6 aggregate scan

- **Issue / gate:** M6.02/#70 audits runtime images; M6 aggregate CI must remain fail-closed on HIGH/CRITICAL image vulnerabilities.
- **Evidence:** Image scan run 44554604698 on desktop/milestone-m6 candidate c7673bad0c3d0ca2f0978985a402793ba0ecd9e8 found three CRITICAL and three HIGH findings against NGINX 1.30.6-r1, each with fixed version 1.30.7-r0. Official NGINX [security advisories](https://nginx.org/en/security_advisories.html) list 1.30.7+ as not vulnerable to the reported issues. The official [nginx-unprivileged image package](https://github.com/nginx/docker-nginx-unprivileged/pkgs/container/nginx-unprivileged/versions?filters%5Bversion_type%5D=tagged) lists the stable Alpine 3.24 image at digest 0c53a1f2890c3526bfd201440f0fd3970e5b78f80630f58284aad0d34b5ec7bd; docker buildx imagetools inspect returned that same manifest-list digest from both GHCR and ECR Public.
- **Decision:** Pin the web image and its approved CI smoke mirror to the exact patched digest. Keep the Trivy HIGH/CRITICAL threshold unchanged and require the candidate scan to pass.
- **Consequence:** This remediation addresses the NGINX image findings only. M6.02/#70 remains blocked by PR #167's separate moderate dev-only pacote/sigstore dependency finding in required m2-08-security; no waiver or scanner relaxation is authorized.
