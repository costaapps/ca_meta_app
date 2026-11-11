# M4.13 focused harness

Run from the repository root after the workspace dependencies are already installed:

```powershell
npm run test:m4-13 --workspace=@ca-meta/api
```

The runner uses the repository TypeScript compiler, compiles the API lifecycle slice and synthetic tests into a unique child of `apps/api/.test-runs/m4-13-*`, runs the one M4.13 test file with Node's test runner, and removes only that verified child directory. It does not install packages, start MariaDB/Docker, call Meta, or use customer/credential data. An implementation agent's authored harness is not evidence until the coordinator records the command, runtime version, and final candidate SHA.
