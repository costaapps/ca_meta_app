"""Pure, non-writing checks for issue/spec links and the planning dependency graph."""

from __future__ import annotations

import ast
import re
from pathlib import Path
from urllib.parse import unquote

from traceability import TRACE_FIELDS


PACKAGE_RE = re.compile(r"^M[1-6]\.\d{2}$")
REQUIREMENT_RE = re.compile(r"^(M[1-6]\.\d{2})\.AC\d{2,}$")
MARKDOWN_LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
TRACE_SENTINELS = {
    "NOT_YET_AUTHORED",
    "NOT_CREATED",
    "NOT_RELEASED",
}


class GovernanceError(ValueError):
    """Raised when a governance invariant is not satisfied."""


def parse_task_definitions(paths: list[Path]) -> list[dict[str, object]]:
    tasks: list[dict[str, object]] = []
    for path in paths:
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except (OSError, SyntaxError) as exc:
            raise GovernanceError(f"Cannot parse {path}: {exc}") from exc
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name) or node.func.id != "task":
                continue
            if len(node.args) < 6:
                raise GovernanceError(f"task() in {path} has fewer than six positional arguments")
            try:
                key = ast.literal_eval(node.args[0])
                dependency_text = ast.literal_eval(node.args[5])
            except (ValueError, TypeError) as exc:
                raise GovernanceError(f"task key/dependencies must be literals in {path}:{node.lineno}") from exc
            if not isinstance(key, str) or not isinstance(dependency_text, str):
                raise GovernanceError(f"task key/dependencies have an invalid type in {path}:{node.lineno}")
            tasks.append({"key": key, "deps": dependency_text.split()})
    return tasks


def dependency_waves(tasks: list[dict[str, object]]) -> list[list[str]]:
    keys = [str(task["key"]) for task in tasks]
    if len(keys) != len(set(keys)):
        raise GovernanceError("Duplicate package IDs in task sources")
    known = set(keys)
    for task in tasks:
        key = str(task["key"])
        deps = list(task["deps"])
        if len(deps) != len(set(deps)):
            raise GovernanceError(f"Duplicate dependency for {key}")
        missing = sorted(set(deps) - known)
        if missing:
            raise GovernanceError(f"Unknown dependency for {key}: {', '.join(missing)}")
        if key in deps:
            raise GovernanceError(f"Self dependency for {key}")

    finished: set[str] = set()
    waves: list[list[str]] = []
    while len(finished) < len(tasks):
        ready = sorted(
            str(task["key"])
            for task in tasks
            if str(task["key"]) not in finished and set(task["deps"]).issubset(finished)
        )
        if not ready:
            raise GovernanceError("Dependency cycle detected")
        waves.append(ready)
        finished.update(ready)
    return waves


def check_catalog_consistency(
    tasks: list[dict[str, object]],
    manifest_keys: set[str],
    manifest_dependencies: dict[str, list[str]],
    issue_keys: set[str],
    committed_waves: list[list[str]],
) -> list[list[str]]:
    keys = {str(task["key"]) for task in tasks}
    if keys != manifest_keys:
        raise GovernanceError(
            f"Task/manifest drift: tasks-only={sorted(keys - manifest_keys)}, manifest-only={sorted(manifest_keys - keys)}"
        )
    missing_issue_ids = keys - issue_keys
    if missing_issue_ids:
        raise GovernanceError(f"Packages missing issue mapping: {sorted(missing_issue_ids)}")
    source_dependencies = {str(task["key"]): sorted(task["deps"]) for task in tasks}
    expected_dependencies = {key: sorted(values) for key, values in manifest_dependencies.items()}
    if source_dependencies != expected_dependencies:
        raise GovernanceError("Task/manifest dependency drift")
    computed = dependency_waves(tasks)
    if computed != committed_waves:
        raise GovernanceError("Dependency-wave drift: committed waves do not match task dependencies")
    return computed


