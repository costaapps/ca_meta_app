"""Read-only traceability generation helpers for the M1.10 governance kit."""

from __future__ import annotations

import csv
import io
import json
from pathlib import Path
from typing import Iterable


TRACE_FIELDS = [
    "requirement_id",
    "package",
    "issue_url",
    "milestone",
    "acceptance_criterion",
    "planned_validation",
    "spec_path",
    "contract_path",
    "test_path",
    "package_pr",
    "release_evidence",
    "matrix_evidence_status",
    "delivery_status",
]


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def render_traceability(
    acceptance_rows: Iterable[dict[str, str]],
    package_map: dict[str, dict[str, str]],
) -> str:
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=TRACE_FIELDS, lineterminator="\n")
    writer.writeheader()
    for source in acceptance_rows:
        package = source["package"]
        target = package_map.get(package)
        if target is None:
            raise ValueError(f"No traceability mapping for {package}")
        writer.writerow(
            {
                "requirement_id": source["requirement_id"],
                "package": package,
                "issue_url": source["issue_url"],
                "milestone": source["milestone"],
                "acceptance_criterion": source["acceptance"],
                "planned_validation": source["planned_validation"],
                **target,
                "matrix_evidence_status": source["evidence_status"],
            }
        )
    return output.getvalue()
