"""Operator entry point. No command executes agents without --execute."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tomllib
from pathlib import Path

from .amendment import adopt
from .catalog import Catalog, digest
from .controller import Controller, external_evidence, load_policy
from .github import GitHub
from .process import command, git
from .safety import SECRET
from .state import State


def validate(root):
    catalog, policy = Catalog(root), load_policy(root)
    for role in ["orchestrator", "implementer", "reviewer", "validator", "security", "pr-manager", "project-manager"]:
        config = tomllib.loads((root / ".codex/agents" / (role + ".toml")).read_text(encoding="utf-8"))
        if not all(config.get(k) for k in ("name", "description", "developer_instructions")):
            raise ValueError("Incomplete custom agent: " + role)
    custom = tomllib.loads((root / ".codex/config.toml").read_text(encoding="utf-8"))
    if custom["agents"]["max_concurrent_threads_per_session"] > 3:
        raise ValueError("Unexpected agent concurrency")
    return {"tasks": len(catalog.tasks), "criteria": sum(len(t["acceptance"]) for t in catalog.tasks.values()),
            "catalog": catalog.fingerprint, "policy": digest(policy), "merge_method": "squash"}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Meta v2 milestone controller; squash-only integration; final human gate")
    parser.add_argument("--root", type=Path, default=Path.cwd())
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("validate", help="Validate catalog, policy and agent definitions without network/model calls")
    doctor = sub.add_parser("doctor", help="Check local prerequisites; --online checks GitHub access read-only")
    doctor.add_argument("--online", action="store_true")
    for name in ("plan", "status", "report", "run", "resume", "unblock", "account-usage", "finalize", "amend-baseline"):
        part = sub.add_parser(name)
        part.add_argument("milestone", choices=[f"M{i}" for i in range(1, 7)])
        if name in {"run", "resume"}:
            part.add_argument("--execute", action="store_true", help="Authorize agents, task branches and PR creation")
            part.add_argument("--merge-packages", action="store_true", help="Authorize squash into milestone branch after checks; never develop")
            part.add_argument("--once", action="store_true", help="One scheduler tick then checkpoint")
            part.add_argument("--max-seconds", type=int)
            part.add_argument("--no-token-limit", action="store_true",
                              help="Disable cumulative token ceiling for this invocation; preserve usage accounting")
            part.add_argument("--model", default="gpt-6-luna", help="Exact Codex model; no automatic fallback")
            part.add_argument("--reasoning-effort", default="xhigh",
                              choices=["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
        if name == "unblock":
            part.add_argument("--issue", required=True, help="Catalog key such as M1.01")
            part.add_argument("--reason", required=True)
            part.add_argument("--context-file", type=Path, help="Sanitized operator context passed to agents; not external evidence")
            part.add_argument("--reset-attempts", action="store_true", help="Explicit operator approval for a new bounded attempt budget")
        if name == "account-usage":
            part.add_argument("--tokens", type=int, required=True, help="Conservative additional usage for interrupted turn")
            part.add_argument("--reason", required=True)
        if name == "amend-baseline":
            part.add_argument("--execute", action="store_true")
            part.add_argument("--reason", required=True)
        if name == "finalize":
            part.add_argument("--execute", action="store_true", help="After verifying final squash merge, close only this milestone's issues")
    args = parser.parse_args(argv)
    root = args.root.resolve()
    if args.command == "validate":
        print(json.dumps(validate(root), indent=2))
        return 0
    if args.command == "doctor":
        result = {"python": sys.version.split()[0], "tools": {x: bool(shutil.which(x)) for x in ("git", "codex", "gh", "npm")},
                  "configuration": validate(root), "authentication": "not checked"}
        if args.online:
            result["develop"] = GitHub(root).branch_sha("develop")
            policy = load_policy(root)
            project = policy["project"]
            result["project_status_options"] = GitHub(root).project_statuses(project_number=project["number"], owner=project["owner"])
            required = set(project["statuses"].values())
            result["missing_status_options"] = sorted(required - set(result["project_status_options"]))
            command(["codex", "login", "status"], root, timeout=30, sanitized=True)
            result["authentication"] = "GitHub read access and saved Codex login verified; write permissions still require operator setup"
        print(json.dumps(result, indent=2))
        return 0 if all(result["tools"].values()) and not result.get("missing_status_options") else 2
    catalog = Catalog(root)
    if args.command == "plan" or (args.command in {"run", "resume"} and not args.execute):
        print(json.dumps({"mode": "dry-run", "milestone": args.milestone,
                          "waves": [wave for full in catalog.waves() if (wave := [k for k in full if k.startswith(args.milestone + ".")])],
                          "scope": load_policy(root)["allowed_paths"][args.milestone],
                          "external_evidence_required": [k for k, t in catalog.milestone(args.milestone).items() if t.get("external")],
                          "merge": "squash", "final_gate": "human",
                          **({"runtime": {"model": args.model, "reasoning_effort": args.reasoning_effort,
                                          "no_token_limit": args.no_token_limit}}
                             if args.command in {"run", "resume"} else {})}, indent=2))
        return 0
    state = State(root / ".orchestrator")
    try:
        if args.command == "amend-baseline":
            if not args.execute:
                print("Dry run: only M1.01 discovery scope changes; migration gates remain")
            else:
                with state.lock():
                    record = adopt(root, state, catalog, load_policy(root), args.milestone, args.reason)
                    print(json.dumps(record, indent=2))
        elif args.command in {"status", "report"}:
            controller = Controller(root, state)
            report = controller.report(args.milestone)
            if args.command == "report":
                target = state.directory / "reports" / (args.milestone + ".md")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(report, encoding="utf-8", newline="\n")
            print(report)
        elif args.command == "unblock":
            if args.issue not in catalog.milestone(args.milestone):
                raise ValueError("Issue does not belong to requested milestone")
            with state.lock():
                if state.task(args.issue)["status"] != "blocked":
                    raise ValueError("Only a blocked issue can be explicitly unblocked")
                details = {}
                if args.context_file:
                    if args.context_file.stat().st_size > 20000:
                        raise ValueError("Operator context exceeds 20000 bytes")
                    note = args.context_file.read_text(encoding="utf-8")
                    if not note.strip() or SECRET.search(note):
                        raise ValueError("Operator context is empty or contains a potential credential")
                    details["operator_context"] = {"text": note,
                        "sha256": hashlib.sha256(note.encode("utf-8")).hexdigest()}
                state.save(args.issue, "retry", reason=args.reason, **details,
                           **({"attempt": 0} if args.reset_attempts else {}))
                state.event(args.milestone, "operator_unblocked", task=args.issue, reason=args.reason,
                            attempt_budget_reset=args.reset_attempts,
                            context_sha256=details.get("operator_context", {}).get("sha256"))
                print("Unblocked; previous evidence and audit history are preserved")
        elif args.command == "account-usage":
            with state.lock():
                run = state.run(args.milestone)
                if not run or run["status"] != "usage_unknown" or args.tokens < 0:
                    raise ValueError("No interrupted usage to reconcile or negative token count")
                state.update_run(args.milestone, tokens=run["tokens"] + args.tokens, status="paused")
                state.event(args.milestone, "usage_reconciled", tokens=args.tokens, reason=args.reason)
                print("Recorded; use resume to continue within the remaining budget")
        elif args.command == "finalize":
            if not args.execute:
                print("Dry run: finalize --execute verifies the final merged squash before closing issues")
            else:
                Controller(root, state).finalize(args.milestone)
                print("Verified final squash and synchronized issue completion")
        else:
            if args.max_seconds is not None and args.max_seconds <= 0:
                raise ValueError("max-seconds must be positive")
            if args.command == "resume":
                with state.lock():
                    (state.directory / "PAUSE").unlink(missing_ok=True)
            Controller(root, state, no_token_limit=args.no_token_limit,
                       model=args.model, reasoning_effort=args.reasoning_effort).run(
                                        args.milestone, merge_packages=args.merge_packages, once=args.once,
                                        max_seconds=args.max_seconds)
            print(Controller(root, state).report(args.milestone))
    finally:
        state.close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, ValueError, OSError, TimeoutError) as exc:
        print("Controller stopped: " + str(exc), file=sys.stderr)
        raise SystemExit(2)
