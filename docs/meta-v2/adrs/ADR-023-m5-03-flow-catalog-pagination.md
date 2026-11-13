# ADR-023 — M5.03 paged multi-configuration flow catalog

Status: accepted for the M5.03 local candidate (2026-11-13). Issue: [#60](https://github.com/costaapps/ca_meta_app/issues/60). Related spec: [tenant-scoped Meta flow and asset catalog](../specs/asset-catalog.md). The rejected PR #164 candidate was based on `cff7411e1cb4b7cfa27d7176f87a7e2059601691`; M1.07 run `43360010503` and Desktop candidate run `43360010463` recorded the `modified maxItems` failure caused by changing `FlowList.items.maxItems` from 32 to 80. The frozen M1.07 baseline is unchanged.

## Context

The SQL repository can expose up to 16 Meta app configurations for one tenant/environment, and each configuration yields five flow journeys. A single full result can therefore contain 80 items. Increasing the response schema bound from 32 to 80 fails the frozen public v1 compatibility gate. The service and browser must preserve that response bound while supporting the repository's 16-configuration window.

## Options

| Option | Benefit | Cost/risk | Evidence/experiment |
|---|---|---|---|
| Raise `FlowList.items.maxItems` to 80 | One request returns the whole source window | Breaking change against frozen M1.07 v1 baseline | CI on PR #164 rejected the 32-to-80 change |
| Page app configurations with optional `appOffset` | Keeps each public v1 response bounded and lets the client fetch a complete window | More read requests; source changes during offset reads can yield an inconsistent result, which must fail closed when detected | SQL sentinel rows, paged API tests and sequential web-catalog tests |

## Decision

1. Keep OpenAPI `FlowList.items.maxItems` at the frozen v1 value of 32; the rejected candidate's attempted 80-item bound is reverted. Add optional integer query `appOffset` with only `0`, `6`, and `12` accepted. Omission is offset 0.
2. For offsets 0 and 6, read at most six app configurations plus one sentinel row. For offset 12, read at most the remaining four configurations plus one sentinel row. Return only up to 30 journey items on the first two pages and 20 on the final page.
3. Set `truncated=true` when the current page has another page or the source exceeds 16 configurations. A source over 16 remains truncated at offset 12.
4. The onboarding client reads offsets sequentially, at most three pages, aggregates no more than 80 items, and invokes the strict flow parser only after a page reports `truncated=false`. A still-truncated third page, malformed page, tenant switch or divergent/partial app group makes the catalog unavailable.
5. Keep app-configuration references server-issued and out of the onboarding create request. The server continues resolving authorization configuration by `flowVariant`.

## Security, effects and reversibility

- Every page read uses the current verified portal session and tenant-context header; query offsets never select a tenant or app identity.
- Only the server emits app-configuration references. The browser uses them solely to validate that pages form complete, non-divergent groups.
- These are read-only catalog requests. No Meta authorization, message send, production data mutation or credential transfer is introduced.
- The M1.07 baseline remains frozen. Reverting page support restores the previous single-request consumer only for catalogs that fit; it does not make a truncated catalog complete.
- Provider grants, app eligibility, deployed routing and production behavior remain **Not confirmed**.

## Proof, deployment and recovery

The implementation checks passed on the worktree based on `cff7411e1cb4b7cfa27d7176f87a7e2059601691`, using Node 24.22.2/npm 11.19.1: web M5.03 focused tests (40/40), API M5.02 focused tests (15/15), contract generation check (12 artifacts), breaking check (0 breaking changes against frozen v1), and M1.07 generated client/compatibility check (53 rows). `git diff --check` also passed. These are local candidate checks; no production deployment or database migration was run.

## Revisit

Revisit if more than 16 app configurations must be onboarded per tenant/environment, if stable cross-page snapshot semantics become required, or if the public v1 response bound changes through an explicitly approved contract-version decision.
