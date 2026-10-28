"""Read the existing planning manifest as data; never execute generated issue text."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

REPOSITORY = "costaapps/ca_meta_app"


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


class Catalog:
    def __init__(self, root: Path):
        manifest = json.loads((root / ".planning/manifest.json").read_text())
        mapping = json.loads((root / ".planning/issues-map.json").read_text())
        if manifest.get("repository") != REPOSITORY:
            raise ValueError("Planning repository mismatch")
        self.tasks = {}
        self.epics = {}
        for item in manifest["items"]:
            key = item["key"]
            if re.fullmatch(r"M[1-6]", key):
                self.epics[key] = mapping[key]["number"]
            if not re.fullmatch(r"M[1-6]\.\d{2}", key):
                continue
            if key in self.tasks or key not in mapping:
                raise ValueError("Duplicate or unmapped task: " + key)
            task = dict(item, issue=mapping[key]["number"])
            if mapping[key]["url"] != f"https://github.com/{REPOSITORY}/issues/{task['issue']}":
                raise ValueError("Issue mapping repository mismatch")
            self.tasks[key] = task
        if not self.tasks:
            raise ValueError("Empty planning catalog")
        for key, item in self.tasks.items():
            if any(dep not in self.tasks for dep in item["deps"]):
                raise ValueError("Unknown dependency: " + key)
        self.waves()  # Reject cycles before any work can be claimed.
        self.fingerprint = digest(self.tasks)

    def milestone(self, key: str) -> dict:
        if not re.fullmatch(r"M[1-6]", key):
            raise ValueError("Milestone must be M1 through M6")
        return {k: v for k, v in self.tasks.items() if k.startswith(key + ".")}

    def waves(self) -> list[list[str]]:
        pending, accepted, result = set(self.tasks), set(), []
        while pending:
            ready = sorted(k for k in pending if set(self.tasks[k]["deps"]) <= accepted)
            if not ready:
                raise ValueError("Dependency graph contains a cycle")
            result.append(ready)
            accepted.update(ready)
            pending.difference_update(ready)
        return result

    def ready(self, milestone: str, states: dict[str, str]) -> list[str]:
        return [k for k, task in sorted(self.milestone(milestone).items())
                if states.get(k, "pending") in {"pending", "retry"}
                and all(states.get(d) in ({"accepted", "done"} if d[:2] == milestone else {"done"})
                        for d in task["deps"])]
