"""Exercise the actual CLI transport boundary without a model or paid call."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.orchestrator.agents import Codex
from tools.orchestrator.process import ProcessError, ProcessTimeout, clean_environment, command


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.root = Path(__file__).resolve().parents[3]
        self.task = {"key": "M1.01", "acceptance": ["Proven contract"]}
        self.sha = "a" * 40
        self.codex = Codex(self.root, self.directory / "results", 10)

    def result(self, role):
        return {"task": "M1.01", "role": role, "revision": self.sha, "outcome": "pass", "summary": "Verified",
                "criteria": [{"index": 1, "status": "pass", "evidence": ["docs/spec.md:3"]}], "findings": [], "blockers": []}

    def test_worker_contract_stdin_schema_and_permission_flags(self):
        def fake(argv, cwd, timeout, *, stdin, sanitized):
            self.assertEqual(cwd, self.directory)
            self.assertTrue(sanitized)
            self.assertEqual(argv[argv.index("--model") + 1], "gpt-6-luna")
            self.assertIn('model_reasoning_effort="xhigh"', argv)
            self.assertEqual(argv[argv.index("--sandbox") + 1], "workspace-write")
            self.assertEqual(argv[-1], "-")
            self.assertIn("agents.enabled=false", argv)
            self.assertIn('"task":', stdin)
            schema = json.loads(Path(argv[argv.index("--output-schema") + 1]).read_text())
            self.assertFalse(schema["additionalProperties"])
            for field, value in {"task": "M1.01", "role": "implementer", "revision": self.sha}.items():
                self.assertEqual(schema["properties"][field]["enum"], [value])
            self.assertIn('"task": "M1.01"', stdin)
            Path(argv[argv.index("-o") + 1]).write_text(json.dumps(self.result("implementer")))
            return '\n'.join([json.dumps({"type": "thread.started", "thread_id": "opaque-id"}),
                json.dumps({"type": "turn.completed", "usage": {"input_tokens": 42, "output_tokens": 7}})])
        with patch("tools.orchestrator.agents.command", fake):
            self.codex.run(self.task, "implementer", self.directory, self.sha, {})
        self.assertEqual(self.codex.tokens, 49)
        self.assertEqual(self.codex.sessions, ["opaque-id"])

    def test_reviewer_uses_read_only_transport(self):
        def fake(argv, *args, **kwargs):
            self.assertEqual(argv[argv.index("--sandbox") + 1], "read-only")
            self.assertIn("supervisor-executed evidence", kwargs["stdin"])
            self.assertIn("wrong-revision or insufficient checks remain blockers", kwargs["stdin"])
            Path(argv[argv.index("-o") + 1]).write_text(json.dumps(self.result("reviewer")))
            return '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
        with patch("tools.orchestrator.agents.command", fake):
            self.codex.run(self.task, "reviewer", self.directory, self.sha, {})

    def test_invalid_result_still_records_usage(self):
        def fake(argv, *args, **kwargs):
            Path(argv[argv.index("-o") + 1]).write_text('{}')
            return '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":2}}'
        with patch("tools.orchestrator.agents.command", fake), self.assertRaises(ValueError):
            self.codex.run(self.task, "reviewer", self.directory, self.sha, {})
        self.assertEqual(self.codex.tokens, 14)

    def test_failed_transport_preserves_reported_usage_without_printing_logs(self):
        with patch("tools.orchestrator.agents.command", side_effect=ProcessError("safe error",
                '{"type":"turn.completed","usage":{"input_tokens":15,"output_tokens":3}}')):
            with self.assertRaises(ProcessError):
                self.codex.run(self.task, "reviewer", self.directory, self.sha, {})
        self.assertEqual(self.codex.tokens, 18)

    def test_missing_usage_is_unknown_not_zero(self):
        def fake(argv, *args, **kwargs):
            Path(argv[argv.index("-o") + 1]).write_text(json.dumps(self.result("reviewer")))
            return '{"type":"thread.started","thread_id":"example"}'
        with patch("tools.orchestrator.agents.command", fake):
            self.codex.run(self.task, "reviewer", self.directory, self.sha, {})
        self.assertIsNone(self.codex.tokens)

    def test_environment_drops_control_and_provider_credentials(self):
        with patch.dict("os.environ", {"GH_TOKEN": "test", "GITHUB_TOKEN": "test", "META_APP_SECRET": "test",
                "OPENAI_API_KEY": "test", "CODEX_API_KEY": "test", "PATH": "/usr/bin"}, clear=True):
            self.assertEqual(clean_environment(), {"PATH": "/usr/bin"})

    def test_command_treats_shell_metacharacters_as_literal_arguments(self):
        literal = '$(touch should-not-exist); `touch also-not-exist`'
        output = command(["python3", "-c", "import sys;print(sys.argv[1])", literal], self.directory)
        self.assertEqual(output.strip(), literal)
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_timeout_is_typed_and_process_is_reaped(self):
        with self.assertRaises(ProcessTimeout):
            command(["python3", "-c", "import time;time.sleep(30)"], self.directory, timeout=0.05)

    def test_failure_error_does_not_echo_sensitive_stderr(self):
        with self.assertRaises(ProcessError) as error:
            command(["python3", "-c", "import sys;sys.stderr.write('private-output');sys.exit(4)"], self.directory)
        self.assertNotIn("private-output", str(error.exception))


if __name__ == "__main__":
    unittest.main()
