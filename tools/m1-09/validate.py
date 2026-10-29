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
WORKLOAD = ROOT / "docs" / "meta-v2" / "m1-09" / "workload-model.csv"
COST_BUDGET = ROOT / "docs" / "meta-v2" / "m1-09" / "cost-budget.csv"
TABLETOP = Path(__file__).resolve().parent / "fixtures" / "tabletop.json"
GUARDRAILS = Path(__file__).resolve().parent / "fixtures" / "operations-guardrails.json"
EXPECTED = {"nominal", "burst", "growth"}
EXPECTED_WORKLOAD = {"nominal", "burst-3x", "growth-10x"}


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


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def validate_workload() -> int:
    rows = {row["scenario"]: row for row in read_rows(WORKLOAD)}
    require(set(rows) == EXPECTED_WORKLOAD,
            "workload model must define nominal, 3x burst, and 10x growth")

    for row in rows.values():
        name = row["scenario"]
        number = lambda column: float(row[column])
        require(row["classification"] == "synthetic-only",
                f"{name}: every workload input must be labeled synthetic-only")
        close(number("assets_total"),
              number("companies_count") * number("assets_per_company"),
              f"{name}: total assets = companies * assets/company")
        history_bytes = (number("history_opt_in_companies")
                         * number("history_items_per_opt_in_company_per_day")
                         * number("history_bytes_per_item")
                         * number("history_retention_days"))
        close(number("history_storage_bytes_estimate"), history_bytes,
              f"{name}: history storage = opt-in companies * items/day * bytes * days")
        close(number("worker_event_arrival_per_second"),
              number("webhook_events_per_second"),
              f"{name}: worker model arrival matches webhook lane")
        for field in ("api_requests_per_second", "webhook_events_per_second",
                      "outbound_send_operations_per_second", "template_operations_per_second"):
            require(number(field) > 0, f"{name}: {field} must be explicit and positive")

    factors = (("burst-3x", 3.0), ("growth-10x", 10.0))
    scaled = ("companies_count", "assets_total", "history_opt_in_companies",
              "history_storage_bytes_estimate", "api_requests_per_second",
              "webhook_events_per_second", "outbound_send_operations_per_second",
              "template_operations_per_second", "worker_event_arrival_per_second")
    for scenario, factor in factors:
        for field in scaled:
            close(float(rows[scenario][field]), float(rows["nominal"][field]) * factor,
                  f"{scenario}: {field} must scale by {factor:g}x")
    return len(rows)


def validate_cost_budget() -> int:
    rows = read_rows(COST_BUDGET)
    scenarios = EXPECTED_WORKLOAD
    expected_components = {
        "worker-compute", "database-and-connection-capacity", "history-and-raw-storage",
        "backup-and-key-recovery", "queue-and-event-processing", "api-egress",
        "observability", "Meta-outbound-sends", "Meta-template-operations",
    }
    require({row["scenario"] for row in rows} == scenarios,
            "cost worksheet must include each workload scenario")
    for scenario in scenarios:
        scenario_rows = [row for row in rows if row["scenario"] == scenario]
        require({row["cost_component"] for row in scenario_rows} == expected_components,
                f"{scenario}: incomplete cost line items")
        require(len(scenario_rows) == len(expected_components),
                f"{scenario}: duplicate cost line item")
        for row in scenario_rows:
            require(bool(row["usage_formula"]), "each cost item needs a quantity formula")
            require(row["line_total_formula"] == "quantity * unit_rate",
                    "line total formula changed without updating validator")
            for field in ("quantity_value", "unit_rate_input", "currency_input",
                          "billing_period_input", "budget_owner_input",
                          "approved_budget_cap_input"):
                require(row[field] == "NOT_CONFIRMED",
                        f"{scenario}/{row['cost_component']}: do not invent {field}")
            require(row["gate_status"] == "OPEN",
                    f"{scenario}/{row['cost_component']}: unpriced cost gate must remain OPEN")
    return len(rows)


