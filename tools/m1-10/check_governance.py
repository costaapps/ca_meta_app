"""Read-only governance check for links, issue/spec trace and dependency drift."""

from __future__ import annotations

import json
from pathlib import Path

from governance import (
    GovernanceError,
    broken_local_links,
    check_catalog_consistency,
    check_trace_rows,
    check_feature_specs,
    parse_task_definitions,
)
from traceability import read_csv, read_json


ROOT = Path(__file__).resolve().parents[2]


def markdown_scope() -> list[Path]:
    paths = [
        ROOT / "AGENTS.md",
        ROOT / ".github/docs/agent-context/git-workflow.md",
        ROOT / ".github/docs/agent-context/known-issues.md",
        ROOT / ".github/docs/agent-context/roadmap.md",
        ROOT / ".github/ISSUE_TEMPLATE/work-package.md",
        ROOT / ".github/PULL_REQUEST_TEMPLATE.md",
        ROOT / "docs/codex-desktop/execution-contract.md",
        ROOT / "docs/codex-desktop/progress-and-handoff.md",
        ROOT / "docs/meta-v2/sdd-playbook.md",
        ROOT / "docs/meta-v2/README.md",
        ROOT / "docs/meta-v2/specs/README.md",
        ROOT / "docs/meta-v2/specs/authentication.md",
        ROOT / "docs/meta-v2/specs/tenancy.md",
        ROOT / "docs/meta-v2/specs/credentials.md",
        ROOT / "docs/meta-v2/specs/meta-onboarding.md",
        ROOT / "docs/meta-v2/specs/webhooks.md",
        ROOT / "docs/meta-v2/specs/portal.md",
        ROOT / "docs/meta-v2/specs/legacy-bridge.md",
        ROOT / "tools/m1-10/README.md",
    ]
    missing = [path for path in paths if not path.is_file()]
    if missing:
        raise GovernanceError(f"Expected governance Markdown is missing: {[p.relative_to(ROOT).as_posix() for p in missing]}")
    return paths


def main() -> int:
    try:
        tasks = parse_task_definitions(sorted((ROOT / ".planning").glob("m[1-6].py")))
        manifest = read_json(ROOT / ".planning/manifest.json")
        manifest_packages = [item for item in manifest["items"] if item.get("milestone") in range(1, 7) and item["key"].count(".") == 1]
        manifest_keys = {item["key"] for item in manifest_packages}
        manifest_dependencies = {item["key"]: item["deps"] for item in manifest_packages}
        issue_map = read_json(ROOT / ".planning/issues-map.json")
        waves = read_json(ROOT / ".planning/dependency-waves.json")
        computed_waves = check_catalog_consistency(tasks, manifest_keys, manifest_dependencies, set(issue_map), waves)

        source_rows = read_csv(ROOT / "docs/meta-v2/acceptance-matrix.csv")
        trace_rows = read_csv(ROOT / "docs/meta-v2/traceability.csv")
        package_map = read_json(ROOT / "tools/m1-10/traceability-map.json")
        if set(package_map) != {str(task["key"]) for task in tasks}:
            raise GovernanceError("Traceability package-map IDs drift from planning tasks")
        check_trace_rows(trace_rows, source_rows, issue_map, package_map, ROOT)

        broken = broken_local_links(markdown_scope(), ROOT)
        if broken:
            raise GovernanceError("Broken local Markdown links: " + "; ".join(broken))

        if len(trace_rows) != len(source_rows):
            raise GovernanceError("Vertical trace sample does not cover every acceptance requirement")
        vertical = next((row for row in trace_rows if row["requirement_id"] == "M1.08.AC01"), None)
        if vertical is None or vertical["spec_path"] != "docs/meta-v2/experience/journey-spec.md" or vertical["test_path"] != "tools/m1-08/walkthrough.mjs":
            raise GovernanceError("M1.08 portal vertical trace sample is absent or points to the wrong artifacts")
        if (
            vertical["package_pr"] != "https://github.com/costaapps/ca_meta_app/pull/92"
            or vertical["delivery_status"] != "ACCEPTED_ON_MILESTONE"
            or vertical["release_evidence"] != "NOT_RELEASED"
        ):
            raise GovernanceError("M1.08 vertical sample must show its actual package PR and pending release")
        feature_spec_count = check_feature_specs(ROOT)

    except (OSError, KeyError, TypeError, json.JSONDecodeError, GovernanceError, ValueError) as exc:
        print(f"M1.10 governance FAIL: {exc}")
        return 1

    print(
        f"M1.10 governance PASS: {len(tasks)} packages, {sum(map(len, computed_waves))} dependency nodes, "
        f"{len(trace_rows)} acceptance requirements, {feature_spec_count} feature specs and "
        f"{len(markdown_scope())} Markdown files checked."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
