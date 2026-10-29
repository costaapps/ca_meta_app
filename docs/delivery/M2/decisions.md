# M2 execution decisions

| Date | Decision | Basis | Consequence / gate |
|---|---|---|---|
| 2026-10-29 | Start `desktop/milestone-m2` from `develop@2f0944d771ea7e98c520b20667586304e8bb9113`. | Remote and local develop match; GitHub confirms PR #94 merged into develop. | Package branches derive from the milestone branch; no prior M2 package work exists. |
| 2026-10-29 | Use the accepted npm workspaces structure, preserve Angular, NestJS 12, Node 24.22.2, and separate Angular/Nest TypeScript toolchains. | Accepted ADR-001/002 and the M1.04 harness. | Install Node 24 outside the repository; keep Angular TypeScript <6 and API TypeScript 6 scoped to their workspaces. |
| 2026-10-29 | Keep M2.09 image publication and M2.10 shared staging as explicit external gates. | Docker Hub namespace/credentials and staging host/domain/DNS/TLS/resources have not been verified or authorized. | Build and test locally; do not claim publication or real staging verification. |
| 2026-10-29 | Treat the web import scanner as a static heuristic, not a complete security boundary. | Exact M2.01 functional/security reviews found the current tree clean and noted alias chains, eval-like loaders, and symlink resolution are not fully modeled. | The checker has self-tests for common ESM/CommonJS forms; document its limit and add broader candidate/security tests in M2.08. |
| 2026-10-29 | Integrate M2.01/#20 to the milestone by squash. | PR #95 exact head `957d00dfbf0113a41a5642282baf293532b29648`; functional/security review PASS; candidate checks success; GitHub reports merged. | Squash commit `45d32ca7f6b4ad004b52d6f675644139e17c10ca` is now the prerequisite base for M2.02. Keep #20 open until consolidated acceptance in develop. |