def validate_operations_guardrails() -> int:
    data = json.loads(GUARDRAILS.read_text(encoding="utf-8"))
    require(data["synthetic_only"] is True, "operational thresholds must be labeled synthetic")
    meta = data["meta_quota_gate"]
    require(meta["verification_status"] == "NOT_CONFIRMED",
            "Meta quota status must remain unconfirmed")
    require(meta["numeric_provider_limits_invented"] is False,
            "do not invent a Meta provider limit")
    require(set(meta["flows"]) == {
        "Facebook", "Instagram", "WhatsApp-exclusive", "Coexistence"},
        "quota verification must cover each product flow separately")
    require(len(meta["required_evidence"]) >= 4,
            "Meta quota gate needs documented primary/account evidence")

    scale = data["scale_triggers"]
    close(scale["worker_utilization_to_review"], 0.70, "worker scale review trigger")
    close(scale["minimum_effective_capacity_to_arrival_ratio"], 1.5,
          "minimum single-worker-failure headroom")
    require(scale["one_worker_unavailable_required"] is True,
            "scale plan must tolerate one unavailable worker")
    require(scale["queue_freeze_oldest_age_seconds"] < scale["queue_abort_oldest_age_seconds"],
            "freeze queue expansion before abort threshold")
    require(scale["maximum_drain_seconds"] > 0, "queue drain threshold must be finite")

    tenant = data["tenant_limits"]
    require(tenant["provider_quota_substitute"] is False,
            "internal tenant limits cannot stand in for Meta quota")
    require(tenant["waiting_jobs_max"] > 0 and tenant["background_jobs_max_concurrent"] > 0,
            "tenant background work must have bounded fairness limits")
    require(tenant["history_max_bytes"] > 0 and tenant["history_max_items"] > 0,
            "optional history needs both byte and item caps")

    abort = data["rollout_abort"]
    require(abort["immediate_abort_on_cross_tenant_or_secret_or_double_writer_or_ack_loss"] is True,
            "security, double-writer and ACK-loss conditions must abort immediately")
    close(abort["api_5xx_fraction_over_five_minutes"], 0.02, "API error abort threshold")
    close(abort["provider_throttle_fraction_over_five_minutes"], 0.05,
          "provider throttle abort threshold")

    maintenance = data["maintenance_policy"]
    require(maintenance["preapproved_scope_and_start_end_required"] is True,
            "planned maintenance needs approved scope and interval")
    require(maintenance["named_authorized_owner_input"] == "NOT_CONFIRMED",
            "do not invent an operations owner")
    require(maintenance["contract_notice_lead_time"] == "NOT_CONFIRMED",
            "do not invent customer notice terms")
    require(maintenance["exclude_from_availability_without_contract_clause"] is False,
            "do not unilaterally exclude maintenance from availability")
    require(maintenance["webhook_success_ack_requires_durable_inbox"] is True,
            "maintenance cannot ACK and discard a webhook")

    key_fields = data["writer_key_fields"]
    require({"app_config_ref", "app_config_version", "credential_ref", "credential_version"}
            <= set(key_fields),
            "writer ownership key must include config and credential references/versions")
    phase_guards = data["migration_phase_writer_invariant"]
    expected_phases = {
        "baseline", "isolated-platform", "prepared-import", "shadow-read",
        "tenant-channel-pilot", "cohort-expansion", "final-cutover", "retirement",
    }
    require({entry["phase"] for entry in phase_guards} == expected_phases,
            "exclusive writer invariant must cover each transition phase")
    require(all(entry["exactly_one_owner_per_composite_key"] for entry in phase_guards),
            "every phase must have exactly one writer per config+credential key")
    return len(scale) + len(tenant) + len(abort) + len(maintenance) + len(phase_guards)


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

    ownership = data["exclusive_writer_by_composite_key"]
    ownership_phases = {entry["phase"] for entry in ownership}
    require(ownership_phases == {"baseline", "cutover", "rollback"},
            "writer ledger must cover baseline, cutover, and rollback")
    required_key_length = 9  # env, tenant, channel, aggregate, config ref/version, credential ref/version, operation
    keys = {tuple(entry["key"]) for entry in ownership}
    require(len(keys) == 1 and all(len(key) == required_key_length for key in keys),
            "one stable ownership key must include app configuration and credential version")
    expected_key = (resource["environment"], resource["tenant"], resource["channel"],
                    resource["aggregate"], resource["app_config_ref"],
                    resource["app_config_version"], resource["credential_ref"],
                    resource["credential_version"], resource["operation"])
    require(keys == {expected_key}, "writer phases must reference the same composite key")
    require(all("synthetic" in entry["key"][4] and "synthetic" in entry["key"][5]
                and "synthetic" in entry["key"][6] and "synthetic" in entry["key"][7]
                for entry in ownership),
            "tabletop config/credential references must be synthetic opaque references")
    require(all(len(entry["authorized_writers"]) == 1 for entry in ownership),
            "each phase has exactly one writer for the full configuration+credential key")
    for entry in ownership:
        require(entry["authorized_writers"] == phases[entry["phase"]],
                f"{entry['phase']}: composite-key owner disagrees with phase ledger")

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
        workload_count = validate_workload()
        cost_row_count = validate_cost_budget()
        control_count = validate_operations_guardrails()
        webhook_count = validate_tabletop()
    except (KeyError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"M1.09 validation FAIL: {error}", file=sys.stderr)
        return 1
    print(f"M1.09 synthetic validation PASS: capacity_scenarios={scenario_count} workload_scenarios={workload_count} cost_rows={cost_row_count} operational_controls={control_count} workers_unavailable=1/tabletop={webhook_count} webhooks external_calls=0 customer_data=0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
