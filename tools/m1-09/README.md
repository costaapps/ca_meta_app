# M1.09 local validation

Small Python standard-library harness for the synthetic capacity worksheet and API cutover/rollback tabletop. It uses no project dependencies, network, customer data, database, Meta sandbox or production service.

## Requirements and command

- Python 3.10+; standard library only: csv, json, math, pathlib, sys.
- Repository root: `python tools/m1-09/validate.py`.
- PowerShell: `py -3 tools/m1-09/validate.py`.
- No setup, lockfile or credentials are required. The verifier is read-only and creates no files, so no cleanup is needed.

Expected result includes `M1.09 synthetic validation PASS`, 3 scenarios, 1 unavailable worker per row, 2 synthetic webhook items, zero external calls and zero customer data. A nonzero exit means a required equation/invariant failed.

## Formulae and limits

- Available workers = total workers − unavailable workers.
- Per-worker service ceiling = concurrency per worker ÷ mean service seconds.
- Total worker ceiling = available workers × per-worker ceiling. This omits CPU, DB, lock, network and external provider limits.
- Usable capacity = min(worker ceiling, database-limited service rate, durable queue/consumer service rate, provider quota). The worksheet computes only the worker ceiling; the other terms are **Not confirmed**. If any limiting term is at or below arrival, backlog is not sustainable.
- Capacity margin = total ceiling − arrival rate. Backlog drains only when capacity > arrival.
- Synthetic initial backlog = arrival rate × 300-second backlog window.
- Estimated drain time = initial backlog ÷ (total ceiling − arrival rate), assuming steady arrivals and service during drain.
- Required DB connections = active worker pools + API pools + migration reserve + operations reserve; headroom = synthetic budget − required.
- Payload storage sensitivity = arrival rate × 86,400-second horizon × payload bytes/event. This is not retention policy or total physical footprint: it omits indexes, replicas, WAL, retries, backups and compression.

Every scenario value (N=5 events/s, 3N, 10N, four total workers with one unavailable, concurrency 8, 0.25-second mean service, pool budget, payload and one-day horizon) is explicitly synthetic. No production traffic, target infrastructure, cost or provider quota is inferred. Worksheet: `docs/meta-v2/m1-09/capacity-model.csv`.
