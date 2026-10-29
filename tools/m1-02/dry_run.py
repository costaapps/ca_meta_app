from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any


FORBIDDEN_KEY_FRAGMENTS = (
    "token",
    "secret",
    "password",
    "connectionstring",
    "privatekey",
    "credentialvalue",
    "credentialciphertext",
)
FORBIDDEN_EXACT_KEYS = {"dsn"}
VALID_EXPIRY_STATES = {"known", "no_deadline_returned", "unknown"}
# Source literals observed in MetaConnectedPages.Type plus a synthetic normalized
# phone-asset kind from MetaConnectedNumbers. Physical DB enum values stay unconfirmed.
KNOWN_ASSET_KINDS = {"FACEBOOK", "INSTAGRAM", "WHATSAPP", "WHATSAPP_PHONE"}


def _reject_sensitive_keys(value: Any) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized_key = str(key).casefold().replace("_", "").replace("-", "")
            if normalized_key in FORBIDDEN_EXACT_KEYS or any(
                fragment in normalized_key for fragment in FORBIDDEN_KEY_FRAGMENTS
            ):
                raise ValueError("Fixture contains a prohibited credential or connection field.")
            _reject_sensitive_keys(child)
    elif isinstance(value, list):
        for child in value:
            _reject_sensitive_keys(child)


def _require_text(item: dict[str, Any], key: str) -> str:
    value = item.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Fixture is missing required field: {key}.")
    return value.strip()


def _tenant_pair(item: dict[str, Any]) -> tuple[str, str]:
    return (
        _require_text(item, "legacyDatabaseId"),
        _require_text(item, "legacyCompanyId"),
    )


def _normalize_expiry(observation: dict[str, Any]) -> str:
    state = observation.get("providerObservation")
    if not isinstance(state, dict):
        return "unknown"

    status = state.get("status")
    evidence = state.get("evidence")
    if status not in VALID_EXPIRY_STATES or not isinstance(evidence, str) or not evidence.strip():
        return "unknown"

    if status == "known":
        raw = state.get("expiresAt")
        if not isinstance(raw, str) or not raw.strip():
            return "unknown"
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return "unknown"
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            return "unknown"
        return "known"

    if status == "no_deadline_returned":
        if state.get("expiresAt") is not None or state.get("providerFieldPresent") is not False:
            return "unknown"
        return "no_deadline_returned"

    # A legacy sentinel such as "Never" carries no independent validity proof.
    return "unknown"


