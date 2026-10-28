"""UTF-8 repository data must not depend on the Windows ANSI code page."""
import ast
import contextlib
import io
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.orchestrator.__main__ import main
from tools.orchestrator.catalog import Catalog
from tools.orchestrator.process import command

ROOT = Path(__file__).resolve().parents[3]


class EncodingTests(unittest.TestCase):
    def test_manifest_reproduces_the_reported_cp1252_failure(self):
        raw = (ROOT / ".planning/manifest.json").read_bytes()
        with self.assertRaises(UnicodeDecodeError) as error:
            raw.decode("cp1252")
        self.assertEqual(raw[error.exception.start], 0x8D)
        self.assertEqual(len(Catalog(ROOT).tasks), 66)

    def test_validate_with_windows_default_encoding(self):
        original = Path.open

        def windows_open(path, mode="r", buffering=-1, encoding=None, errors=None, newline=None):
            if "b" not in mode and encoding is None:
                encoding = "cp1252"
            return original(path, mode, buffering, encoding, errors, newline)

        with patch.object(Path, "open", windows_open), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(["--root", str(ROOT), "validate"]), 0)

    def test_subprocess_stdout_decodes_utf8_explicitly(self):
        text = command([sys.executable, "-c", "import sys;sys.stdout.buffer.write('a\\u034d'.encode('utf-8'))"], ROOT)
        self.assertEqual(text, "a\u034d")

    def test_production_text_io_declares_encoding(self):
        for folder in (ROOT / "tools/orchestrator", ROOT / ".planning"):
            for file in folder.glob("*.py"):
                for node in ast.walk(ast.parse(file.read_text(encoding="utf-8"))):
                    if not isinstance(node, ast.Call):
                        continue
                    name = getattr(node.func, "attr", getattr(node.func, "id", ""))
                    keywords = {k.arg: k.value for k in node.keywords}
                    if name in {"read_text", "write_text", "open"} or "text" in keywords:
                        self.assertIn("encoding", keywords, f"Implicit encoding: {file}:{node.lineno}")
                    if name == "write_text":
                        self.assertIn("newline", keywords, f"Platform-dependent generated newlines: {file}:{node.lineno}")


if __name__ == "__main__":
    unittest.main()
