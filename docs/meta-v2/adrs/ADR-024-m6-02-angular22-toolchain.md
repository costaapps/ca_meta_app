# ADR-024 · Atualizar toolchain Angular para remover o advisory de minimatch

Status: accepted for the M6.02 candidate; exact-head CI and independent review are required before integration. Issue: [M6.02 / #70](https://github.com/costaapps/ca_meta_app/issues/70). Date: 2026-11-19.

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
- A temporary lock-resolution audit based on the candidate workspace manifests and current lockfile reported 0 vulnerabilities. This is preliminary evidence; the M2.08 comparison against the actual PR target and all candidate checks must pass on the exact pushed SHA.
- Node 24.22.2/npm 11.19.1 were prepared locally without global installation. Angular migrations were applied from the web workspace. No production or Meta operation was performed.
- Keep M6.02 open until the exact PR head passes required CI and independent review. M6's external staging and operational acceptance gates remain separate and **Not confirmed**.

## Revisit

Revisit if the Angular 22 migration changes a supported flow, required checks fail, or a compatible patched Angular 21 toolchain becomes available before integration.