def dry_run(fixture: dict[str, Any]) -> dict[str, Any]:
    """Classify synthetic legacy rows without connecting to or writing any database."""
    if fixture.get("fixtureClass") != "synthetic-only":
        raise ValueError("Only fixtures explicitly marked synthetic-only are accepted.")
    _reject_sensitive_keys(fixture)
    source_version = _require_text(fixture, "sourceVersion")
    projection_version = _require_text(fixture, "projectionVersion")

    mappings = fixture.get("tenantMappings")
    records = fixture.get("records")
    if not isinstance(mappings, list) or not isinstance(records, list):
        raise ValueError("Fixture must contain tenantMappings and records arrays.")

    targets_by_pair: dict[tuple[str, str], set[str]] = defaultdict(set)
    for mapping in mappings:
        if not isinstance(mapping, dict):
            raise ValueError("Tenant mapping entries must be objects.")
        pair = _tenant_pair(mapping)
        tenant_id = _require_text(mapping, "tenantId")
        targets_by_pair[pair].add(tenant_id)

    classified: list[dict[str, Any]] = []
    duplicate_groups: dict[tuple[str, str, str], list[int]] = defaultdict(list)
    expiry_counts: Counter[str] = Counter()
    rows_by_source_id: dict[str, list[int]] = defaultdict(list)
    for index, record in enumerate(records, start=1):
        if isinstance(record, dict) and isinstance(record.get("sourceRowId"), str):
            rows_by_source_id[record["sourceRowId"]].append(index)

    for index, record in enumerate(records, start=1):
        if not isinstance(record, dict):
            raise ValueError("Record entries must be objects.")

        pair = _tenant_pair(record)
        owners = targets_by_pair.get(pair, set())
        result: dict[str, Any] = {"row": index, "disposition": "quarantine", "reason": None}

        if not owners:
            result["reason"] = "tenant_mapping_missing"
        elif len(owners) != 1:
            result["reason"] = "tenant_mapping_conflict"
        else:
            tenant_id = next(iter(owners))
            kind = record.get("type")
            external_id = record.get("externalId")
            if not isinstance(kind, str) or not kind.strip() or not isinstance(external_id, str) or not external_id.strip():
                result["reason"] = "asset_identity_incomplete"
            elif kind.strip() not in KNOWN_ASSET_KINDS:
                result["reason"] = "unknown_asset_kind"
            else:
                parent_id = record.get("parentSourceRowId")
                parent_error = None
                if parent_id is not None:
                    expected_parent_type = record.get("expectedParentType")
                    if not isinstance(expected_parent_type, str) or expected_parent_type.strip() not in KNOWN_ASSET_KINDS:
                        parent_error = "parent_type_rule_missing"
                    elif not isinstance(parent_id, str) or not parent_id.strip():
                        parent_error = "parent_row_missing"
                    else:
                        parent_indexes = rows_by_source_id.get(parent_id, [])
                        if not parent_indexes:
                            parent_error = "parent_row_missing"
                        elif len(parent_indexes) != 1:
                            parent_error = "parent_row_ambiguous"
                        else:
                            parent = records[parent_indexes[0] - 1]
                            parent_owners = targets_by_pair.get(_tenant_pair(parent), set())
                            if len(parent_owners) != 1:
                                parent_error = "parent_tenant_unresolved"
                            elif next(iter(parent_owners)) != tenant_id:
                                parent_error = "parent_cross_tenant"
                            elif parent.get("type") != expected_parent_type.strip():
                                parent_error = "parent_type_conflict"
                if parent_error:
                    result["reason"] = parent_error
                else:
                    result.update(disposition="candidate", reason="unique_tenant_asset_key")
                    duplicate_groups[(tenant_id, kind.strip(), external_id.strip())].append(index)

        observations = record.get("credentialExpiryObservations", [])
        if not isinstance(observations, list):
            raise ValueError("credentialExpiryObservations must be an array.")
        for observation in observations:
            if not isinstance(observation, dict):
                raise ValueError("Expiry observations must be objects.")
            expiry_counts[_normalize_expiry(observation)] += 1

        classified.append(result)

    duplicate_row_ids = {
        index
        for indexes in duplicate_groups.values()
        if len(indexes) > 1
        for index in indexes
    }
    for result in classified:
        if result["row"] in duplicate_row_ids:
            result.update(disposition="quarantine", reason="duplicate_asset_within_tenant")

    for record, result in zip(records, classified):
        parent_id = record.get("parentSourceRowId")
        if result["disposition"] == "candidate" and parent_id:
            parent_indexes = rows_by_source_id.get(parent_id, [])
            if len(parent_indexes) == 1 and classified[parent_indexes[0] - 1]["disposition"] != "candidate":
                result.update(disposition="quarantine", reason="parent_not_importable")

    dispositions = Counter(row["disposition"] for row in classified)
    reasons = Counter(row["reason"] for row in classified if row["disposition"] == "quarantine")

    return {
        "fixtureClass": "synthetic-only",
        "sourceVersion": source_version,
        "projectionVersion": projection_version,
        "writesPerformed": 0,
        "databaseConnections": 0,
        "sourceRows": len(classified),
        "candidateRows": dispositions["candidate"],
        "quarantinedRows": dispositions["quarantine"],
        "quarantineReasons": dict(sorted(reasons.items())),
        "duplicateTenantAssetGroups": sum(len(indexes) > 1 for indexes in duplicate_groups.values()),
        "expiryObservations": {
            state: expiry_counts[state]
            for state in ("known", "no_deadline_returned", "unknown")
        },
        "rows": classified,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only synthetic tenant migration dry-run.")
    parser.add_argument(
        "--fixture",
        type=Path,
        default=Path("docs/meta-v2/fixtures/m1-02-synthetic.json"),
        help="JSON fixture marked synthetic-only (default: docs/meta-v2/fixtures/m1-02-synthetic.json)",
    )
    args = parser.parse_args()
    fixture = json.loads(args.fixture.read_text(encoding="utf-8"))
    print(json.dumps(dry_run(fixture), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
