# M3 handoff

## Current state

- Objective: deliver M3 package work to the milestone branch, prepare a consolidated PR to develop, and await human acceptance.
- Develop baseline: 89f44ced872226afecc71b195b8c0e0cd6311179.
- Milestone branch: desktop/milestone-m3; the last package squash before the documentation update is 43307aaddeb9647ac0e963e1baf8bc131104b240. Verify the final docs+source HEAD in the consolidated PR and its checks.
- All 12 planned packages are squash-integrated. There are 14 package PRs total, including the M3.03 and M3.01 follow-ups. Package PRs and exact-head evidence are summarized in progress.md.
- No consolidated PR to develop has been created yet. Do not merge it or close M3 issues before user acceptance.
- Integration worktree: C:\Users\user\.codex\worktrees\m3-milestone-integration\ca_meta_app, branch desktop/milestone-m3.

## Completed M3.01 job-authorization follow-up

The independent requirement and source audit found that the M3.01 #25 criterion for jobs was still incomplete. PR #108 and the current issue comment explicitly said M3.08 needed to bind an existing M2 job to its authenticated SERVICE identity and active claim/lease. PR #119 implemented the credential resolver but not the worker integration.

Package PR [#126](https://github.com/costaapps/ca_meta_app/pull/126) was squash-merged to desktop/milestone-m3 as `43307aaddeb9647ac0e963e1baf8bc131104b240`. The final candidate was `751f66950ef2b844fe376b1f34abf9c40ba9330d`; hosted candidate run 41889618976 and orchestrator run 41889619058 passed, including the M2.05 MariaDB fixtures. MariaDB artifact 13351749641 contains `m3-01-job-authorization.junit.xml` with zero failed cases. Independent source and security reviews passed at the final candidate SHA.

The follow-up adds a hash-only configured worker SERVICE credential verifier, derives tenant authority from `ca_meta_jobs`, checks the active claim/lease and payload hash, verifies tenant-owned onboarding/asset/credential resources and current service grants, and re-fences the claim before handler dispatch. A disposable MariaDB test covers an authorized ASSET_REFRESH plus forged claim, changed payload and revoked-grant denial. OUTBOX_DELIVER, PROJECTION_RECONCILE and HISTORY_SYNC remain denied until resource/effect mappings are reviewed. Production worker proof provisioning remains **Not confirmed**.

P2 advisory retained from source/security review: DurableWorker checks context job/tenant identity but does not runtime-check `isVerifiedJobExecutionContext()` before dispatch. The currently wired bootstrap uses the concrete DB-backed authorizer; closing this advisory requires replacing existing unbranded synthetic worker fixtures, so no test-only WeakSet issuer was introduced.

The accepted approach is fail closed: derive tenant from the persisted row, require exact job ID + claim token + workerRef + RUNNING + unexpired lease, compare the claimed type/payload/resource key, and verify the live service grant and persisted resource before any handler. Never trust caller tenant/principal or log the claim token. The configured proof hash and real credential issuer/secret provisioning remain Not confirmed until external deployment evidence exists.

## Next actions

1. Run the final milestone-level hosted candidate, planning/contract and orchestrator gates on the committed docs+source head. Do not repeat package suites locally.
2. Open the consolidated PR desktop/milestone-m3 → develop, attach it to this task, verify its exact head and checks, and present it for user acceptance. Do not merge it.

## External limits

Suite4 issuer and membership, real browser embed/cookie behavior, real email identity-proof provider and delivery, live Meta grants/assets, real provider adapters, credential issuer/secret provisioning, production legacy mapping, approved retention/deletion policy, staging/DNS/TLS and production import remain Not confirmed. Local synthetic fixtures and hosted CI do not certify those external systems.

Project #12 is not available through the connected GitHub tools. The old Trivy artifact 13230734415 and JUnit artifact 13232145002 were fetched through GitHub; the user does not need to upload them. The former showed two HIGH findings in an older web base image; the latter recorded an earlier migration preflight failure that did not recur in later candidate runs. The cause of that preflight result is Not confirmed.

## Test and environment policy for this handoff

The user's request is to avoid wasted subagent test cycles. Use focused exact-head source/security reviews and hosted candidate CI as the authoritative final gate. Do not rerun already passing package CI or repeat local suites; rerun only gates affected by a changed SHA. Docker Engine is unavailable locally; M1.06's runner did not reach its harness, so do not retry it here.
