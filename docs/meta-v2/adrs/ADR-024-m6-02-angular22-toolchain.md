# ADR-024 · Atualizar toolchain Angular para remover o advisory de minimatch

Status: accepted for the M6.02 code candidate; code CI and independent code/security reviews passed. Issue: [M6.02 / #70](https://github.com/costaapps/ca_meta_app/issues/70). Date: 2026-11-19.

## Context

The required M2.08 security check failed on the M6.02 branch with one new moderate, development-only `minimatch` advisory tuple through Angular CLI 21's `pacote → sigstore` dependency tree. Angular CLI 21.2.30 pins `pacote@21.5.1`, the first version verified to contain the pacote fix; earlier CLI 21 releases reintroduce that higher-severity advisory. The affected `minimatch` range is `>=7.0.0 <11.0.1`. The API workspace also had a separate vulnerable path through `@nestjs/cli@12.0.11 → minimatch@10.2.6`.

## Options

| Option | Benefit | Cost / risk |
|---|---|---|
| Keep Angular CLI 21 and wait for compatible upstream patches | No framework major change | M2.08 continues to fail; no compatible Angular CLI 21 release was available on 2026-11-19 |
| Force `minimatch@11` or change the M2.08 scanner | Smaller manifest diff | Outside dependent package ranges or weakens a delivery control; rejected |
| Use the stable Angular 22 line and update the Nest CLI patch | Removes the vulnerable toolchain paths without an override or scanner exception | Requires Angular 21→22 migrations and exact-head build/test review |

## Decision and consequences

Use `@angular/core`, compiler, CLI, and build `22.3.0`; TypeScript `6.0.3`; and `@nestjs/cli@12.0.13`. Keep RxJS and Vitest on their compatible current lines. Angular 22 requires Node `^22.22.3 || ^24.15.0 || >=26` and TypeScript `>=6.0 <6.1`; the repository's pinned Node 24.22.2 and TypeScript 6.0.3 satisfy those requirements.

Apply the official Angular CLI/Core 21→22 migrations. They add `ChangeDetectionStrategy.Eager` where the app relied on the former default, add `withXhr()` to retain the existing XHR HTTP backend, and suppress two newly enabled extended diagnostics to preserve the prior check behavior. The workspace already uses the application builder; no builder switch is needed. No security threshold, scanner, workflow, or package override is changed.

## Evidence and acceptance

- Official npm metadata on 2026-11-19: Angular CLI/build 22.3.0 do not declare `pacote`; Nest CLI 12.0.13 uses `minimatch@11.0.5`.
- A temporary lock-resolution audit and the local full workspace `npm audit --json` both reported 0 vulnerabilities. CI run 44583581344 confirmed no new M2.08 tuple against the actual PR target and passed all four candidate jobs on code SHA `6886dfa7397092d16055f2994d9f05547f9df776`.
- `npm run build:web && node tools/m2/check-web-bundle.mjs` passed on that code SHA; 24 browser files were scanned. Independent code and security reviews found no blocking issue.
- Node 24.22.2/npm 11.19.1 were prepared locally without global installation. Angular migrations were applied from the web workspace. No production or Meta operation was performed.
- Angular CLI 22 includes the optional `ng mcp` command. No repository script or workflow invokes it; review its capabilities separately before enabling it in developer workflows.
- Keep issue #70 open: independent staging evidence and concurrent multi-process testing remain **Not confirmed**. M6's external operational acceptance gates remain separate.

## Revisit

Revisit if the Angular 22 migration changes a supported flow, required checks fail, or a compatible patched Angular 21 toolchain becomes available before integration.
