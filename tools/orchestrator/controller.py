"""Bounded execution, independent review, squash integration and final human gate."""
from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path

from .agents import Codex
from .catalog import Catalog, REPOSITORY, digest
from .github import GitHub, GitHubError, MergeBlocked
from .process import command, git, ProcessError, ProcessTimeout
from .safety import check_paths, check_result, SECRET
from .state import State


class ValidationFailure(RuntimeError):
    def __init__(self, argv, output):
        super().__init__("Validation failed: " + argv[0])
        # Local feedback only, bounded and redacted; never published as raw logs.
        self.feedback = {"argv": argv, "output": re.sub(r"(?i)(access_token|authorization|password|secret)\s*[:=]\s*\S+",
                            r"\1=[REDACTED]", SECRET.sub("[REDACTED]", output))[-20000:]}


def load_policy(root: Path) -> dict:
    policy = json.loads((root / "execution/config.json").read_text(encoding="utf-8"))
    if policy.get("version") != 1 or policy.get("repository") != REPOSITORY or policy.get("base_branch") != "develop":
        raise ValueError("Unsupported or cross-repository execution policy")
    if policy.get("integration_prefix") != "automation/milestone-":
        raise ValueError("Unexpected integration branch prefix")
    if not policy.get("required_checks") or not all(isinstance(x, str) and x for x in policy["required_checks"]):
        raise ValueError("Required named CI checks cannot be empty")
    for name in ("max_attempts", "max_seconds", "agent_timeout_seconds", "max_total_tokens"):
        if type(policy.get(name)) is not int or policy[name] <= 0:
            raise ValueError("Budget must be a positive integer: " + name)
    if set(policy.get("review_roles", [])) != {"reviewer", "validator", "security"}:
        raise ValueError("All independent review roles are required")
    if not policy.get("validation_commands") or any(not isinstance(c, list) or not c or
            not all(isinstance(v, str) and v and "\x00" not in v for v in c) for c in policy["validation_commands"]):
        raise ValueError("Validation commands must be nonempty argv arrays")
    if set(policy.get("allowed_paths", {})) != {f"M{i}" for i in range(1, 7)}:
        raise ValueError("Every milestone requires an explicit scope")
    if any(not isinstance(paths, list) or not paths or not all(isinstance(p, str) and p for p in paths)
           for paths in policy["allowed_paths"].values()):
        raise ValueError("Every milestone scope must contain explicit path patterns")
    project = policy.get("project", {})
    if (type(project.get("enabled")) is not bool or project.get("owner") != "costaapps"
            or type(project.get("number")) is not int or project["number"] <= 0
            or set(project.get("statuses", {})) != {"pending", "running", "blocked", "pr_pending", "accepted", "done"}
            or not all(isinstance(s, str) and s for s in project["statuses"].values())):
        raise ValueError("Project configuration must use explicit existing Status options")
    return policy


def external_evidence(directory: Path, task: dict) -> dict | None:
    path = directory / "inputs" / (task["key"] + ".json")
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("task") != task["key"] or not data.get("verified_by") or not data.get("references"):
        raise ValueError("External evidence record needs task, verified_by and references")
    for ref in data["references"]:
        file = (directory / "inputs" / ref["path"]).resolve()
        if not file.is_relative_to((directory / "inputs").resolve()) or not file.is_file():
            raise ValueError("External evidence reference is missing or outside inputs")
        if hashlib.sha256(file.read_bytes()).hexdigest() != ref["sha256"]:
            raise ValueError("External evidence fingerprint changed")
        if SECRET.search(file.read_text(errors="replace", encoding="utf-8")):
            raise ValueError("Potential secret in external evidence; sanitize before execution")
    # Supply scoped, sanitized contents: the agent's worktree sandbox cannot read controller inputs.
    data["documents"] = []
    for ref in data["references"]:
        file = directory / "inputs" / ref["path"]
        if file.stat().st_size > 200_000:
            raise ValueError("External evidence document exceeds context budget; provide a sanitized extract")
        data["documents"].append({"path": ref["path"], "sha256": ref["sha256"], "text": file.read_text(encoding="utf-8")})
    return data


