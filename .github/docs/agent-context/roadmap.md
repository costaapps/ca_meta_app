# Roadmap context — reconciled 2026-10-29

This page replaces the older feature-by-feature sketch with the current specification-driven delivery sequence. The canonical package graph and acceptance criteria are in [.planning/manifest.json](../../../.planning/manifest.json), [.planning/issues-map.json](../../../.planning/issues-map.json), [the Meta v2 overview](../../../docs/meta-v2/README.md), and [the SDD playbook](../../../docs/meta-v2/sdd-playbook.md). Issue order is not dependency order.

| Milestone | Planned outcome | Current evidence status |
|---|---|---|
| M1 | Baseline, architecture, tenant/credential/identity contracts, four Meta flow definitions, webhooks, portal, operational transition and SDD governance | Package PRs M1.01–M1.09 are present on the milestone branch. M1.10 is in progress. No final M1 delivery to `develop` or release is claimed here. |
| M2 | Web/API monorepo, containers, migrations/jobs, CI and reproducible delivery controls | Planned; package specs, PRs and release evidence must be checked at execution. |
| M3 | Identity, tenant isolation, authorization and credential handling | Planned; Suite4, DDL and key-management evidence remain external gates where required. |
| M4 | Four distinct Meta onboarding journeys, callback handling, webhooks and recovery | Planned; current grants, eligibility, subscriptions and real provider behavior require their own authorized gates. |
| M5 | Portal parity, Msg4 consumers, projections and controlled migration | Planned; live consumers and writer ownership require sanitized operational evidence before cutover. |
| M6 | Staging/homologation, production readiness, canary, rollback and eventual legacy retirement | Planned; release readiness does not authorize real rollout or PHP retirement by itself. |

Each acceptance requirement links issue, spec, contract, test, package PR and release evidence in [traceability.csv](../../../docs/meta-v2/traceability.csv). A package PR merged into the milestone branch is an intermediate review state, not `Done`; `Done` requires the reviewed final milestone integration into `develop` after human acceptance. External gates remain attached to only the dependent scenario, so local design and synthetic validation can proceed without inventing provider, DDL, identity or deployment proof.

The previous roadmap mentioned auth split, standalone channel flows, Embedded Signup, channel/template management, iframe integration, observability and rollback as independent implementation projects. They are now scoped and sequenced through M1–M6 issues and accepted contracts. The old statements about a mandatory unified login, no Embedded Signup or failing Angular tests are historical baseline observations; consult current code and SHA-specific evidence before presenting them as current runtime behavior.

No people, calendar dates, production releases, or provider approvals are assigned by this roadmap. Status changes require current issue/PR/CI and evidence, not elapsed time or document completion.
