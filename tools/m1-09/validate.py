#!/usr/bin/env python3
"""Validate M1.09 synthetic capacity formulas and transition tabletop."""

from __future__ import annotations

import csv
import json
import math
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[2]
CAPACITY = ROOT / "docs" / "meta-v2" / "m1-09" / "capacity-model.csv"
TABLETOP = Path(__file__).resolve().parent / "fixtures" / "tabletop.json"
EXPECTED = {"nominal", "burst", "growth"}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def close(actual: float, expected: float, message: str) -> None:
    require(math.isclose(actual, expected, rel_tol=1e-6, abs_tol=1e-6),
            f"{message}: got {actual}, expected {expected}")


def validate_capacity() -> int:
    with CAPACITY.open(encoding="utf-8-sig", newline="") as stream:
        rows = list(csv.DictReader(stream))
    require({row["scenario"] for row in rows} == EXPECTED,
            "capacity worksheet must contain nominal, burst, and growth scenarios")

    for row in rows:
        name = row["scenario"]
        number = lambda column: float(row[column])
        workers = number("total_workers")
        unavailable = number("unavailable_workers")
        available = number("available_workers")
        require(unavailable == 1, f"{name}: model exactly one unavailable worker")
        close(available, workers - unavailable, f"{name}: active worker count")
        require(available >= 1, f"{name}: at least one worker must remain available")

        per_worker = number("concurrency_per_worker") / number("mean_service_seconds")
        close(number("capacity_per_worker_events_per_second"), per_worker,
              f"{name}: capacity = concurrency / service time")
        capacity = available * per_worker
        close(number("worker_capacity_events_per_second"), capacity,
              f"{name}: total capacity = active workers * worker capacity")

        arrival = number("arrival_events_per_second")
        close(number("capacity_margin_events_per_second"), capacity - arrival,
              f"{name}: margin = capacity - arrivals")
        require(capacity > arrival, f"{name}: backlog cannot drain when capacity <= arrival")
        backlog = arrival * number("backlog_age_seconds")
        close(number("initial_backlog_events"), backlog,
              f"{name}: backlog = arrival * backlog window")
        close(number("estimated_drain_seconds"), backlog / (capacity - arrival),
              f"{name}: drain = backlog / (capacity - arrivals)")

        worker_pool = available * number("worker_pool_connections_per_worker")
        close(number("worker_pool_connections_required"), worker_pool,
              f"{name}: active worker DB pools")
        db_required = sum(number(column) for column in (
            "worker_pool_connections_required", "api_pool_connections",
            "migration_reserve_connections", "operations_reserve_connections"))
        close(number("total_connections_required"), db_required,
              f"{name}: total DB connections")
        close(number("connection_headroom"),
              number("synthetic_db_connection_budget") - db_required,
              f"{name}: DB connection headroom")

        retained = (arrival * number("retention_window_seconds")
                    * number("payload_bytes_per_event"))
        close(number("estimated_retained_payload_bytes"), retained,
              f"{name}: retained payload bytes")
    return len(rows)


def validate_tabletop() -> int:
    data = json.loads(TABLETOP.read_text(encoding="utf-8"))
    require(data["synthetic_only"] is True, "tabletop must be synthetic-only")
    require(data["flags"]["shadow_send"] is False, "shadow-send must stay disabled")
    require(data["flags"]["new_write_enabled_only_after_fence"] is True,
            "new writer must wait for a fence")
    require(data["active_legacy_leases_at_cutover"] == 0,
            "old writer must have no active lease before cutover")
    require(data["old_writer_fenced_before_new_write"] is True,
            "old writer must be fenced before new writes")
    fences = data["fences"]
    require(fences == sorted(set(fences)), "fence versions must increase strictly")

    phases = data["writers_by_phase"]
    require(set(phases) == {"baseline", "cutover", "rollback"},
            "tabletop must cover baseline, cutover, and rollback")
    require(all(len(writers) == 1 for writers in phases.values()),
            "each phase must have exactly one business writer")
    resource = data["resource"]
    require(phases["baseline"] == [resource["owner_before"]], "baseline owner mismatch")
    require(phases["cutover"] == [resource["owner_after_cutover"]], "cutover owner mismatch")
    require(phases["rollback"] == [resource["owner_after_rollback"]], "rollback owner mismatch")

    webhooks = data["webhooks"]
    require(len(webhooks) >= 1, "tabletop must include webhook items")
    require(all(item["durably_inboxed_before_ack"] for item in webhooks),
            "ACK cannot precede durable inbox")
    pending = [item for item in webhooks if item["state_at_cutover"] == "PENDING"]
    require(pending and all(item["state_after_rollback"] == "PENDING" for item in pending),
            "pending webhook must survive rollback")
    unknown = [item for item in webhooks if item["state_at_cutover"] == "UNKNOWN"]
    require(unknown and all(item["delivery_attempts"] == 1 for item in unknown),
            "UNKNOWN external outcome cannot be blindly retried")
    require(all(item["state_after_rollback"] == "QUARANTINED_FOR_RECONCILIATION"
                for item in unknown),
            "UNKNOWN outcome must remain quarantined for reconciliation")
    require(all(item["duplicate_business_effects"] == 0 for item in webhooks),
            "tabletop cannot duplicate business effects")
    require(all(item["external_effect_reversed_by_rollback"] is False for item in webhooks),
            "rollback cannot reverse an external effect")
    require(all(data["expected"].values()), "all expected safety properties must be asserted")
    return len(webhooks)


def main() -> int:
    try:
        scenario_count = validate_capacity()
        webhook_count = validate_tabletop()
    except (KeyError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"M1.09 validation FAIL: {error}", file=sys.stderr)
        return 1
    print(f"M1.09 synthetic validation PASS: scenarios={scenario_count} workers_unavailable=1/tabletop={webhook_count} webhooks external_calls=0 customer_data=0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
