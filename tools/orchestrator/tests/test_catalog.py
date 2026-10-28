"""Dependency gates must reject invalid graphs and unapproved prior milestones."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tools.orchestrator.catalog import Catalog, REPOSITORY


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / ".planning").mkdir()

    def write(self, items, *, repository=REPOSITORY, mapping=None):
        if mapping is None:
            mapping = {item["key"]: {"number": n + 10,
                       "url": f"https://github.com/{REPOSITORY}/issues/{n + 10}"}
                       for n, item in enumerate(items)}
        (self.root / ".planning/manifest.json").write_text(json.dumps({"repository": repository, "items": items}))
        (self.root / ".planning/issues-map.json").write_text(json.dumps(mapping))
        return Catalog(self.root)

    def test_dependency_order_overrides_issue_order(self):
        catalog = self.write([{"key": "M1.02", "deps": ["M1.01"]}, {"key": "M1.01", "deps": []}])
        self.assertEqual(catalog.waves(), [["M1.01"], ["M1.02"]])
        self.assertEqual(catalog.ready("M1", {}), ["M1.01"])

    def test_blocked_dependency_does_not_release_downstream(self):
        catalog = self.write([{"key": "M1.01", "deps": []}, {"key": "M1.02", "deps": ["M1.01"]}])
        self.assertEqual(catalog.ready("M1", {"M1.01": "blocked"}), [])

    def test_accepted_same_milestone_can_release_dependency(self):
        catalog = self.write([{"key": "M1.01", "deps": []}, {"key": "M1.02", "deps": ["M1.01"]}])
        self.assertEqual(catalog.ready("M1", {"M1.01": "accepted"}), ["M1.02"])

    def test_prior_milestone_needs_final_done_not_branch_acceptance(self):
        catalog = self.write([{"key": "M1.01", "deps": []}, {"key": "M2.01", "deps": ["M1.01"]}])
        self.assertEqual(catalog.ready("M2", {"M1.01": "accepted"}), [])
        self.assertEqual(catalog.ready("M2", {"M1.01": "done"}), ["M2.01"])

    def test_unknown_dependency_is_rejected(self):
        with self.assertRaises(ValueError):
            self.write([{"key": "M1.01", "deps": ["M1.99"]}])

    def test_cycle_is_rejected(self):
        with self.assertRaises(ValueError):
            self.write([{"key": "M1.01", "deps": ["M1.02"]}, {"key": "M1.02", "deps": ["M1.01"]}])

    def test_duplicate_task_is_rejected(self):
        with self.assertRaises(ValueError):
            self.write([{"key": "M1.01", "deps": []}, {"key": "M1.01", "deps": []}])

    def test_wrong_repository_is_rejected(self):
        with self.assertRaises(ValueError):
            self.write([{"key": "M1.01", "deps": []}], repository="another/project")

    def test_unmapped_issue_is_rejected(self):
        with self.assertRaises(ValueError):
            self.write([{"key": "M1.01", "deps": []}], mapping={})

    def test_mapping_cannot_point_to_another_repository(self):
        with self.assertRaises(ValueError):
            self.write([{"key": "M1.01", "deps": []}], mapping={"M1.01": {"number": 10, "url": "https://github.com/other/repo/issues/10"}})

    def test_canonical_program_contains_66_work_packages(self):
        root = Path(__file__).resolve().parents[3]
        catalog = Catalog(root)
        self.assertEqual(len(catalog.tasks), 66)
        self.assertEqual(sum(len(task["acceptance"]) for task in catalog.tasks.values()), 330)
        self.assertEqual(catalog.ready("M1", {}), ["M1.01"])


if __name__ == "__main__":
    unittest.main()
