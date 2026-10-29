# Known issues and evidence gaps — reconciled 2026-10-29

This page records source-level risks and unconfirmed operational questions. It is not a deployment incident ledger. The current code findings and their limits are recorded in [the baseline inventory](../../../docs/baseline/inventory.md) and [baseline evidence](../../../docs/meta-v2/01-baseline-evidence.md); package ownership and evidence state are in [traceability.csv](../../../docs/meta-v2/traceability.csv). A design or synthetic test does not prove the live provider, Suite4, database, or deployment behavior.

## P0 — tenant authority is not established by browser context

The versioned Angular setup reads `cUUID` from the URL and browser storage and sends `company_uuid` as request context. This is not authentication or proof of membership. The checkout alone does not establish whether every deployed PHP request enforces an independent server-side membership check. Treat any client-selected tenant or asset as untrusted and keep affected operations blocked until server authorization is evidenced.

Evidence: `apps/web/src/app/features/channels/pages/channel-setup/channel-setup.component.ts`, `apps/web/src/app/core/services/meta-integration.service.ts`, [M1.06 identity contract](../../../docs/meta-v2/identity-contract.md). The identity contract is proposed, not implemented or verified in Suite4.

## P1 — deployed PHP, rewrite, schema and external consumers are unconfirmed

Four PHP sources are versioned, but their behavior is not proof of the service currently deployed at `msg4.app/meta/auth`. The WhatsApp direct entry path and source router selectors differ unless a rewrite transforms the request; the effective rewrite and deployed code were not supplied. Production DDL, writers, replication, cron, webhook registrations, and Suite4/Msg4 consumers are also not established by this repository.

Do not claim `backend/` is wholly untracked. Do not open or copy the local-sensitive `backend/connect.php` or `connect_old.php`. Use the authorized operator inventory and sanitized schema/read-only experiments as the next evidence; no production access is required to continue synthetic design work.

## P1 — legacy external actions need outcome evidence

The baseline source inventory reports an incomplete notification send branch and token-root usage in some versioned PHP operations. These are source-level risks, not verified production outcomes. The future credential resolver, notification actions and recovery path remain planned until their dependent packages and real grants are reviewed. Never treat HTTP success, a closed popup, a timeout, or a queued `202` as proof that an external effect completed.

Evidence: `backend/connect_whatsapp.php` source is summarized in [baseline inventory](../../../docs/baseline/inventory.md); contracts and acceptance criteria remain linked in [traceability.csv](../../../docs/meta-v2/traceability.csv). No operational secret or local PHP content belongs here.

## P1 — Suite4 iframe and issuer behavior

The Angular checkout does not prove a deployed host handshake, issuer/JWKS configuration, cookie policy, allowed origins or membership revocation semantics. M1.06 documents a proposed ticket/session contract and synthetic threat scenarios; real Suite4 behavior remains **Not confirmed** pending its functional owner and an authorized integration proof.

## Validation-status correction

A legacy note saying Angular tests fail is not current evidence for the M1 baseline. The isolated baseline run recorded in [docs/baseline/inventory.md](../../../docs/baseline/inventory.md) passed `npm run build` and `npm test -- --watch=false` (2 test files, 5 tests), with its exact environment and SHA. That run is not a claim that every later candidate or deployed system has been tested; use current candidate SHA evidence for delivery.
