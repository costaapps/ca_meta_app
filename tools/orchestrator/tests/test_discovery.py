import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from tools.orchestrator.catalog import Catalog, digest
from tools.orchestrator.controller import load_policy
from tools.orchestrator.discovery import adopt, apply_recorded
from tools.orchestrator.state import State

ROOT = Path(__file__).resolve().parents[3]


class DiscoveryTests(unittest.TestCase):
    def test_scope_amendment_preserves_accepted_work_and_recovers_only_targets(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = State(Path(tmp))
            self.addCleanup(state.close)
            catalog, policy = Catalog(ROOT), load_policy(ROOT)
            state.start('M1', catalog.fingerprint, digest(policy), 'a'*40, 'b'*40)
            state.save('M1.01', 'accepted', attempt=2, merge_sha='b'*40)
            state.save('M1.02', 'blocked', attempt=1)
            state.save('M1.03', 'blocked', attempt=1)
            before = state.task('M1.01')
            original = dict(catalog.tasks)
            with patch('tools.orchestrator.discovery.git', return_value='a'*40):
                adopt(ROOT, state, catalog, policy, 'M1', 'Independent implementation authorized')
            apply_recorded(catalog, state)
            self.assertEqual(state.task('M1.01'), before)
            for key in ('M1.02','M1.03'):
                self.assertEqual(state.task(key)['status'], 'retry')
                self.assertEqual(state.task(key)['attempt'], 1)
                self.assertFalse(catalog.tasks[key]['external'])
            for key in original:
                if key not in {'M1.02','M1.03'}:
                    self.assertEqual(original[key], catalog.tasks[key])
            self.assertEqual(catalog.fingerprint, state.run('M1')['catalog_hash'])

    def test_amendment_refuses_to_change_accepted_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = State(Path(tmp))
            self.addCleanup(state.close)
            catalog, policy = Catalog(ROOT), load_policy(ROOT)
            state.start('M1', catalog.fingerprint, digest(policy), 'a'*40, 'b'*40)
            state.save('M1.03', 'accepted', merge_sha='b'*40)
            with patch('tools.orchestrator.discovery.git', return_value='a'*40):
                with self.assertRaisesRegex(ValueError,'accepted'):
                    adopt(ROOT, state, catalog, policy, 'M1', 'test')
