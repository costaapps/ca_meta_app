"""Unit tests for the read-only M1.10 governance helpers."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))

from governance import GovernanceError, broken_local_links, check_catalog_consistency, check_trace_rows, dependency_waves  # noqa: E402
from traceability import TRACE_FIELDS, read_json  # noqa: E402


CASES = json.loads((HERE / "fixtures/governance-cases.json").read_text(encoding="utf-8"))


def trace_row(source: dict[str, str], mapping: dict[str, str]) -> dict[str, str]:
    return {
        "requirement_id": source["requirement_id"],
        "package": source["package"],
        "issue_url": source["issue_url"],
        "milestone": source["milestone"],
        "acceptance_criterion": source["acceptance"],
        "planned_validation": source["planned_validation"],
        **mapping,
        "matrix_evidence_status": source["evidence_status"],
    }


class GraphTests(unittest.TestCase):
    def test_success_fixture_matches_dependencies_and_waves(self) -> None:
        case = CASES["graphs"]["valid"]
        self.assertEqual(dependency_waves(case["tasks"]), case["waves"])
        self.assertEqual(
            check_catalog_consistency(
                case["tasks"],
                {"M1.01", "M1.02", "M1.03"},
                {"M1.01": [], "M1.02": ["M1.01"], "M1.03": []},
                {"M1.01", "M1.02", "M1.03"},
                case["waves"],
            ),
            case["waves"],
        )

    def test_cycle_fixture_fails(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "cycle"):
            dependency_waves(CASES["graphs"]["cycle"]["tasks"])

    def test_missing_dependency_fixture_fails(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "Unknown dependency"):
            dependency_waves(CASES["graphs"]["missing_dependency"]["tasks"])

    def test_drifted_wave_fixture_fails(self) -> None:
        case = CASES["graphs"]["valid"]
        with self.assertRaisesRegex(GovernanceError, "wave drift"):
            check_catalog_consistency(
                case["tasks"],
                {"M1.01", "M1.02", "M1.03"},
                {"M1.01": [], "M1.02": ["M1.01"], "M1.03": []},
                {"M1.01", "M1.02", "M1.03"},
                CASES["graphs"]["drifted_waves"],
            )

    def test_task_manifest_id_drift_fails(self) -> None:
        case = CASES["graphs"]["valid"]
        with self.assertRaisesRegex(GovernanceError, "Task/manifest drift"):
            check_catalog_consistency(case["tasks"], {"M1.01"}, {"M1.01": []}, {"M1.01", "M1.02", "M1.03"}, case["waves"])

    def test_manifest_dependency_drift_fails(self) -> None:
        case = CASES["graphs"]["valid"]
        with self.assertRaisesRegex(GovernanceError, "dependency drift"):
            check_catalog_consistency(
                case["tasks"],
                {"M1.01", "M1.02", "M1.03"},
                {"M1.01": [], "M1.02": [], "M1.03": []},
                {"M1.01", "M1.02", "M1.03"},
                case["waves"],
            )


class TraceabilityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.source = CASES["trace"]["source"]
        self.mapping = CASES["trace"]["mapping"]
        self.row = trace_row(self.source, self.mapping)
        self.issue_map = {"M1.08": {"url": self.source["issue_url"]}}
        self.package_map = {"M1.08": self.mapping}

    def check(self, row: dict[str, str] | None = None, source: dict[str, str] | None = None) -> None:
        check_trace_rows(
            [row or self.row],
            [source or self.source],
            self.issue_map,
            self.package_map,
            HERE,
        )

    def test_success_fixture_traces_issue_spec_contract_test_pr_release(self) -> None:
        self.assertEqual(set(self.row), set(TRACE_FIELDS))
        self.check()

    def test_milestone_acceptance_rejects_non_pr_value(self) -> None:
        mapping = dict(self.mapping, package_pr="not-a-pr")
        row = trace_row(self.source, mapping)
        self.package_map = {"M1.08": mapping}
        with self.assertRaisesRegex(GovernanceError, "Milestone acceptance must link a valid package PR"):
            self.check(row)

    def test_in_progress_package_can_link_open_package_pr(self) -> None:
        mapping = dict(self.mapping, package_pr="https://github.com/costaapps/ca_meta_app/pull/999")
        row = trace_row(self.source, dict(mapping, delivery_status="IN_PROGRESS"))
        self.package_map = {"M1.08": dict(mapping, delivery_status="IN_PROGRESS")}
        self.check(row)

    def test_planned_package_cannot_link_package_pr(self) -> None:
        mapping = dict(
            self.mapping,
            package_pr="https://github.com/costaapps/ca_meta_app/pull/999",
            delivery_status="PLANNED",
        )
        row = trace_row(self.source, mapping)
        self.package_map = {"M1.08": mapping}
        with self.assertRaisesRegex(GovernanceError, "Planned package cannot claim"):
            self.check(row)

    def test_current_m1_10_pr_is_accepted_on_milestone(self) -> None:
        package_map = read_json(HERE / "traceability-map.json")
        mapping = package_map["M1.10"]
        self.assertEqual(mapping["package_pr"], "https://github.com/costaapps/ca_meta_app/pull/93")
        self.assertEqual(mapping["delivery_status"], "ACCEPTED_ON_MILESTONE")
        self.assertEqual(mapping["release_evidence"], "NOT_RELEASED")

    def test_missing_issue_spec_identity_fails(self) -> None:
        source = dict(self.source, requirement_id="M1.09.AC01")
        row = trace_row(source, self.mapping)
        with self.assertRaisesRegex(GovernanceError, "Invalid package/requirement ID pair"):
            self.check(row, source)

    def test_wrong_issue_url_fails(self) -> None:
        row = dict(self.row, issue_url="https://github.com/costaapps/ca_meta_app/issues/999")
        source = dict(self.source, issue_url=row["issue_url"])
        with self.assertRaisesRegex(GovernanceError, "Issue URL"):
            self.check(row, source)

    def test_missing_contract_target_fails(self) -> None:
        mapping = dict(self.mapping, contract_path="fixtures/missing-contract.yaml")
        row = trace_row(self.source, mapping)
        self.package_map = {"M1.08": mapping}
        with self.assertRaisesRegex(GovernanceError, "Missing contract_path"):
            self.check(row)

    def test_acceptance_drift_fails(self) -> None:
        source = dict(self.source, acceptance="Changed acceptance.")
        with self.assertRaisesRegex(GovernanceError, "Acceptance criterion drift"):
            self.check(source=source)


class MarkdownLinkTests(unittest.TestCase):
    def test_valid_link_fixture_passes(self) -> None:
        paths = [HERE / "fixtures/links-valid.md"]
        self.assertEqual(broken_local_links(paths, HERE), [])

    def test_broken_link_fixture_is_reported(self) -> None:
        paths = [HERE / "fixtures/links-broken.md"]
        self.assertIn("missing.md", broken_local_links(paths, HERE)[0])


if __name__ == "__main__":
    unittest.main()
