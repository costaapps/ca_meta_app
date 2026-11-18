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
