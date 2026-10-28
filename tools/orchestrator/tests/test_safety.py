"""Acceptance and scope rejection tests for untrusted agent deliverables."""
from __future__ import annotations

import copy
import tempfile
import unittest
from pathlib import Path

from tools.orchestrator.safety import check_paths, check_result


class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_document_deliverable_is_allowed(self):
        (self.root / "docs").mkdir()
        (self.root / "docs" / "decision.md").write_text("A verified architecture decision.")
        check_paths(["docs/decision.md"], ["docs/*"], self.root)

    def test_empty_change_cannot_be_accepted(self):
        with self.assertRaises(ValueError):
            check_paths([], ["*"], self.root)

    def test_controls_cannot_be_changed_even_with_broad_scope(self):
        for path in (".codex/config.toml", "tools/orchestrator/controller.py", "execution/config.json",
                     ".planning/manifest.json", ".github/workflows/a.yml", "apps/api/AGENTS.md"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                check_paths([path], ["*"], self.root)

    def test_sensitive_php_is_never_a_deliverable(self):
        for path in ("backend/connect.php", "backend/connect_old.php"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                check_paths([path], ["backend/*"], self.root)

    def test_path_escape_is_rejected(self):
        for path in ("../escape", "/etc/passwd", "docs/../../secret", "docs/a\x00b"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                check_paths([path], ["*"], self.root)

    def test_scope_is_not_inferred_from_task_claim(self):
        with self.assertRaises(ValueError):
            check_paths(["src/app/app.ts"], ["docs/*"], self.root)

    def test_symlink_and_parent_symlink_are_rejected(self):
        outside = self.root / "other"
        outside.mkdir()
        (outside / "note.md").write_text("contents")
        (self.root / "docs").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            check_paths(["docs/note.md"], ["docs/*"], self.root)

    def test_nested_repository_directory_is_not_a_deliverable(self):
        (self.root / "apps" / "nested").mkdir(parents=True)
        (self.root / "apps" / "nested" / ".git").mkdir()
        with self.assertRaises(ValueError):
            check_paths(["apps/nested"], ["apps/*"], self.root)

    def test_recognizable_secret_marker_is_rejected(self):
        (self.root / "docs").mkdir()
        (self.root / "docs" / "bad.md").write_text("-----BEGIN PRIVATE KEY-----")
        with self.assertRaises(ValueError):
            check_paths(["docs/bad.md"], ["docs/*"], self.root)


class ResultTests(unittest.TestCase):
    def setUp(self):
        self.task = {"key": "M1.01", "acceptance": ["A", "B"]}
        self.sha = "a" * 40
        self.good = {"task": "M1.01", "role": "reviewer", "revision": self.sha,
                     "outcome": "pass", "summary": "Reviewed evidence.",
                     "criteria": [{"index": 1, "status": "pass", "evidence": ["docs/a.md:1"]},
                                  {"index": 2, "status": "pass", "evidence": ["docs/b.md:1"]}],
                     "findings": [], "blockers": []}

    def check(self, result):
        return check_result(result, self.task, self.sha, "reviewer")

    def test_valid_exact_revision_is_accepted(self):
        self.assertEqual(self.check(self.good), self.good)

    def test_revision_role_and_task_must_match(self):
        for field, value in (("revision", "b" * 40), ("role", "implementer"), ("task", "M1.02")):
            result = dict(self.good, **{field: value})
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.check(result)

    def test_incomplete_criteria_are_rejected(self):
        result = copy.deepcopy(self.good)
        result["criteria"].pop()
        with self.assertRaises(ValueError):
            self.check(result)

    def test_duplicate_criterion_indexes_are_rejected(self):
        result = copy.deepcopy(self.good)
        result["criteria"][1]["index"] = 1
        with self.assertRaises(ValueError):
            self.check(result)

    def test_passing_claim_without_evidence_is_rejected(self):
        result = copy.deepcopy(self.good)
        result["criteria"][0]["evidence"] = []
        with self.assertRaises(ValueError):
            self.check(result)

    def test_passing_claim_with_blocking_finding_is_rejected(self):
        result = copy.deepcopy(self.good)
        result["findings"] = [{"severity": "blocking", "location": "docs/a.md:1", "description": "Unproven"}]
        with self.assertRaises(ValueError):
            self.check(result)

    def test_passing_claim_with_blocked_criterion_is_rejected(self):
        result = copy.deepcopy(self.good)
        result["criteria"][0]["status"] = "blocked"
        with self.assertRaises(ValueError):
            self.check(result)

    def test_blocked_outcome_remains_representable(self):
        result = copy.deepcopy(self.good)
        result["outcome"] = "blocked"
        result["blockers"] = ["Missing sanctioned operational source"]
        result["criteria"][0] = {"index": 1, "status": "blocked", "evidence": []}
        self.assertEqual(self.check(result)["outcome"], "blocked")

    def test_malformed_criterion_is_a_controlled_rejection(self):
        result = copy.deepcopy(self.good)
        result["criteria"][0] = "not an object"
        with self.assertRaises(ValueError):
            self.check(result)

    def test_unrecognized_result_fields_are_rejected(self):
        result = dict(self.good, approved=True)
        with self.assertRaises(ValueError):
            self.check(result)


if __name__ == "__main__":
    unittest.main()
