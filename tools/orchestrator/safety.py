"""Controller-enforced scope, acceptance and review contracts."""
from __future__ import annotations

import fnmatch
import re
from pathlib import Path, PurePosixPath

PROTECTED = (".git", ".codex", ".github/workflows", "tools/orchestrator", "execution", ".planning")
SECRET = re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bEAA[A-Za-z0-9]{50,}\b|\b(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}")


def check_paths(paths: list[str], allowed: list[str], root: Path):
    if not paths:
        raise ValueError("No deliverable changes")
    for path in paths:
        p = PurePosixPath(path)
        if p.is_absolute() or ".." in p.parts or not path or "\x00" in path:
            raise ValueError("Unsafe deliverable path")
        if any(path == prefix or path.startswith(prefix + "/") for prefix in PROTECTED):
            raise ValueError("Automation control change requires human review: " + path)
        if p.name == "AGENTS.md" or path in {"backend/connect.php", "backend/connect_old.php"}:
            raise ValueError("Instruction or sensitive local source change requires human review: " + path)
        if not any(fnmatch.fnmatchcase(path, pattern) for pattern in allowed):
            raise ValueError("Outside milestone scope: " + path)
        target = root / path
        if target.is_symlink() or any(parent.is_symlink() for parent in target.parents if parent != root):
            raise ValueError("Symlink deliverables are not allowed")
        if target.exists() and not target.is_file():
            raise ValueError("Deliverable must be a regular file, not a directory/gitlink")
        if target.exists() and target.is_file():
            if target.stat().st_size > 2_000_000:
                raise ValueError("Deliverable exceeds review size budget")
            if SECRET.search(target.read_text(errors="replace")):
                raise ValueError("Potential credential in deliverable: " + path)


def check_result(result: dict, task: dict, revision: str, role: str):
    required = {"task", "role", "revision", "outcome", "summary", "criteria", "findings", "blockers"}
    if set(result) != required:
        raise ValueError("Agent result fields do not match the contract")
    if (result["task"], result["role"], result["revision"]) != (task["key"], role, revision):
        raise ValueError("Agent result is stale or belongs to a different task/role")
    if result["outcome"] not in {"pass", "fail", "blocked"}:
        raise ValueError("Invalid agent outcome")
    if not isinstance(result["summary"], str) or not isinstance(result["findings"], list) or not isinstance(result["blockers"], list):
        raise ValueError("Invalid result value types")
    criteria = result["criteria"]
    if not isinstance(criteria, list) or len(criteria) != len(task["acceptance"]):
        raise ValueError("Every acceptance criterion must be accounted for")
    if not all(isinstance(c, dict) for c in criteria):
        raise ValueError("Acceptance criteria must be objects")
    if [c.get("index") for c in criteria] != list(range(1, len(criteria) + 1)):
        raise ValueError("Acceptance criterion indexes must be complete and ordered")
    for criterion in criteria:
        if set(criterion) != {"index", "status", "evidence"} or criterion["status"] not in {"pass", "fail", "blocked"}:
            raise ValueError("Malformed criterion")
        if not isinstance(criterion["evidence"], list) or not all(isinstance(e, str) and e.strip() for e in criterion["evidence"]):
            raise ValueError("Evidence must contain references")
        if criterion["status"] == "pass" and not criterion["evidence"]:
            raise ValueError("Passing criterion lacks evidence")
    for finding in result["findings"]:
        if not isinstance(finding, dict) or set(finding) != {"severity", "location", "description"} or finding["severity"] not in {"blocking", "advisory"}:
            raise ValueError("Malformed review finding")
    if result["outcome"] == "pass" and (result["blockers"] or any(c["status"] != "pass" for c in criteria)
            or any(f["severity"] == "blocking" for f in result["findings"])):
        raise ValueError("Passing result contradicts criteria/findings/blockers")
    if SECRET.search(str(result)):
        raise ValueError("Potential secret in agent result")
    return result
