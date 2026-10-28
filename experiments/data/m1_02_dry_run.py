#!/usr/bin/env python3
"""Offline synthetic M1.02 mapper; reads JSON and prints aggregate-only results."""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any


FIXTURE = Path(__file__).with_name("m1_02_fixture.json")
EXPIRY_STATES = {"KNOWN", "NO_DEADLINE_RETURNED", "UNKNOWN"}


def _complete_pair(row: dict[str, Any]) -> bool:
    return bool(row.get("legacy_database_id")) and bool(
        row.get("legacy_company_id")
    )


def _scope(row: dict[str, Any], fixture: dict[str, Any]) -> tuple[str, str]:
    return (
        str(row.get("source_system", fixture["source_system"])),
        str(row.get("environment", fixture["environment"])),
    )


def _parse_deadline(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def classify_expiry(observation: dict[str, Any]) -> str:
    """Classify only provenance-backed evidence, not legacy sentinels/fallbacks."""
    if observation.get("provider_observation") != "successful":
        return "UNKNOWN"

    result = observation.get("deadline_result")
    if result == "confirmed" and _parse_deadline(observation.get("deadline_at")):
        return "KNOWN"
    if result == "no_deadline_confirmed":
        return "NO_DEADLINE_RETURNED"
    return "UNKNOWN"


def run_dry_run(fixture: dict[str, Any]) -> dict[str, Any]:
    if fixture.get("synthetic") is not True:
        raise ValueError("refusing fixture not explicitly marked synthetic")

    tenant_rows: dict[tuple[str, str, str, str], list[str]] = defaultdict(list)
    databases: set[str] = set()
    database_companies: Counter[str] = Counter()
    for tenant in fixture["tenants"]:
        source_system, environment = _scope(tenant, fixture)
        database_id = str(tenant["legacy_database_id"])
        company_id = str(tenant["legacy_company_id"])
        tenant_rows[(source_system, environment, database_id, company_id)].append(
            str(tenant["tenant_id"])
        )
        databases.add(database_id)
        database_companies[database_id] += 1

    def possible_tenants(asset: dict[str, Any]) -> set[str]:
        source_system, environment = _scope(asset, fixture)
        candidates: set[str] = set()
        for candidate in fixture["assets"]:
            if not _complete_pair(candidate):
                continue
            if _scope(candidate, fixture) != (source_system, environment):
                continue
            if str(candidate["legacy_database_id"]) != str(
                asset.get("legacy_database_id")
            ):
                continue
            if any(
                candidate.get(field) != asset.get(field)
                for field in ("provider", "asset_kind", "external_asset_id")
            ):
                continue
            pair = (
                source_system,
                environment,
                str(candidate["legacy_database_id"]),
                str(candidate["legacy_company_id"]),
            )
            candidates.update(tenant_rows.get(pair, []))
        return candidates

    complete_assets: list[dict[str, Any]] = []
    ambiguous_assets: list[dict[str, str]] = []
    for asset in fixture["assets"]:
        if not _complete_pair(asset):
            if not asset.get("legacy_company_id"):
                candidates = possible_tenants(asset)
                reason = (
                    "ambiguous_tenant_match"
                    if len(candidates) > 1
                    else "incomplete_legacy_company_pair"
                )
            else:
                reason = "incomplete_legacy_pair"
            ambiguous_assets.append(
                {"source_row_id": str(asset["source_row_id"]), "reason": reason}
            )
            continue

        pair = (
            *_scope(asset, fixture),
            str(asset["legacy_database_id"]),
            str(asset["legacy_company_id"]),
        )
        matching_tenants = tenant_rows.get(pair, [])
        if len(matching_tenants) != 1:
            reason = "unresolved_legacy_pair" if not matching_tenants else "ambiguous_legacy_pair"
            ambiguous_assets.append(
                {"source_row_id": str(asset["source_row_id"]), "reason": reason}
            )
            continue

        complete_assets.append(
            {
                "source_row_id": str(asset["source_row_id"]),
                "tenant_id": matching_tenants[0],
                "identity": (
                    matching_tenants[0],
                    str(fixture["app_config_id"]),
                    _scope(asset, fixture)[1],
                    str(asset["provider"]),
                    str(asset["asset_kind"]),
                    str(asset["external_asset_id"]),
                ),
            }
        )

    identity_groups: dict[
        tuple[str, str, str, str, str, str], list[dict[str, Any]]
    ] = defaultdict(list)
    for asset in complete_assets:
        identity_groups[asset["identity"]].append(asset)

    duplicate_group_count = 0
    duplicate_quarantines: list[dict[str, str]] = []
    mapped_count = 0
    mapped_tenants: set[str] = set()
    for group in identity_groups.values():
        if len(group) > 1:
            duplicate_group_count += 1
            duplicate_quarantines.extend(
                {"source_row_id": row["source_row_id"], "reason": "duplicate_asset_key"}
                for row in group
            )
        else:
            mapped_count += 1
            mapped_tenants.add(group[0]["tenant_id"])

    expiry_counts = Counter(
        classify_expiry(item) for item in fixture["expiry_observations"]
    )
    if set(expiry_counts) - EXPIRY_STATES:
        raise AssertionError("unexpected expiry classification")

    quarantines = ambiguous_assets + duplicate_quarantines
    result = {
        "synthetic": True,
        "source_system": fixture["source_system"],
        "environment": fixture["environment"],
        "app_config_id": fixture["app_config_id"],
        "source_version": fixture["source_version"],
        "mapping_version": fixture["mapping_version"],
        "projection_version": fixture["projection_version"],
        "tenant_count": len(fixture["tenants"]),
        "distinct_legacy_database_count": len(databases),
        "shared_database_company_pair_count": sum(
            count > 1 for count in database_companies.values()
        ),
        "asset_count": len(fixture["assets"]),
        "mapped_asset_count": mapped_count,
        "mapped_tenant_count": len(mapped_tenants),
        "quarantined_asset_count": len(quarantines),
        "duplicate_asset_group_count": duplicate_group_count,
        "ambiguous_tenant_match_count": sum(
            item["reason"] == "ambiguous_tenant_match" for item in ambiguous_assets
        ),
        "quarantines": sorted(
            quarantines, key=lambda item: (item["source_row_id"], item["reason"])
        ),
        "expiry_counts": {state: expiry_counts.get(state, 0) for state in sorted(EXPIRY_STATES)},
        "writes_performed": False,
        "provider_calls_performed": False,
    }
    return result


def validate_expected(result: dict[str, Any], expected: dict[str, Any]) -> None:
    for key, value in expected.items():
        if result.get(key) != value:
            raise AssertionError(f"{key}: expected {value!r}, received {result.get(key)!r}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=FIXTURE)
    args = parser.parse_args()
    fixture = json.loads(args.fixture.read_text(encoding="utf-8"))
    result = run_dry_run(fixture)
    validate_expected(result, fixture["expected"])
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