class Controller:
    def __init__(self, root: Path, state: State, *, github=None, agent=None, no_token_limit=False,
                 model="gpt-6.1-luna", reasoning_effort="xhigh"):
        self.root, self.state = root, state
        self.catalog, self.policy = Catalog(root), load_policy(root)
        self.github = github or GitHub(root)
        self.no_token_limit = no_token_limit
        self.model, self.reasoning_effort = model, reasoning_effort
        self.agent = agent or Codex(root, state.directory / "agents", self.policy["agent_timeout_seconds"],
                                    model=model, reasoning_effort=reasoning_effort)
        self.deadline = float("inf")

    def remaining(self):
        remaining = int(self.deadline - time.monotonic())
        if remaining <= 0:
            raise TimeoutError("Invocation wall-time budget reached; resume from checkpoint")
        return remaining

    def preflight(self, milestone):
        self.catalog.milestone(milestone)
        if git(self.root, "status", "--porcelain"):
            raise RuntimeError("Controller checkout must be clean before execution")
        origin = git(self.root, "remote", "get-url", "origin")
        if origin not in {f"https://github.com/{REPOSITORY}.git", f"git@github.com:{REPOSITORY}.git", f"https://github.com/{REPOSITORY}"}:
            raise RuntimeError("Unexpected git origin")
        sha = self.github.branch_sha("develop")
        if git(self.root, "rev-parse", "HEAD") != sha:
            raise RuntimeError("Controller checkout must match the current develop commit")
        branch = "automation/milestone-" + milestone.lower()
        previous = self.state.run(milestone)
        if previous and previous["develop_sha"] != sha:
            raise RuntimeError("develop moved: human reconciliation and fresh validation required")
        if previous and previous["status"] == "usage_unknown":
            raise RuntimeError("Unknown token consumption; account-usage before resuming")
        if previous:
            self.state.start(milestone, self.catalog.fingerprint, digest(self.policy), sha, previous["integration_sha"])
        for task in self.catalog.milestone(milestone).values():
            for dependency in task["deps"]:
                if dependency[:2] != milestone:
                    record = self.state.task(dependency)
                    if record["status"] != "done" or not record["data"].get("final_merge_sha"):
                        raise RuntimeError("Prior milestone requires its verified human gate: " + dependency)
        expected_integration = previous["integration_sha"] if previous else sha
        if previous:
            actual = self.github.branch_sha(branch)
            if actual != expected_integration:
                # A squash may have succeeded just before the controller crashed. Only a
                # previously reviewed pending PR can account for this branch movement.
                pending = [k for k in self.catalog.milestone(milestone) if self.state.task(k)["status"] == "pr_pending"]
                for key in pending:
                    self.poll_pr(key, branch, False)
                expected_integration = self.state.run(milestone)["integration_sha"]
                if actual != expected_integration:
                    raise RuntimeError("Integration branch changed outside a verified pending squash")
        self.github.ensure_branch(branch, expected_integration)
        integration = self.github.branch_sha(branch)
        self.state.start(milestone, self.catalog.fingerprint, digest(self.policy), sha, integration)
        # Local git must be able to read the exact remote commit, never a guessed ref.
        self.fetch("develop", branch)
        for task in self.catalog.milestone(milestone).values():
            for dependency in task["deps"]:
                if dependency[:2] != milestone:
                    git(self.root, "merge-base", "--is-ancestor", self.state.task(dependency)["data"]["final_merge_sha"], sha)
        for key, task in self.catalog.tasks.items():
            record = self.state.task(key)
            if record["status"] == "accepted" and key[:2] == milestone:
                git(self.root, "merge-base", "--is-ancestor", record["data"]["merge_sha"], integration)
                if task.get("external") and digest(external_evidence(self.state.directory, task)) != record["data"].get("external_hash"):
                    raise RuntimeError("Accepted external evidence changed; reconcile before downstream execution")
        return branch

    def fetch(self, *branches):
        # Explicit tracking refspecs also support single-branch clone configurations.
        git(self.root, "fetch", "origin", *[f"+refs/heads/{b}:refs/remotes/origin/{b}" for b in branches])

    def sync(self, key, status):
        config = self.policy["project"]
        item = self.state.task(key)
        success = True
        try:
            self.github.sync_issue_comment(self.catalog.tasks[key]["issue"], "execution-" + key,
                f"Execution state: **{status}**\n\nAttempt: {item['attempt']}\n\n"
                f"Reviewed commit: `{item['data'].get('revision', 'pending')}`\n\n"
                f"PR: {item['data'].get('url', 'pending')}\n\n"
                "Accepted packages remain open until the final human squash into develop is verified.")
        except GitHubError:
            success = False
            self.state.event(key[:2], "issue_sync_pending", task=key, desired_status=status)
        if not config.get("enabled"):
            if success:
                self.state.complete_sync(key)
            else:
                self.state.queue_sync(key, status)
            return
        try:
            self.github.sync_project(self.catalog.tasks[key]["issue"], config["statuses"].get(status, config["statuses"]["running"]),
                                     project_number=config["number"], owner=config["owner"])
        except GitHubError:
            success = False
            # GitHub unavailable does not invalidate already-built work; visible durable retry record.
            self.state.event(key[:2], "project_sync_pending", task=key, desired_status=status)
        if success:
            self.state.complete_sync(key)
        else:
            self.state.queue_sync(key, status)

    def changed_paths(self, worktree, base="HEAD"):
        # Include tracked removals, both sides of renames, and untracked deliverables.
        tracked = command(["git", "diff", "--name-only", "--no-renames", base, "-z"], worktree)
        others = command(["git", "ls-files", "--others", "--exclude-standard", "-z"], worktree)
        return sorted(set(x for x in (tracked + others).split("\0") if x))

    def agent_run(self, task, role, worktree, revision, context):
        self.agent.timeout = min(self.policy["agent_timeout_seconds"], self.remaining())
        run = self.state.run(task["key"][:2])
        if not self.no_token_limit and run["tokens"] >= self.policy["max_total_tokens"]:
            raise TimeoutError("Cumulative token budget reached")
        try:
            result = self.agent.run(task, role, worktree, revision, context)
            check_result(result, task, revision, role)
        finally:
            usage = getattr(self.agent, "tokens", None)
            tokens = run["tokens"] + max(0, int(usage or 0))
            self.state.update_run(task["key"][:2], tokens=tokens,
                                  **({"status": "usage_unknown"} if usage is None else {}))
            self.state.event(task["key"][:2], "agent_usage", task=task["key"], role=role,
                             revision=revision, sessions=getattr(self.agent, "sessions", []), tokens=tokens,
                             known=usage is not None)
        if usage is None:
            raise TimeoutError("Usage unavailable; account-usage required before another agent turn")
        if not self.no_token_limit and tokens > self.policy["max_total_tokens"]:
            raise TimeoutError("Cumulative token budget exceeded after current turn")
        return result

    def validate_candidate(self, worktree, revision):
        checks = []
        for argv in self.policy["validation_commands"]:
            try:
                command(argv, worktree, min(self.remaining(), self.policy["agent_timeout_seconds"]), sanitized=True)
            except ProcessTimeout:
                raise
            except ProcessError as exc:
                raise ValidationFailure(argv, exc.output + "\n" + exc.stderr) from None
            checks.append({"argv": argv, "status": "passed", "revision": revision})
        if git(worktree, "status", "--porcelain"):
            raise RuntimeError("Validation changed tracked/untracked deliverables; reconcile and rerun")
        return checks

    def execute_task(self, task, branch):
        key = task["key"]
        old = self.state.task(key)
        if old["attempt"] >= self.policy["max_attempts"]:
            self.state.save(key, "blocked", reason="Attempt budget exhausted")
            self.sync(key, "blocked")
            return
        # Fetch the latest accepted integration before creating this task's worktree.
        base = self.github.branch_sha(branch)
        self.fetch(branch)
        head_branch = "codex/" + key.lower().replace(".", "-")
        worktree = self.state.directory / "worktrees" / key
        if not worktree.exists():
            worktree.parent.mkdir(parents=True, exist_ok=True)
            git(self.root, "worktree", "add", "-b", head_branch, str(worktree), base)
        else:
            if git(worktree, "branch", "--show-current") != head_branch:
                raise RuntimeError("Worktree branch changed unexpectedly")
            if old["data"].get("base") != base:
                self.state.save(key, "blocked", reason="Integration moved; preserve worktree for reconciliation")
                return
        attempt = old["attempt"] + 1
        self.state.save(key, "running", attempt=attempt, base=base, branch=head_branch, worktree=str(worktree))
        self.sync(key, "running")
        context = {"allowed_paths": self.policy["allowed_paths"][key[:2]], "base": base,
                   "dependencies": {d: self.state.task(d)["data"] for d in task["deps"]},
                   "external_evidence": external_evidence(self.state.directory, task),
                   "previous_attempt": old["data"].get("feedback"), "protected_controls": "No automation/instruction/workflow changes"}
        initial_head = git(worktree, "rev-parse", "HEAD")
        result = self.agent_run(task, "implementer", worktree, initial_head, context)
        if git(worktree, "rev-parse", "HEAD") != initial_head:
            raise RuntimeError("Implementer changed git history; manual reconciliation required")
        if result["outcome"] != "pass":
            self.state.save(key, "blocked" if result["outcome"] == "blocked" else "retry", feedback=result)
            self.sync(key, "blocked")
            return
        if task.get("external") and not context["external_evidence"]:
            self.state.save(key, "blocked", reason="External evidence attestation missing", feedback=result)
            self.sync(key, "blocked")
            return
        paths = self.changed_paths(worktree, base)
        check_paths(paths, self.policy["allowed_paths"][key[:2]], worktree)
        pending = self.changed_paths(worktree)
        if pending:
            git(worktree, "add", "-A", "--", *pending)
            git(worktree, "-c", "user.name=Meta automation", "-c", "user.email=automation@users.noreply.github.com",
                "commit", "-m", f"feat({key.lower()}): implement work package")
        revision = git(worktree, "rev-parse", "HEAD")
        if revision == base:
            raise RuntimeError("No candidate commit to review")
        checks = self.validate_candidate(worktree, revision)
        self.state.save(key, "reviewing", revision=revision, checks=checks)
        review_context = dict(context, diff_base=base, validation=checks,
                              instruction="Inspect the actual diff and all criteria independently; do not rely on implementer summary")
        reviews = []
        for role in self.policy["review_roles"]:
            reviews.append(self.agent_run(task, role, worktree, revision, review_context))
            if git(worktree, "rev-parse", "HEAD") != revision or git(worktree, "status", "--porcelain"):
                raise RuntimeError("Review changed the pinned checkout")
        if any(r["outcome"] != "pass" for r in reviews):
            self.state.save(key, "retry", feedback=reviews)
            return
        git(worktree, "push", "origin", head_branch)
        body = (f"Refs #{task['issue']}\n\nAutomated package {key}; final issue closure only after milestone approval.\n\n"
                f"Base: `{base}`\nReviewed head: `{revision}`\nMerge policy: **squash only**.\n\n"
                f"All {len(task['acceptance'])} criteria reviewed by reviewer, validator and security. "
                "Evidence remains in the execution report and committed deliverables. CI must pass on this head.")
        pr = self.github.ensure_pr(head_branch, branch, task["title"], body)
        self.state.save(key, "pr_pending", pr=pr["number"], url=pr["url"], revision=revision, reviews=reviews,
                        external_hash=digest(context["external_evidence"]))
        self.sync(key, "pr_pending")

    def poll_pr(self, key, branch, merge_packages):
        record = self.state.task(key)
        data = record["data"]
        task = self.catalog.tasks[key]
        if task.get("external") and digest(external_evidence(self.state.directory, task)) != data.get("external_hash"):
            self.state.save(key, "blocked", reason="External evidence changed before integration; fresh review required")
            return
        pr = self.github.inspect_pr(data["pr"])
        if pr["head_sha"] != data["revision"] or pr["base"] != branch:
            self.state.save(key, "blocked", reason="PR changed after review")
            return
        if not pr.get("merged") and any(c.get("state") == "failure" for c in pr.get("checks", {}).values()):
            self.state.save(key, "retry", feedback={"ci": pr["checks"], "revision": data["revision"]},
                            reason="CI failed; repair the reviewed candidate and rerun all gates")
            return
        if pr.get("merged"):
            # Recovery after an interrupted merge response must verify squash topology too.
            verified = self.github.merge_squash(data["pr"], data["revision"], data["base"], self.policy["required_checks"])
            merge_sha = verified["sha"]
        elif not merge_packages:
            return
        else:
            try:
                merged = self.github.merge_squash(data["pr"], data["revision"], data["base"], self.policy["required_checks"])
            except MergeBlocked:
                return
            merge_sha = merged.get("sha") or merged.get("merge_commit_sha")
        if not merge_sha:
            raise RuntimeError("Cannot accept an unverified integration")
        self.fetch(branch)
        git(self.root, "merge-base", "--is-ancestor", merge_sha, "origin/" + branch)
        if git(self.root, "rev-parse", merge_sha + "^{tree}") != git(self.root, "rev-parse", data["revision"] + "^{tree}"):
            raise RuntimeError("Squash tree differs from reviewed candidate")
        self.state.save(key, "accepted", merge_sha=merge_sha)
        self.state.update_run(key[:2], integration_sha=merge_sha)
        self.sync(key, "accepted")

    def final_gate(self, milestone, branch):
        run = self.state.run(milestone)
        if run["status"] == "awaiting_human" and run["final_pr"]:
            return self.github.inspect_pr(run["final_pr"])
        if self.github.branch_sha("develop") != run["develop_sha"]:
            raise RuntimeError("develop moved; final gate requires reconciliation")
        head = self.github.branch_sha(branch)
        if head != run["integration_sha"]:
            raise RuntimeError("Integration changed before aggregate review")
        evidence = {}
        for key, task in self.catalog.milestone(milestone).items():
            if task.get("external"):
                current = external_evidence(self.state.directory, task)
                if digest(current) != self.state.task(key)["data"].get("external_hash"):
                    raise RuntimeError("External evidence changed before aggregate review")
                evidence[key] = current
        self.fetch(branch)
        worktree = self.state.directory / "gates" / milestone
        if worktree.exists():
            if git(worktree, "rev-parse", "HEAD") != head or git(worktree, "status", "--porcelain"):
                raise RuntimeError("Aggregate worktree requires manual reconciliation")
        else:
            worktree.parent.mkdir(parents=True, exist_ok=True)
            git(self.root, "worktree", "add", "--detach", str(worktree), head)
        checks = self.validate_candidate(worktree, head)
        gate = {"key": milestone, "title": milestone + " aggregate gate", "acceptance": [
            "Every work package has independent criterion evidence and a verified squash integration.",
            "The consolidated tree satisfies the milestone epic without unresolved blocking findings.",
            "Contracts, implementation and documentation agree; external evidence is genuine and sufficient.",
            "Required validation passed on the consolidated tree; no production changes were performed.",
            "Remaining limitations and human decisions are explicit in the handoff."]}
        reviews = [self.agent_run(gate, role, worktree, head,
                    {"base": run["develop_sha"], "validation": checks,
                     "epic": self.catalog.epics[milestone], "external_evidence": evidence,
                     "packages": [self.state.task(k) for k in self.catalog.milestone(milestone)]})
                   for role in self.policy["review_roles"]]
        if any(r["outcome"] != "pass" for r in reviews):
            self.state.update_run(milestone, status="gate_blocked")
            self.state.event(milestone, "aggregate_review_blocked", reviews=reviews)
            raise RuntimeError("Aggregate milestone review found blockers; reconcile before final PR")
        if git(worktree, "status", "--porcelain") or git(worktree, "rev-parse", "HEAD") != head:
            raise RuntimeError("Aggregate review changed the pinned checkout")
        report = self.report(milestone)
        report_path = self.state.directory / "reports" / (milestone + ".md")
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(report, encoding="utf-8", newline="\n")
        # Keep the PR bounded. Persist the complete human evidence report in
        # idempotent comments on the milestone epic as well as the local checkpoint.
        chunks = [report[i:i + 40000] for i in range(0, len(report), 40000)]
        for index, chunk in enumerate(chunks, 1):
            self.github.sync_issue_comment(self.catalog.epics[milestone], f"{milestone}-evidence-{index}",
                                           f"Milestone evidence {index}/{len(chunks)}; head `{head}`\n\n" + chunk)
        summary = "\n".join(report.splitlines()[:4 + len(self.catalog.milestone(milestone))])
        pr = self.github.ensure_pr(branch, "develop", f"{milestone}: entrega consolidada para aceite humano",
                                   summary + f"\n\nFull criterion/review evidence: https://github.com/{REPOSITORY}/issues/{self.catalog.epics[milestone]} "
                                   f"(controller comments {milestone}-evidence-*).\n\n"
                                   f"Aggregate reviewer/validator/security passed on `{head}`.\n\n"
                                   "Human gate: review all evidence; merge using **squash**. "
                                   "Do not close issues until this PR is merged. No production deployment is authorized by this PR.")
        self.state.update_run(milestone, status="awaiting_human", final_pr=pr["number"], final_head=pr["head_sha"])
        self.state.event(milestone, "human_gate", pr=pr["number"], url=pr["url"], revision=pr["head_sha"])
        return pr

    def finalize(self, milestone):
        """Close scoped issues only after a human merged the exact final tree via squash."""
        with self.state.lock():
            run = self.state.run(milestone)
            if not run or not run.get("final_pr") or not run.get("final_head"):
                raise RuntimeError("No final human gate recorded")
            pr = self.github.inspect_pr(run["final_pr"])
            branch = "automation/milestone-" + milestone.lower()
            if not (pr.get("merged") and pr["base"] == "develop" and pr["head"] == branch
                    and pr["head_sha"] == run["final_head"] and pr.get("merge_commit_sha")):
                raise RuntimeError("Final PR is not the reviewed, human-merged milestone")
            # Final squash commonly deletes the integration branch. Its objects are
            # already pinned locally; fetch the permanent PR head ref only if needed.
            self.fetch("develop")
            try:
                git(self.root, "cat-file", "-e", run["final_head"] + "^{commit}")
            except RuntimeError:
                git(self.root, "fetch", "origin", f"pull/{run['final_pr']}/head")
            sha = pr["merge_commit_sha"]
            parents = git(self.root, "rev-list", "--parents", "-n", "1", sha).split()
            if len(parents) != 2 or parents[1] != run["develop_sha"]:
                raise RuntimeError("Final merge must be squash on the reviewed develop base")
            if git(self.root, "rev-parse", sha + "^{tree}") != git(self.root, "rev-parse", run["final_head"] + "^{tree}"):
                raise RuntimeError("Final squash tree differs from the reviewed milestone")
            git(self.root, "merge-base", "--is-ancestor", sha, "origin/develop")
            for key in self.catalog.milestone(milestone):
                record = self.state.task(key)
                if record["status"] not in {"accepted", "done"}:
                    raise RuntimeError("Milestone contains an unaccepted package")
            for key, task in self.catalog.milestone(milestone).items():
                self.github.close_issue(task["issue"])
                self.state.save(key, "done", final_merge_sha=sha)
                self.sync(key, "done")
            self.github.close_issue(self.catalog.epics[milestone])
            self.state.update_run(milestone, status="done")
            self.state.event(milestone, "human_gate_verified", sha=sha)

    def run(self, milestone, *, merge_packages=False, once=False, max_seconds=None):
        self.deadline = time.monotonic() + min(max_seconds or self.policy["max_seconds"], self.policy["max_seconds"])
        with self.state.lock():
            branch = self.preflight(milestone)
            self.state.event(milestone, "runtime_settings", model=self.model,
                             reasoning_effort=self.reasoning_effort, no_token_limit=self.no_token_limit)
            while self.remaining():
                if self.state.run(milestone)["status"] == "usage_unknown":
                    raise RuntimeError("Usage unavailable; account-usage required")
                if (self.state.directory / "PAUSE").exists():
                    self.state.update_run(milestone, status="paused")
                    return
                if self.github.branch_sha("develop") != self.state.run(milestone)["develop_sha"]:
                    raise RuntimeError("develop moved; stop before further integration")
                for key, desired in self.state.pending_sync().items():
                    if key.startswith(milestone + "."):
                        self.sync(key, desired)
                for key in self.catalog.milestone(milestone):
                    status = self.state.task(key)["status"]
                    if status in {"running", "reviewing"}:
                        # Interrupted work is retried on the preserved branch, never silently accepted.
                        self.state.save(key, "retry", reason="Recovered interrupted attempt; review/checks must rerun")
                    elif status == "pr_pending":
                        self.poll_pr(key, branch, merge_packages)
                states = self.state.states()
                if all(states.get(k) in {"accepted", "done"} for k in self.catalog.milestone(milestone)):
                    self.final_gate(milestone, branch)
                    return
                pending_prs = any(self.state.task(k)["status"] == "pr_pending" for k in self.catalog.milestone(milestone))
                # One writer/integration lane; reviews use independent read-only processes.
                ready = [] if pending_prs else self.catalog.ready(milestone, states)
                if ready:
                    key = ready[0]
                    try:
                        self.execute_task(self.catalog.tasks[key], branch)
                    except ValidationFailure as exc:
                        self.state.save(key, "retry", feedback=exc.feedback, reason=str(exc))
                        self.sync(key, "running")
                    except (TimeoutError, KeyboardInterrupt):
                        self.state.event(milestone, "checkpoint", reason="Time budget/interruption")
                        raise
                    except (ValueError, RuntimeError) as exc:
                        self.state.save(key, "blocked", reason=str(exc))
                        self.sync(key, "blocked")
                if once:
                    return
                pending_prs = any(self.state.task(k)["status"] == "pr_pending" for k in self.catalog.milestone(milestone))
                if not ready and not pending_prs:
                    self.state.update_run(milestone, status="blocked")
                    return
                if not ready:
                    time.sleep(min(15, self.remaining()))

    def report(self, milestone):
        lines = [f"# {milestone} execution report", "", "| Package | Status | Attempt | PR | Revision |", "|---|---|---:|---|---|"]
        for key in self.catalog.milestone(milestone):
            row = self.state.task(key)
            d = row["data"]
            lines.append(f"| {key} | {row['status']} | {row['attempt']} | {d.get('url', '')} | {d.get('revision', '')} |")
            if d.get("reason") and row["status"] in {"blocked", "retry"}:
                lines.append(f"\n{key}: {d['reason']}\n")
        for key in self.catalog.milestone(milestone):
            record = self.state.task(key)
            data = record["data"]
            if not data.get("reviews"):
                continue
            lines.extend(["", f"## {key} evidence", "",
                          f"Integration: `{data.get('merge_sha', 'pending')}`; reviewed candidate: `{data.get('revision', 'pending')}`."])
            for check in data.get("checks", []):
                lines.append("- Check: `" + " ".join(check["argv"]) + "` — " + check["status"])
            for review in data["reviews"]:
                lines.append(f"\n{review['role']}: {review['outcome']}\n")
                for criterion in review["criteria"]:
                    lines.append(f"- AC{criterion['index']}: {criterion['status']}; " + "; ".join(criterion["evidence"]))
                for finding in review["findings"]:
                    lines.append(f"- {finding['severity']}: {finding['location']} — {finding['description']}")
        lines.extend(["", "Accepted means integrated in the milestone branch, not delivered to develop.",
                      "External evidence, tests and review records are bound to the recorded commits."])
        pending = {k: v for k, v in self.state.pending_sync().items() if k.startswith(milestone + ".")}
        if pending:
            lines.extend(["", "GitHub synchronization pending (durable retry queue): " + json.dumps(pending)])
        return SECRET.sub("[REDACTED]", "\n".join(lines))
