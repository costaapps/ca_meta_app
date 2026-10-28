"""Explicit, narrowly scoped operator amendment; never rewrite checkpoint hashes by hand."""
from __future__ import annotations

import json
from pathlib import Path

from .catalog import digest
from .process import git


def definition():
    # Load reviewed controls from the runner, not the potentially older target checkout.
    path = Path(__file__).resolve().parents[2] / 'execution/m1-baseline-amendment.json'
    return json.loads(path.read_text(encoding='utf-8'))


def amended_tasks(catalog, amendment):
    if digest(catalog.tasks['M1.01']) != amendment['original_task_hash']:
        raise ValueError('M1.01 differs from the reviewed amendment source; reconciliation required')
    tasks = dict(catalog.tasks)
    tasks['M1.01'] = dict(tasks['M1.01'], **amendment['changes'])
    return tasks


def apply_recorded(catalog, state):
    row = state.db.execute('SELECT data FROM scope_amendments WHERE milestone=?', ('M1',)).fetchone()
    if not row:
        return
    recorded = json.loads(row[0])
    amendment = definition()
    if recorded['amendment_hash'] != digest(amendment):
        raise ValueError('Recorded scope amendment differs from runner; use the reviewed runner version')
    tasks = amended_tasks(catalog, amendment)
    if recorded['old_catalog_hash'] != catalog.fingerprint or recorded['new_catalog_hash'] != digest(tasks):
        raise ValueError('Scope amendment catalog drift; reconciliation required')
    catalog.tasks, catalog.fingerprint = tasks, digest(tasks)


def adopt(root, state, catalog, policy, milestone, reason):
    if milestone != 'M1' or not reason.strip():
        raise ValueError('This amendment is only for M1 with an explicit reason')
    run = state.run('M1')
    if not run or run['status'] in {'usage_unknown', 'awaiting_human', 'done'} or run.get('final_pr'):
        raise ValueError('No eligible interrupted M1; reconcile unknown usage/final gate first')
    if state.db.execute('SELECT 1 FROM scope_amendments WHERE milestone=?', ('M1',)).fetchone():
        raise ValueError('Baseline amendment already recorded; resume without adopting again')
    if (run['catalog_hash'], run['policy_hash'], run['develop_sha']) != (
            catalog.fingerprint, digest(policy), git(root, 'rev-parse', 'HEAD')):
        raise ValueError('Pinned catalog, policy or develop changed; cannot adopt amendment')
    for key in catalog.milestone('M1'):
        task = state.task(key)
        if task['status'] not in {'pending', 'blocked', 'retry'} or task['data'].get('pr') or task['data'].get('url'):
            raise ValueError('Amendment requires no running, reviewed, accepted or PR-bearing M1 tasks')
    amendment = definition()
    tasks = amended_tasks(catalog, amendment)
    record = {'amendment_hash': digest(amendment), 'version': amendment['version'],
              'old_catalog_hash': catalog.fingerprint, 'new_catalog_hash': digest(tasks),
              'reason': reason, 'develop_sha': run['develop_sha']}
    import time
    import sqlite3
    backup = sqlite3.connect(state.directory / ('before-scope-amendment-' + str(time.time_ns()) + '.sqlite3'))
    try:
        state.db.backup(backup)
    finally:
        backup.close()
    with state.db:
        state.db.execute('INSERT INTO scope_amendments VALUES (?,?)', ('M1', json.dumps(record)))
        state.db.execute('UPDATE runs SET catalog_hash=?, updated=? WHERE milestone=?',
                         (record['new_catalog_hash'], time.time(), 'M1'))
        state.db.execute('INSERT INTO events(milestone,kind,data,at) VALUES (?,?,?,?)',
                         ('M1', 'operator_scope_amended', json.dumps(record), time.time()))
    return record
