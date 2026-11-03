# M3.08 focused resolver harness

## Setup and run

Use the monorepo lockfile and the versions declared by the root package (`Node >=24.15 <25`, `npm >=11.19.1 <12`):

```powershell
npm ci
npm run test:m3-08 --workspace=@ca-meta/api
```

The workspace script compiles only the M3.08 resolver test and its imported source files with the pinned TypeScript compiler, then runs that compiled test with Node's built-in test runner. It does not run the API suite or start a database/provider service. The temporary compiler output is created in the OS temp directory and removed in `finally`, including when compilation or a test fails.

## Fixture and isolation

All tenants, apps, assets, grants, scopes, families, health/expiry observations and secret markers are synthetic UUIDs/labels. The tests use in-memory repository, policy, audit and vault ports; they make no network requests, read no environment variables, use no customer data and perform no provider operation. No persistent cleanup is needed beyond the harness's temporary output removal.

The harness proves resolver selection and denial behavior against the internal contract. It does not confirm Meta scopes, token families, expiry or provider grant semantics.
