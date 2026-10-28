import tempfile
import unittest
from pathlib import Path
from tools.orchestrator.package_checks import discover


class PackageChecksTests(unittest.TestCase):
    def test_generic_entrypoint_and_tests_are_discovered_without_issue_hardcoding(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory = root / 'experiments/data'
            directory.mkdir(parents=True)
            (directory / 'mapping_dry_run.py').write_text("if __name__ == '__main__':\n    print('ok')\n", encoding='utf-8')
            (directory / 'test_mapping.py').write_text('import unittest\n', encoding='utf-8')
            (directory / 'helper.py').write_text('def helper(): pass\n', encoding='utf-8')
            self.assertEqual(discover(root), [
                ['python3', 'experiments/data/mapping_dry_run.py'],
                ['python3', '-m', 'unittest', 'discover', '-s', 'experiments/data', '-p', 'test_*.py', '-v']])

    def test_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'experiments').mkdir()
            (root / 'experiments/check.py').symlink_to(root / 'outside.py')
            with self.assertRaisesRegex(ValueError, 'Symlink'):
                discover(root)
