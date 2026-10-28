"""Durable checkpoints, audit events and an OS-released single-controller lock."""
from __future__ import annotations

import contextlib
import json
import os
import sqlite3
import time
from pathlib import Path


class State:
    def __init__(self, directory: Path):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.directory = directory
        self.db = sqlite3.connect(directory / "state.sqlite3", timeout=5)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS runs (
          milestone TEXT PRIMARY KEY, catalog_hash TEXT NOT NULL,
          policy_hash TEXT NOT NULL, develop_sha TEXT NOT NULL,
          integration_sha TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
          tokens INTEGER NOT NULL DEFAULT 0, updated REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks (
          key TEXT PRIMARY KEY, milestone TEXT NOT NULL, status TEXT NOT NULL,
          attempt INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}',
          updated REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, milestone TEXT NOT NULL,
          task TEXT, kind TEXT NOT NULL, data TEXT NOT NULL, at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS sync_queue (key TEXT PRIMARY KEY, status TEXT NOT NULL);
        """)
        fields = {r[1] for r in self.db.execute("PRAGMA table_info(runs)")}
        for name, kind in (("final_pr", "INTEGER"), ("final_head", "TEXT")):
            if name not in fields:
                self.db.execute(f"ALTER TABLE runs ADD COLUMN {name} {kind}")
        self.db.commit()
        os.chmod(directory / "state.sqlite3", 0o600)

    def close(self):
        self.db.close()

    @contextlib.contextmanager
    def lock(self):
        try:
            import fcntl
        except ImportError as exc:
            raise RuntimeError("Controller requires Linux/macOS/WSL with flock support") from exc
        with (self.directory / "controller.lock").open("a+") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RuntimeError("Another milestone controller holds this repository lock") from exc
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def run(self, milestone: str) -> dict | None:
        row = self.db.execute("SELECT * FROM runs WHERE milestone=?", (milestone,)).fetchone()
        return dict(row) if row else None

    def start(self, milestone, catalog_hash, policy_hash, develop_sha, integration_sha):
        existing = self.run(milestone)
        if existing:
            if (existing["catalog_hash"], existing["policy_hash"], existing["develop_sha"]) != (
                    catalog_hash, policy_hash, develop_sha):
                raise RuntimeError("Pinned catalog/policy/develop changed; reconcile before resuming")
            return
        with self.db:
            self.db.execute("INSERT INTO runs(milestone,catalog_hash,policy_hash,develop_sha,integration_sha,status,tokens,updated) VALUES (?,?,?,?,?,'running',0,?)",
                            (milestone, catalog_hash, policy_hash, develop_sha, integration_sha, time.time()))

    def update_run(self, milestone, **values):
        if not set(values) <= {"status", "integration_sha", "tokens", "final_pr", "final_head"}:
            raise ValueError("Unknown run field")
        with self.db:
            for key, value in values.items():
                self.db.execute(f"UPDATE runs SET {key}=?,updated=? WHERE milestone=?",
                                (value, time.time(), milestone))

    def task(self, key: str) -> dict:
        row = self.db.execute("SELECT * FROM tasks WHERE key=?", (key,)).fetchone()
        if not row:
            return {"key": key, "milestone": key[:2], "status": "pending", "attempt": 0, "data": {}}
        result = dict(row)
        result["data"] = json.loads(result["data"])
        return result

    def states(self) -> dict[str, str]:
        return dict(self.db.execute("SELECT key,status FROM tasks"))

    def save(self, key: str, status: str, *, attempt=None, **data):
        old = self.task(key)
        details = dict(old["data"], **data)
        with self.db:
            self.db.execute("INSERT INTO tasks VALUES (?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET "
                            "status=excluded.status,attempt=excluded.attempt,data=excluded.data,updated=excluded.updated",
                            (key, key[:2], status, old["attempt"] if attempt is None else attempt,
                             json.dumps(details, ensure_ascii=False), time.time()))
            self.db.execute("INSERT INTO events(milestone,task,kind,data,at) VALUES (?,?,?,?,?)",
                            (key[:2], key, status, json.dumps(data, ensure_ascii=False), time.time()))

    def event(self, milestone, kind, **data):
        with self.db:
            self.db.execute("INSERT INTO events(milestone,kind,data,at) VALUES (?,?,?,?)",
                            (milestone, kind, json.dumps(data, ensure_ascii=False), time.time()))

    def pending_sync(self):
        return dict(self.db.execute("SELECT key,status FROM sync_queue"))

    def queue_sync(self, key, status):
        with self.db:
            self.db.execute("INSERT INTO sync_queue VALUES (?,?) ON CONFLICT(key) DO UPDATE SET status=excluded.status", (key, status))

    def complete_sync(self, key):
        with self.db:
            self.db.execute("DELETE FROM sync_queue WHERE key=?", (key,))
