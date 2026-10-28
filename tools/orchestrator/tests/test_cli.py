"""Operator commands must remain inert until execution is explicitly requested."""
import contextlib
import io
import json
import unittest
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

    def test_configuration_validation_covers_all_catalog_packages(self):
        code, output = self.call(["validate"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output)["tasks"], 66)


if __name__ == "__main__":
    unittest.main()
