"""Durability and single-controller ownership, without remote services."""
import json
import tempfile
import unittest
from pathlib import Path

from tools.orchestrator.state import State


class StateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "runtime"
        self.state = State(self.path)

    def tearDown(self):
        self.state.close()
        self.temp.cleanup()

    def test_checkpoint_survives_reopen_and_preserves_previous_data(self):
        self.state.start("M1", "catalog", "policy", "base", "integration")
        self.state.save("M1.01", "running", attempt=1, branch="codex/m1-01", revision="candidate")
        self.state.save("M1.01", "reviewing", checks=["build passed"])
        self.state.close()
        self.state = State(self.path)
        row = self.state.task("M1.01")
        self.assertEqual(row["status"], "reviewing")
        self.assertEqual(row["attempt"], 1)
        self.assertEqual(row["data"]["branch"], "codex/m1-01")
        self.assertEqual(row["data"]["checks"], ["build passed"])
        self.assertEqual(self.state.states(), {"M1.01": "reviewing"})

    def test_attempt_and_event_write_are_atomic(self):
        self.state.save("M1.01", "blocked", attempt=2, reason="External evidence missing")
        events = self.state.db.execute("SELECT task,kind,data FROM events").fetchall()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["task"], "M1.01")
        self.assertEqual(events[0]["kind"], "blocked")
        self.assertEqual(json.loads(events[0]["data"])["reason"], "External evidence missing")

    def test_resume_rejects_changed_catalog_policy_or_base(self):
        self.state.start("M1", "catalog", "policy", "base", "integration")
        for values in [("different", "policy", "base"), ("catalog", "different", "base"),
                       ("catalog", "policy", "different")]:
            with self.subTest(values=values), self.assertRaises(RuntimeError):
                self.state.start("M1", *values, "integration")

    def test_two_connections_cannot_own_the_controller_lock(self):
        other = State(self.path)
        try:
            with self.state.lock():
                with self.assertRaises(RuntimeError):
                    with other.lock():
                        self.fail("Concurrent controller acquired active lock")
            with other.lock():
                pass
        finally:
            other.close()

    def test_exception_releases_lock(self):
        with self.assertRaisesRegex(RuntimeError, "interrupted"):
            with self.state.lock():
                raise RuntimeError("interrupted")
        with self.state.lock():
            pass

    def test_unknown_run_update_field_is_rejected(self):
        with self.assertRaises(ValueError):
            self.state.update_run("M1", injected_column="bad")


if __name__ == "__main__":
    unittest.main()
