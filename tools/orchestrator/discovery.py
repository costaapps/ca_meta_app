"""Explicit additive scope amendment for independent M1 schema/Meta design."""
import json
import sqlite3
import time
from pathlib import Path
from .catalog import digest
from .process import git

KEY = 'M1.discovery'


def definition():
    return json.loads((Path(__file__).resolve().parents[2] / 'execution/m1-discovery-amendment.json').read_text(encoding='utf-8'))


def revised(catalog, change):
    tasks = dict(catalog.tasks)
    for key, patch in change['patches'].items():
        if digest(tasks[key]) != patch['original_task_hash']:
            raise ValueError('Discovery source changed: ' + key)
        tasks[key] = dict(tasks[key], **patch['changes'])
    return tasks


def apply_recorded(catalog, state):
    row = state.db.execute('SELECT data FROM scope_amendments WHERE milestone=?', (KEY,)).fetchone()
    if not row:
        return
    record = json.loads(row[0])
    change = definition()
    tasks = revised(catalog, change)
    if (record['amendment_hash'], record['old_catalog_hash'], record['new_catalog_hash']) != (
            digest(change), catalog.fingerprint, digest(tasks)):
        raise ValueError('Discovery amendment drift; use reviewed runner and reconcile')
    catalog.tasks, catalog.fingerprint = tasks, digest(tasks)


def adopt(root, state, catalog, policy, milestone, reason):
    if milestone != 'M1' or not reason.strip():
        raise ValueError('Discovery amendment requires explicit M1 decision')
    run = state.run('M1')
    if not run or run['status'] in {'usage_unknown', 'awaiting_human', 'done'} or run.get('final_pr'):
        raise ValueError('No eligible M1 checkpoint')
    if state.db.execute('SELECT 1 FROM scope_amendments WHERE milestone=?', (KEY,)).fetchone():
        raise ValueError('Discovery amendment already recorded')
    if (run['catalog_hash'], run['policy_hash'], run['develop_sha']) != (
            catalog.fingerprint, digest(policy), git(root, 'rev-parse', 'HEAD')):
        raise ValueError('Pinned checkpoint differs; cannot amend')
    change = definition()
    for key in catalog.milestone('M1'):
        task = state.task(key)
        if task['status'] in {'running', 'reviewing'}:
            raise ValueError('Interrupted task needs reconciliation before adoption: ' + key)
        if key in change['patches'] and (task['status'] not in {'blocked', 'retry', 'pending'} or task['data'].get('pr')):
            raise ValueError('Cannot change an accepted/reviewed/PR-bearing task: ' + key)
    tasks = revised(catalog, change)
    record = {'amendment_hash': digest(change), 'old_catalog_hash': catalog.fingerprint,
              'new_catalog_hash': digest(tasks), 'reason': reason, 'version': change['version']}
    backup = sqlite3.connect(state.directory / ('before-discovery-' + str(time.time_ns()) + '.sqlite3'))
    try:
        state.db.backup(backup)
    finally:
        backup.close()
    with state.db:
        state.db.execute('INSERT INTO scope_amendments VALUES (?,?)', (KEY, json.dumps(record)))
        state.db.execute('UPDATE runs SET catalog_hash=?,updated=? WHERE milestone=?',
                         (record['new_catalog_hash'], time.time(), 'M1'))
        for key in change['patches']:
            previous = state.task(key)
            details = dict(previous['data'], stage='implement', reason='Independent discovery scope adopted')
            state.db.execute('UPDATE tasks SET status=?,data=?,updated=? WHERE key=?',
                             ('retry', json.dumps(details), time.time(), key))
        state.db.execute('INSERT INTO events(milestone,kind,data,at) VALUES (?,?,?,?)',
                         ('M1', 'operator_discovery_amended', json.dumps(record), time.time()))
    return record
