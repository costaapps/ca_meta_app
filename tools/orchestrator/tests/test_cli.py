"""Operator commands must remain inert until execution is explicitly requested."""
import contextlib
import io
import json
import unittest
import tempfile
from pathlib import Path
from tools.orchestrator.state import State
from unittest.mock import patch

from tools.orchestrator.__main__ import main


class CLITests(unittest.TestCase):
    def call(self, argv):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = main(argv)
        return result, output.getvalue()

    def test_default_run_is_dry_and_never_constructs_controller(self):
        with patch("tools.orchestrator.__main__.Controller", side_effect=AssertionError("Should not execute")):
            code, output = self.call(["run", "M1", "--merge-packages"])
        self.assertEqual(code, 0)
        data = json.loads(output)
        self.assertEqual(data["mode"], "dry-run")
        self.assertEqual(data["waves"][0], ["M1.01"])
        self.assertIn("M1.01", data["external_evidence_required"])

    def test_resume_without_execute_also_remains_inert(self):
        with patch("tools.orchestrator.__main__.State", side_effect=AssertionError("No checkpoint writes")):
            self.assertEqual(self.call(["resume", "M1"])[0], 0)

    def test_runtime_overrides_dry_run_never_starts_agents(self):
        with patch("tools.orchestrator.__main__.State", side_effect=AssertionError("No checkpoint writes")):
            code, output = self.call(["resume", "M1", "--no-token-limit",
                                      "--model", "gpt-6-luna", "--reasoning-effort", "xhigh"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output)["runtime"], {
            "model": "gpt-6-luna", "reasoning_effort": "xhigh", "no_token_limit": True})

    def test_unblock_records_context_and_preserves_history(self):
        with tempfile.TemporaryDirectory() as temp:
            state = State(Path(temp) / "state")
            self.addCleanup(state.close)
            state.save("M1.01", "retry", attempt=3, revision="original")
            with patch("tools.orchestrator.__main__.State", return_value=state), patch.object(state, "close"):
                with self.assertRaisesRegex(ValueError, "retry with --reset-attempts"):
                    self.call(["unblock", "M1", "--issue", "M1.01", "--reason", "test"])
            note = Path(temp) / "note.txt"
            note.write_text("Build and five tests passed; deployment unconfirmed.", encoding="utf-8")
            with patch("tools.orchestrator.__main__.State", return_value=state), patch.object(state, "close"):
                self.call(["unblock", "M1", "--issue", "M1.01", "--reason", "Environment repaired",
                           "--reset-attempts", "--context-file", str(note)])
            record = state.task("M1.01")
            self.assertEqual(record["status"], "retry")
            self.assertEqual(record["attempt"], 0)
            self.assertEqual(record["data"]["revision"], "original")
            self.assertEqual(record["data"]["operator_context"]["text"], note.read_text(encoding="utf-8"))
            self.assertEqual(len(record["data"]["operator_context"]["sha256"]), 64)
            note.write_text("ghp_" + "x" * 40, encoding="utf-8")
            state.save("M1.01", "blocked")
            with patch("tools.orchestrator.__main__.State", return_value=state), patch.object(state, "close"):
                with self.assertRaisesRegex(ValueError, "potential credential"):
                    self.call(["unblock", "M1", "--issue", "M1.01", "--reason", "test",
                               "--context-file", str(note)])
            self.assertEqual(state.task("M1.01")["status"], "blocked")

    def test_configuration_validation_covers_all_catalog_packages(self):
        code, output = self.call(["validate"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output)["tasks"], 66)


if __name__ == "__main__":
    unittest.main()
