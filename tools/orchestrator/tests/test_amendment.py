"""Reviewed scope changes preserve state and cannot silently reaccept work."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.orchestrator.amendment import adopt, apply_recorded, definition
from tools.orchestrator.catalog import Catalog, digest
from tools.orchestrator.controller import load_policy
from tools.orchestrator.state import State

ROOT = Path(__file__).resolve().parents[3]


class AmendmentTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.state = State(Path(temp.name))
        self.addCleanup(self.state.close)
        self.catalog, self.policy = Catalog(ROOT), load_policy(ROOT)
        self.sha = 'a' * 40
        self.state.start('M1', self.catalog.fingerprint, digest(self.policy), self.sha, self.sha)
        self.state.update_run('M1', tokens=760142)
        self.state.save('M1.01', 'blocked', attempt=1, feedback={'summary': 'old result'})
        self.git = patch('tools.orchestrator.amendment.git', return_value=self.sha)
        self.git.start()
        self.addCleanup(self.git.stop)

    def test_explicit_amendment_only_changes_baseline_and_preserves_checkpoint(self):
        before = dict(self.catalog.tasks)
        record = adopt(ROOT, self.state, self.catalog, self.policy, 'M1', 'Operator authorizes PHP replacement scope')
        apply_recorded(self.catalog, self.state)
        self.assertFalse(self.catalog.tasks['M1.01']['external'])
        for key in before:
            if key != 'M1.01':
                self.assertEqual(before[key], self.catalog.tasks[key])
        self.assertEqual(self.state.run('M1')['catalog_hash'], self.catalog.fingerprint)
        self.assertEqual(self.state.run('M1')['tokens'], 760142)
        self.assertEqual(self.state.task('M1.01')['attempt'], 1)
        self.assertEqual(self.state.task('M1.01')['status'], 'blocked')
        self.assertNotEqual(record['old_catalog_hash'], record['new_catalog_hash'])
        self.assertEqual(Catalog(ROOT).fingerprint, record['old_catalog_hash'])

    def test_accepted_work_or_pr_prevents_amendment(self):
        for status, data in [('accepted', {}), ('blocked', {'url': 'https://example.invalid/pr'})]:
            self.state.save('M1.01', status, **data)
            with self.assertRaisesRegex(ValueError, 'PR-bearing'):
                adopt(ROOT, self.state, self.catalog, self.policy, 'M1', 'test')

    def test_unknown_usage_and_pinned_drift_prevent_adoption(self):
        self.state.update_run('M1', status='usage_unknown')
        with self.assertRaises(ValueError):
            adopt(ROOT, self.state, self.catalog, self.policy, 'M1', 'test')
        self.state.update_run('M1', status='running')
        self.policy['max_total_tokens'] += 1
        with self.assertRaisesRegex(ValueError, 'Pinned'):
            adopt(ROOT, self.state, self.catalog, self.policy, 'M1', 'test')

    def test_changed_runner_amendment_fails_closed(self):
        adopt(ROOT, self.state, self.catalog, self.policy, 'M1', 'test')
        changed = definition()
        changed['version'] = 'unreviewed'
        with patch('tools.orchestrator.amendment.definition', return_value=changed):
            with self.assertRaisesRegex(ValueError, 'differs from runner'):
                apply_recorded(self.catalog, self.state)
