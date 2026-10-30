# M2.10 staging inventory and preflight

The package prepares an operator inventory and a fail-closed static preflight for a future staging deployment. It does not provision infrastructure or certify DNS, TLS, callback delivery, Meta access, signatures or production isolation.

## Local synthetic scenario

Prerequisites: Node 24.22.2 or compatible Node 24 runtime. No npm install or third-party package is required; the preflight reuses the M2.09 release-manifest verifier and Node built-ins.

Run from the repository root:

    node tools/m2-10/run-preflight-smoke.mjs

Expected result: the synthetic staging descriptor binds to the M2.09 release manifest and matching M2.07 release lock; all four Meta journeys and five OpenAPI variants are recorded, with the two Instagram variants independently configured; staging resource references do not overlap the production fixture; and production target/resource swaps or a missing Instagram variant are rejected. Output explicitly says that no real deployment is eligible.

The command only reads tracked fixtures. It performs no network requests, DNS lookup, Docker command, callback, Meta request or external write.

## Operator preflight

For a protected, operator-created descriptor outside the checkout, run:

    node tools/m2-10/preflight.mjs --environment C:\secure\ca-meta\staging-environment.json --manifest C:\secure\ca-meta\release-manifest.json --release-lock C:\secure\ca-meta\release-lock.env

The descriptor contains opaque resource references and hostnames, not secret values. Keep it outside Git. The tool verifies the descriptor target is exactly staging, its display label is STAGING, public origins differ, database/secret-store/tenant-catalog/Meta-app references differ from production, the selected manifest matches the digest-pinned M2.07 release lock and current schema-v3 compatibility, and route/flow declarations match the versioned OpenAPI contract.

A configuration-valid result is structural only. The command cannot resolve the host, check certificate chains, call health/readiness, prove ingress routing, verify Meta credentials/signatures, confirm resource ownership or establish the production writer boundary. It always returns deploymentReady=false and readiness=Not confirmed; operator evidence and external smoke remain separate gates.

External-evidence statuses accepted by this static descriptor are Not confirmed and Synthetic only; the preflight has no evidence input and cannot certify an item as Verified.

Do not place access tokens, app secrets, DB passwords, verify tokens, customer identifiers or raw production environment values in the descriptor. It may contain opaque references to their authorized secret-store records. A staging config is not approved merely because it parses.

The local fixtures use example.invalid origins and synthetic resource identifiers. They are not live endpoints, app IDs, tenant IDs or credentials.
