# M1.09 local validation

Small Python standard-library harness for synthetic capacity and workload worksheets, the still-open pricing gate, and API cutover/rollback tabletop. It uses no project dependencies, network, customer data, database, Meta sandbox or production service.

## Requirements and command

- Python 3.10+; standard library only: csv, json, math, pathlib, sys.
- Repository root: `python tools/m1-09/validate.py`.
- PowerShell: `py -3 tools/m1-09/validate.py`.
- No setup, lockfile or credentials are required. The verifier is read-only and creates no files, so no cleanup is needed.

Expected result includes `M1.09 synthetic validation PASS`, three workload/capacity scenarios, one unavailable worker per capacity row, 27 cost rows OPEN/NOT_CONFIRMED, operation guardrails including a proposed p95 reauthorization budget (120 s/15 min) with pre-callback user/Meta wait explicitly unbounded and load validation required, a composite writer key including config and credential version in each tabletop phase, two synthetic webhook items, zero external calls and zero customer data. A nonzero exit means a required equation/invariant failed.

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
- Asset count = companies × assets/company. History bytes = opt-in companies × retained history items/company/day × bytes/item × retention days. API, webhook, outbound-send and template-management rates are separate lanes; the webhook rate alone feeds the current worker-event worksheet.
- Each cost line uses line forecast = quantity in the approved billing period × approved unit rate; total forecast is the sum of lines plus approved taxes/fees/FX not already included and contingency. Rates, billing period, currency, owner and budget cap remain NOT_CONFIRMED, so the cost gate must remain OPEN.

Every scenario value (10/30/100 companies, asset/history/API/webhook/send/template rates; N=5 webhook events/s, 3N, 10N, four total workers with one unavailable, concurrency 8, 0.25-second mean service, pool budget, payload and one-day sizing horizon) is explicitly synthetic. No production traffic, target infrastructure, cost or provider quota is inferred. Worksheets: `docs/meta-v2/m1-09/workload-model.csv`, `capacity-model.csv`, and `cost-budget.csv`. Scale/maintenance/abort guardrail fixture: `tools/m1-09/fixtures/operations-guardrails.json`.
