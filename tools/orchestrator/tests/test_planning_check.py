import tempfile
import unittest
from pathlib import Path

from tools.orchestrator.planning_check import check


class PlanningCheckTests(unittest.TestCase):
    def test_checks_crlf_and_lf_without_mutating_and_rejects_content_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / '.planning').mkdir()
            target = root / 'docs/meta-v2/acceptance-matrix.csv'
            target.parent.mkdir(parents=True)
            target.write_bytes(b'column\r\nvalue\r\n')
            script = root / '.planning/validate.py'
            script.write_text("from pathlib import Path\np=Path(__file__).parent.parent/'docs/meta-v2/acceptance-matrix.csv'\np.write_text('column\\r\\nvalue\\r\\n', encoding='utf-8')\n", encoding='utf-8')
            before = target.read_bytes()
            check(root)
            self.assertEqual(target.read_bytes(), before)
            target.write_bytes(b'column\nwrong\n')
            with self.assertRaisesRegex(ValueError, 'stale'):
                check(root)
            self.assertEqual(target.read_bytes(), b'column\nwrong\n')
