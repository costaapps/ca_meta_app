# M1.10 read-only governance checks

This package checks the planning source graph, package/issue identifiers, generated acceptance trace, local Markdown links and the M1.08 portal vertical sample. The validator reads source files and never imports or executes `.planning` scripts. In particular, it does not invoke `.planning/validate.py`, `render.py`, or `contracts.py`, which generate files.

## Setup

- Python 3.10 or newer.
- Python standard library only (`ast`, `csv`, `json`, `pathlib`, `unittest`, and related standard modules).
- No package install, external service, credential, lockfile, database or production data is needed.
- Run from repository root in the assigned disposable worktree. Tests and checks create no files, services or containers, so cleanup is not required.

## Commands

```powershell
python -B tools/m1-10/check_governance.py
python -B -m unittest discover -s tools/m1-10 -p "test_*.py" -v
python -B tools/m1-10/generate_traceability.py
```

All commands above are read-only. The trace CSV writer is explicit and limited to one output:

```powershell
python -B tools/m1-10/generate_traceability.py --write
```

That command updates only `docs/meta-v2/traceability.csv`, using the reviewed `.planning` acceptance matrix and `traceability-map.json`. Review its diff before committing. Never use the `.planning` generators as an alternate way to refresh the M1.10 artifacts. The `-B` option prevents Python bytecode cache files, so checks leave no cleanup artifacts.

`matrix_evidence_status` preserves the upstream planning matrix value. `delivery_status` separately records the actual state: M1.01–M1.10 have verified package PRs on the milestone branch; M1.10 package PR [#93](https://github.com/costaapps/ca_meta_app/pull/93) was squash-integrated at `ddb92588855f5128f6a173291c581a547e7b5317`. M2–M6 remain `PLANNED`. `release_evidence` remains `NOT_RELEASED` until final milestone integration into `develop` is accepted.

Fixtures cover a valid DAG, a cycle, a missing dependency, manifest dependency drift, wave drift, valid/broken Markdown links, and valid/broken issue/spec/contract/acceptance links. The source checker also enforces all seven required feature-spec sections, Given/When/Then rows and explicit external gates. All fixture content is synthetic and contains no tenant data or credentials.