def check_trace_rows(
    rows: list[dict[str, str]],
    acceptance_rows: list[dict[str, str]],
    issue_map: dict[str, dict[str, object]],
    package_map: dict[str, dict[str, str]],
    root: Path,
) -> None:
    if not rows:
        raise GovernanceError("Traceability CSV is empty")
    if set(rows[0]) != set(TRACE_FIELDS):
        raise GovernanceError("Traceability CSV columns do not match the defined schema")
    expected_ids = [row["requirement_id"] for row in acceptance_rows]
    actual_ids = [row["requirement_id"] for row in rows]
    if len(actual_ids) != len(set(actual_ids)):
        raise GovernanceError("Duplicate requirement IDs in traceability CSV")
    if actual_ids != expected_ids:
        raise GovernanceError("Traceability requirement IDs/order have drifted from the acceptance matrix")

    source_by_id = {row["requirement_id"]: row for row in acceptance_rows}
    for row in rows:
        requirement_id = row["requirement_id"]
        match = REQUIREMENT_RE.fullmatch(requirement_id)
        package = row["package"]
        if not match or match.group(1) != package or not PACKAGE_RE.fullmatch(package):
            raise GovernanceError(f"Invalid package/requirement ID pair: {requirement_id} / {package}")
        source = source_by_id[requirement_id]
        if row["issue_url"] != source["issue_url"] or row["milestone"] != source["milestone"]:
            raise GovernanceError(f"Issue/milestone drift for {requirement_id}")
        mapped_issue = issue_map.get(package)
        if mapped_issue is None or row["issue_url"] != mapped_issue.get("url"):
            raise GovernanceError(f"Issue URL does not match issues-map.json for {package}")
        if row["acceptance_criterion"] != source["acceptance"]:
            raise GovernanceError(f"Acceptance criterion drift for {requirement_id}")
        if row["planned_validation"] != source["planned_validation"]:
            raise GovernanceError(f"Planned validation drift for {requirement_id}")
        mapping = package_map.get(package)
        if mapping is None:
            raise GovernanceError(f"No package mapping for {package}")
        for field in ("spec_path", "contract_path", "test_path", "package_pr", "release_evidence", "delivery_status"):
            if row[field] != mapping.get(field):
                raise GovernanceError(f"{field} drift for {package}")
        for field in ("spec_path", "contract_path", "test_path"):
            value = row[field]
            if value not in TRACE_SENTINELS and not (root / value).is_file():
                raise GovernanceError(f"Missing {field} target for {package}: {value}")
        if row["package_pr"].startswith("https://") and not re.fullmatch(
            r"https://github\.com/costaapps/ca_meta_app/pull/\d+", row["package_pr"]
        ):
            raise GovernanceError(f"Unexpected package PR URL for {package}")
        if row["matrix_evidence_status"] != source["evidence_status"]:
            raise GovernanceError(f"Acceptance matrix status drift for {requirement_id}")
        if row["delivery_status"] == "ACCEPTED_ON_MILESTONE":
            if row["package_pr"] in TRACE_SENTINELS or row["release_evidence"] != "NOT_RELEASED":
                raise GovernanceError(f"Milestone acceptance must link a package PR and keep release pending: {package}")
        elif row["delivery_status"] in {"PLANNED", "IN_PROGRESS"} and row["package_pr"] != "NOT_CREATED":
            raise GovernanceError(f"Undelivered package cannot claim a package PR: {package}")
        elif row["delivery_status"] not in {"PLANNED", "IN_PROGRESS"}:
            raise GovernanceError(f"Unknown delivery status for {package}: {row['delivery_status']}")


def broken_local_links(paths: list[Path], root: Path) -> list[str]:
    broken: list[str] = []
    for path in paths:
        text = path.read_text(encoding="utf-8")
        for raw_target in MARKDOWN_LINK_RE.findall(text):
            target = raw_target.strip().strip("<>").split()[0]
            if not target or target.startswith(("#", "mailto:", "tel:")) or "://" in target:
                continue
            target_path = unquote(target.split("#", 1)[0])
            if not target_path:
                continue
            resolved = (path.parent / target_path).resolve()
            if not resolved.is_relative_to(root.resolve()) or not resolved.exists():
                broken.append(f"{path.relative_to(root)} -> {target}")
    return broken


def check_feature_specs(root: Path) -> int:
    names = (
        "authentication.md",
        "tenancy.md",
        "credentials.md",
        "meta-onboarding.md",
        "webhooks.md",
        "portal.md",
        "legacy-bridge.md",
    )
    required_headings = (
        "## Problem and scope",
        "## Invariants",
        "## Contract and data",
        "## Scenarios",
        "## Implementation, migration and recovery",
    )
    for name in names:
        path = root / "docs/meta-v2/specs" / name
        if not path.is_file():
            raise GovernanceError(f"Missing required feature spec: {path.relative_to(root)}")
        body = path.read_text(encoding="utf-8")
        missing = [heading for heading in required_headings if heading not in body]
        if missing:
            raise GovernanceError(f"Incomplete sections in {path.relative_to(root)}: {missing}")
        if "Not confirmed" not in body:
            raise GovernanceError(f"External gates must be explicit in {path.relative_to(root)}")
        if "| Given | When | Then |" not in body:
            raise GovernanceError(f"Given/When/Then scenarios are required in {path.relative_to(root)}")
    portal = (root / "docs/meta-v2/specs/portal.md").read_text(encoding="utf-8")
    if "tools/m1-08/fixtures/walkthrough.json" not in portal:
        raise GovernanceError("Portal spec must reference the M1.08 vertical fixture")
    return len(names)
