"""Full controller contract against isolated real Git and fake remote/model APIs."""
from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.orchestrator.catalog import REPOSITORY
from tools.orchestrator.controller import Controller, external_evidence
from tools.orchestrator.process import git
from tools.orchestrator.state import State

SOURCE_ROOT = Path(__file__).resolve().parents[3]


class FakeGitHub:
    """Local bare Git refs model the API, including an actual squash commit."""
    def __init__(self, remote):
        self.remote = remote
        self.prs = {}
        self.merge_calls = []
        self.comments = []
        self.closed = []
        self.lose_merge_response = False

    def branch_sha(self, branch):
        return git(self.remote, "rev-parse", "refs/heads/" + branch)

    def ensure_branch(self, branch, sha):
        refs = git(self.remote, "for-each-ref", "--format=%(refname)", "refs/heads/" + branch)
        if refs:
            if self.branch_sha(branch) != sha:
                raise RuntimeError("Existing branch differs from requested SHA")
        else:
            git(self.remote, "update-ref", "refs/heads/" + branch, sha)
        return {"name": branch, "sha": sha}

    def ensure_pr(self, head, base, title, body):
        for record in self.prs.values():
            if record["head"] == head and record["base"] == base:
                return dict(record)
        number = len(self.prs) + 1
        record = {"number": number, "url": f"https://github.com/{REPOSITORY}/pull/{number}",
                  "head": head, "base": base, "head_sha": self.branch_sha(head),
                  "base_sha": self.branch_sha(base), "state": "open", "draft": base == "develop",
                  "merged": False, "mergeable": True, "title": title, "body": body}
        self.prs[number] = record
        return dict(record)

    def inspect_pr(self, number):
        return dict(self.prs[number])

    def merge_squash(self, number, expected_head, expected_base, required_checks):
        record = self.prs[number]
        assert record["base"].startswith("automation/milestone-")
        assert required_checks
        assert record["head_sha"] == expected_head
        if record["merged"]:
            sha = record["merge_commit_sha"]
            parents = git(self.remote, "rev-list", "--parents", "-n", "1", sha).split()
            assert parents == [sha, expected_base]
            assert git(self.remote, "rev-parse", sha + "^{tree}") == git(self.remote, "rev-parse", expected_head + "^{tree}")
            return {"sha": sha, "merged": True, "already_merged": True}
        assert self.branch_sha(record["head"]) == expected_head
        assert self.branch_sha(record["base"]) == expected_base
        tree = git(self.remote, "rev-parse", expected_head + "^{tree}")
        sha = git(self.remote, "-c", "user.name=Test automation", "-c", "user.email=test@example.invalid",
                  "commit-tree", tree, "-p", expected_base, "-m", "Squash package")
        git(self.remote, "update-ref", "refs/heads/" + record["base"], sha, expected_base)
        record.update(merged=True, state="closed", merge_commit_sha=sha)
        self.merge_calls.append({"number": number, "method": "squash", "sha": sha})
        if self.lose_merge_response:
            self.lose_merge_response = False
            raise RuntimeError("Simulated lost merge response")
        return {"sha": sha, "merged": True}

    def human_merge(self, number, *, squash=True):
        """Only test code models the human's final merge; controller never calls it."""
        record = self.prs[number]
        assert record["base"] == "develop"
        head, base = record["head_sha"], record["base_sha"]
        tree = git(self.remote, "rev-parse", head + "^{tree}")
        args = ["-c", "user.name=Human", "-c", "user.email=human@example.invalid",
                "commit-tree", tree, "-p", base]
        if not squash:
            args.extend(["-p", head])
        sha = git(self.remote, *args, "-m", "Human final milestone approval")
        git(self.remote, "update-ref", "refs/heads/develop", sha, base)
        record.update(merged=True, state="closed", draft=False, merge_commit_sha=sha)
        return sha

    def sync_project(self, *args, **kwargs):
        pass

    def sync_issue_comment(self, *args, **kwargs):
        self.comments.append((args, kwargs))

    def close_issue(self, number):
        self.closed.append(number)


class FakeAgent:
    tokens = 10
    sessions = ["test-thread"]

    def __init__(self):
        self.calls = []
        self.outcomes = {}
        self.edit_path = "docs/result.md"
        self.commit_on_implement = False
        self.write_once = False
        self.review_dirty = False

    def run(self, task, role, worktree, revision, context):
        self.calls.append((task["key"], role, revision))
        if role == "implementer":
            destination = worktree / self.edit_path
            destination.parent.mkdir(parents=True, exist_ok=True)
            if not self.write_once or not destination.exists():
                destination.write_text("Verifiable specification and test references.\n")
            if self.commit_on_implement:
                git(worktree, "add", "--", self.edit_path)
                git(worktree, "-c", "user.name=Worker", "-c", "user.email=worker@example.invalid",
                    "commit", "-m", "Worker must not commit")
        elif self.review_dirty:
            (worktree / "docs/reviewer-edit.md").write_text("Unexpected reviewer edit")
        outcomes = self.outcomes.get(role, [])
        outcome = outcomes.pop(0) if outcomes else "pass"
        return {"task": task["key"], "role": role, "revision": revision,
                "outcome": outcome, "summary": "Independent result",
                "criteria": [{"index": i, "status": outcome, "evidence": ["docs/result.md:1"]}
                             for i, _ in enumerate(task["acceptance"], 1)],
                "findings": [] if outcome != "fail" else [
                    {"severity": "blocking", "location": "docs/result.md:1", "description": "Missing scenario"}],
                "blockers": ["Evidence unavailable"] if outcome == "blocked" else []}


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.root = self.directory / "checkout"
        self.remote = self.directory / "origin.git"
        self.root.mkdir()
        git(self.directory, "init", "--bare", str(self.remote))
        git(self.root, "init", "-b", "develop")
        git(self.root, "config", "user.name", "Test")
        git(self.root, "config", "user.email", "test@example.invalid")
        (self.root / ".gitignore").write_text(".orchestrator/\n__pycache__/\n")
        (self.root / ".planning").mkdir()
        (self.root / "execution").mkdir()
        self.task = {"key": "M1.01", "title": "[M1.01] Test deliverable", "deps": [],
                     "acceptance": ["Document the verified behavior"], "external": False,
                     "goal": "Produce a specification", "steps": ["Inspect behavior"], "refs": [],
                     "tests": ["Verify specification"], "contract": "One Markdown file", "risk": "None"}
        manifest = {"repository": REPOSITORY, "items": [{"key": "M1"}, self.task]}
        mapping = {"M1": {"number": 4}, "M1.01": {"number": 10,
                   "url": f"https://github.com/{REPOSITORY}/issues/10"}}
        (self.root / ".planning/manifest.json").write_text(json.dumps(manifest))
        (self.root / ".planning/issues-map.json").write_text(json.dumps(mapping))
        policy = json.loads((SOURCE_ROOT / "execution/config.json").read_text())
        policy["project"]["enabled"] = False
        policy["validation_commands"] = [["python3", "-c", "pass"]]
        policy["max_seconds"] = 30
        (self.root / "execution/config.json").write_text(json.dumps(policy))
        git(self.root, "add", ".")
        git(self.root, "commit", "-m", "Fixture baseline")
        git(self.root, "remote", "add", "origin", str(self.remote))
        git(self.root, "push", "origin", "develop")
        self.state = State(self.root / ".orchestrator")
        self.github = FakeGitHub(self.remote)
        self.agent = FakeAgent()
        self.controller = Controller(self.root, self.state, github=self.github, agent=self.agent)
        real_git = git

        def local_origin(cwd, *args):
            if args == ("remote", "get-url", "origin"):
                return f"https://github.com/{REPOSITORY}.git"
            return real_git(cwd, *args)

        self.patch = patch("tools.orchestrator.controller.git", side_effect=local_origin)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.state.close()
        self.temp.cleanup()

    def tick(self, merge=False):
        self.controller.run("M1", once=True, merge_packages=merge, max_seconds=20)

    def change_manifest_external(self):
        path = self.root / ".planning/manifest.json"
        manifest = json.loads(path.read_text())
        manifest["items"][1]["external"] = True
        path.write_text(json.dumps(manifest))
        git(self.root, "add", ".planning/manifest.json")
        git(self.root, "commit", "-m", "Require external evidence")
        git(self.root, "push", "origin", "develop")
        self.controller = Controller(self.root, self.state, github=self.github, agent=self.agent)

    def test_pipeline_reviews_exact_candidate_and_waits_for_human_final_pr(self):
        original_develop = self.github.branch_sha("develop")
        self.tick()
        task = self.state.task("M1.01")
        self.assertEqual(task["status"], "pr_pending")
        candidate = task["data"]["revision"]
        review_calls = self.agent.calls[1:]
        self.assertEqual({r for _, r, _ in review_calls}, {"reviewer", "validator", "security"})
        self.assertTrue(all(sha == candidate for _, _, sha in review_calls))
        self.assertEqual(self.github.closed, [])
        self.tick(merge=True)
        self.assertEqual(self.state.task("M1.01")["status"], "accepted")
        self.assertEqual(self.state.run("M1")["status"], "awaiting_human")
        self.assertEqual([c["method"] for c in self.github.merge_calls], ["squash"])
        self.assertEqual(self.github.branch_sha("develop"), original_develop)
        final_pr = next(p for p in self.github.prs.values() if p["base"] == "develop")
        self.assertTrue(final_pr["draft"])
        self.assertFalse(final_pr["merged"])
        self.assertEqual(self.github.closed, [])

    def test_pr_is_not_merged_without_explicit_merge_packages(self):
        self.tick()
        self.tick()
        self.assertEqual(self.state.task("M1.01")["status"], "pr_pending")
        self.assertEqual(self.github.merge_calls, [])

    def test_changed_pr_head_blocks_integration(self):
        self.tick()
        self.github.prs[1]["head_sha"] = "a" * 40
        self.tick(merge=True)
        self.assertEqual(self.state.task("M1.01")["status"], "blocked")
        self.assertEqual(self.github.merge_calls, [])

    def test_external_evidence_missing_prevents_pr_even_if_agent_claims_pass(self):
        self.change_manifest_external()
        self.tick()
        self.assertEqual(self.state.task("M1.01")["status"], "blocked")
        self.assertIn("evidence", self.state.task("M1.01")["data"]["reason"].lower())
        self.assertEqual(self.github.prs, {})

    def test_scope_violation_blocks_before_commit_or_push(self):
        self.agent.edit_path = "backend/outside.php"
        self.tick()
        self.assertEqual(self.state.task("M1.01")["status"], "blocked")
        self.assertEqual(self.github.prs, {})

    def test_worker_cannot_create_its_own_git_history(self):
        self.agent.commit_on_implement = True
        self.tick()
        self.assertEqual(self.state.task("M1.01")["status"], "blocked")
        self.assertIn("history", self.state.task("M1.01")["data"]["reason"].lower())
        self.assertEqual(self.github.prs, {})

    def test_validation_failure_blocks_without_opening_pr(self):
        self.controller.policy["validation_commands"] = [["python3", "-c", "raise SystemExit(1)"]]
        self.tick()
        self.assertIn(self.state.task("M1.01")["status"], {"retry", "blocked"})
        self.assertEqual(self.github.prs, {})

    def test_review_failure_does_not_push_or_accept(self):
        self.agent.outcomes["reviewer"] = ["fail"]
        self.tick()
        self.assertEqual(self.state.task("M1.01")["status"], "retry")
        self.assertEqual(self.github.prs, {})
        self.assertEqual(self.github.merge_calls, [])

    def test_retry_revalidates_existing_commit_without_requiring_new_edits(self):
        self.agent.write_once = True
        self.agent.outcomes["reviewer"] = ["fail", "pass"]
        self.tick()
        first = self.state.task("M1.01")
        self.assertEqual(first["status"], "retry")
        candidate = first["data"]["revision"]
        self.tick()
        second = self.state.task("M1.01")
        self.assertEqual(second["status"], "pr_pending")
        self.assertEqual(second["attempt"], 2)
        self.assertEqual(second["data"]["revision"], candidate)

    def test_retry_cannot_smuggle_previously_committed_control_changes(self):
        self.agent.write_once = True
        self.agent.outcomes["reviewer"] = ["fail"]
        self.tick()
        worktree = Path(self.state.task("M1.01")["data"]["worktree"])
        protected = worktree / ".codex/agents/bypass.toml"
        protected.parent.mkdir(parents=True)
        protected.write_text('name="bypass"\n')
        git(worktree, "add", ".codex/agents/bypass.toml")
        git(worktree, "commit", "-m", "Unexpected precommitted control edit")
        self.tick()
        self.assertEqual(self.state.task("M1.01")["status"], "blocked")
        self.assertIn("control", self.state.task("M1.01")["data"]["reason"].lower())
        self.assertEqual(self.github.prs, {})

    def test_validation_cannot_change_the_reviewed_tree(self):
        self.controller.policy["validation_commands"] = [[
            "python3", "-c", "from pathlib import Path; Path('docs/generated.md').write_text('changed')"]]
        self.tick()
        self.assertEqual(self.state.task("M1.01")["status"], "blocked")
        self.assertIn("validation changed", self.state.task("M1.01")["data"]["reason"].lower())
        self.assertEqual(self.github.prs, {})

    def test_resume_after_squash_preserves_acceptance_and_final_pr(self):
        self.tick()
        self.tick(merge=True)
        calls = list(self.agent.calls)
        self.tick(merge=True)
        self.assertEqual(self.agent.calls, calls)
        self.assertEqual(len(self.github.prs), 2)
        self.assertEqual(len(self.github.merge_calls), 1)
        self.assertEqual(self.state.run("M1")["status"], "awaiting_human")

    def test_resume_recovers_lost_squash_response_before_starting_other_work(self):
        self.tick()
        self.github.lose_merge_response = True
        with self.assertRaisesRegex(RuntimeError, "lost merge response"):
            self.tick(merge=True)
        self.assertEqual(self.state.task("M1.01")["status"], "pr_pending")
        self.assertTrue(self.github.prs[1]["merged"])
        self.tick()
        self.assertEqual(self.state.task("M1.01")["status"], "accepted")
        self.assertEqual(len(self.github.merge_calls), 1)
        self.assertEqual(self.state.run("M1")["status"], "awaiting_human")

    def test_final_aggregate_gate_has_three_independent_sha_bound_reviews(self):
        self.tick()
        self.tick(merge=True)
        head = self.state.run("M1")["final_head"]
        gate_calls = [call for call in self.agent.calls if call[0] == "M1"]
        self.assertEqual({role for _, role, _ in gate_calls}, {"reviewer", "validator", "security"})
        self.assertTrue(all(revision == head for _, _, revision in gate_calls))

    def test_final_aggregate_review_failure_keeps_final_pr_closed_to_creation(self):
        self.tick()
        self.agent.outcomes["reviewer"] = ["fail"]
        with self.assertRaisesRegex(RuntimeError, "Aggregate milestone review"):
            self.tick(merge=True)
        self.assertEqual(self.state.run("M1")["status"], "gate_blocked")
        self.assertEqual(len(self.github.prs), 1)
        self.assertEqual(self.github.closed, [])

    def test_finalize_closes_package_and_epic_only_after_human_squash(self):
        self.tick()
        self.tick(merge=True)
        final = self.state.run("M1")["final_pr"]
        self.assertEqual(self.github.closed, [])
        sha = self.github.human_merge(final)
        self.controller.finalize("M1")
        self.assertEqual(self.github.closed, [10, 4])
        self.assertEqual(self.state.task("M1.01")["status"], "done")
        self.assertEqual(self.state.task("M1.01")["data"]["final_merge_sha"], sha)
        self.assertEqual(self.state.run("M1")["status"], "done")

    def test_finalize_rejects_unmerged_human_gate(self):
        self.tick()
        self.tick(merge=True)
        with self.assertRaisesRegex(RuntimeError, "human-merged"):
            self.controller.finalize("M1")
        self.assertEqual(self.github.closed, [])

    def test_finalize_survives_github_deleting_integration_branch(self):
        self.tick()
        self.tick(merge=True)
        self.github.human_merge(self.state.run("M1")["final_pr"])
        git(self.remote, "update-ref", "-d", "refs/heads/automation/milestone-m1")
        self.controller.finalize("M1")
        self.assertEqual(self.state.run("M1")["status"], "done")

    def test_single_branch_clone_configuration_keeps_tracking_integration(self):
        git(self.root, "config", "remote.origin.fetch", "+refs/heads/develop:refs/remotes/origin/develop")
        self.tick()
        self.tick(merge=True)
        self.assertEqual(self.state.task("M1.01")["status"], "accepted")

    def test_fresh_controller_must_run_current_develop_checkout(self):
        git(self.root, "commit", "--allow-empty", "-m", "Local-only unreviewed controller")
        with self.assertRaisesRegex(RuntimeError, "must match the current develop"):
            self.tick()
        self.assertEqual(self.agent.calls, [])

    def test_finalize_rejects_final_merge_commit_instead_of_squash(self):
        self.tick()
        self.tick(merge=True)
        self.github.human_merge(self.state.run("M1")["final_pr"], squash=False)
        with self.assertRaisesRegex(RuntimeError, "must be squash"):
            self.controller.finalize("M1")
        self.assertEqual(self.github.closed, [])

    def test_finalize_rejects_changed_reviewed_final_head(self):
        self.tick()
        self.tick(merge=True)
        number = self.state.run("M1")["final_pr"]
        self.github.human_merge(number)
        self.github.prs[number]["head_sha"] = "f" * 40
        with self.assertRaisesRegex(RuntimeError, "reviewed, human-merged"):
            self.controller.finalize("M1")
        self.assertEqual(self.github.closed, [])

    def test_finalize_checks_all_package_acceptance_before_any_closure(self):
        self.tick()
        self.tick(merge=True)
        self.github.human_merge(self.state.run("M1")["final_pr"])
        self.state.save("M1.01", "blocked", reason="Evidence revoked")
        with self.assertRaisesRegex(RuntimeError, "unaccepted package"):
            self.controller.finalize("M1")
        self.assertEqual(self.github.closed, [])

    def test_reset_integration_branch_cannot_reuse_accepted_tasks(self):
        self.tick()
        self.tick(merge=True)
        baseline = self.state.run("M1")["develop_sha"]
        git(self.remote, "update-ref", "refs/heads/automation/milestone-m1", baseline)
        with self.assertRaises(RuntimeError):
            self.tick(merge=True)
        self.assertEqual(len(self.github.merge_calls), 1)

    def test_unlimited_tokens_resume_preserves_usage_and_review_gates(self):
        self.controller.preflight("M1")
        self.state.update_run("M1", tokens=760142)
        self.state.save("M1.01", "running", attempt=1)
        self.controller.no_token_limit = True
        self.controller.run("M1", once=True)
        self.assertGreater(self.state.run("M1")["tokens"], 760142)
        self.assertEqual(self.state.task("M1.01")["status"], "pr_pending")
        self.assertEqual(self.github.merge_calls, [])
        self.assertEqual(self.github.closed, [])
        self.assertEqual(self.state.task("M1.01")["attempt"], 2)

    def test_unlimited_tokens_still_stops_on_unknown_usage(self):
        self.controller.no_token_limit = True
        self.agent.tokens = None
        with self.assertRaisesRegex(TimeoutError, "Usage unavailable"):
            self.controller.run("M1", once=True)
        self.assertEqual(self.state.run("M1")["status"], "usage_unknown")

    def test_default_budget_still_stops_before_another_agent(self):
        self.controller.preflight("M1")
        self.state.update_run("M1", tokens=760142)
        with self.assertRaisesRegex(TimeoutError, "Cumulative token budget reached"):
            self.controller.run("M1", once=True)
        self.assertEqual(self.state.run("M1")["tokens"], 760142)

    def test_operator_context_reaches_agent_without_satisfying_external_gate(self):
        self.controller.preflight("M1")
        note = {"text": "Operator reports five passing tests; deployment remains unconfirmed.", "sha256": "example"}
        self.state.save("M1.01", "retry", operator_context=note)
        self.controller.catalog.tasks["M1.01"]["external"] = True
        original = self.agent.run
        contexts = []
        def recording(*args):
            contexts.append(args[-1])
            return original(*args)
        self.agent.run = recording
        self.controller.run("M1", once=True)
        self.assertEqual(contexts[0]["operator_context"], note)
        self.assertEqual(self.state.task("M1.01")["status"], "blocked")
        self.assertIn("External evidence", self.state.task("M1.01")["data"]["reason"])
        self.assertFalse(self.github.prs)

    def test_route_trace_is_executed_and_recorded_at_reviewed_sha(self):
        trace = self.root / "experiments/baseline/trace_routes.py"
        trace.parent.mkdir(parents=True)
        trace.write_text("print('eight matched routes and two unmatched fixtures')\n", encoding="utf-8")
        git(self.root, "add", ".")
        git(self.root, "commit", "-m", "Offline route fixture")
        git(self.root, "push", "origin", "develop")
        original = self.agent.run
        reviews = []
        def recording(*args):
            if args[1] != "implementer":
                reviews.append((args[3], args[4]))
            return original(*args)
        self.agent.run = recording
        self.controller.run("M1", once=True)
        self.assertEqual(self.state.task("M1.01")["status"], "pr_pending")
        self.assertEqual(len(reviews), 3)
        for sha, context in reviews:
            matching = [c for c in context["validation"] if c["argv"] ==
                        ["python3", "experiments/baseline/trace_routes.py"]]
            self.assertEqual(len(matching), 1)
            self.assertEqual(matching[0]["revision"], sha)
            self.assertEqual(matching[0]["status"], "passed")

    def test_failing_route_trace_prevents_review_and_pr(self):
        trace = self.root / "experiments/baseline/trace_routes.py"
        trace.parent.mkdir(parents=True)
        trace.write_text("raise SystemExit(1)\n", encoding="utf-8")
        git(self.root, "add", ".")
        git(self.root, "commit", "-m", "Failing route fixture")
        git(self.root, "push", "origin", "develop")
        self.controller.run("M1", once=True)
        record = self.state.task("M1.01")
        self.assertEqual(record["status"], "retry")
        self.assertEqual(record["data"]["feedback"]["argv"],
                         ["python3", "experiments/baseline/trace_routes.py"])
        self.assertFalse(self.github.prs)

    def test_resume_after_reviewer_interruption_reuses_validation_and_completed_roles(self):
        original = self.agent.run
        interrupted = [False]
        def agent(*args):
            if args[1] == "validator" and not interrupted[0]:
                interrupted[0] = True
                raise TimeoutError("Interrupted reviewer")
            return original(*args)
        self.agent.run = agent
        with patch.object(self.controller, "validate_candidate", wraps=self.controller.validate_candidate) as checks:
            with self.assertRaises(TimeoutError):
                self.tick()
            self.assertEqual(self.state.task("M1.01")["data"]["stage"], "review")
            self.tick()
            self.assertEqual(checks.call_count, 1)
        self.assertEqual(self.state.task("M1.01")["status"], "pr_pending")
        roles = [role for _, role, _ in self.agent.calls]
        self.assertEqual(roles.count("implementer"), 1)
        self.assertEqual(roles.count("reviewer"), 1)
        self.assertEqual(self.state.task("M1.01")["attempt"], 1)
        author = git(self.root, "show", "-s", "--format=%an <%ae>",
                     self.state.task("M1.01")["data"]["revision"])
        self.assertEqual(author, "Test <test@example.invalid>")

    def test_protocol_output_repair_accounts_usage_and_preserves_criteria_gate(self):
        original = self.agent.run
        bad = [True]
        def agent(*args):
            result = original(*args)
            if args[1] == "implementer" and bad[0]:
                bad[0] = False
                result["criteria"] = []
                self.agent.last_result = result
            return result
        self.agent.run = agent
        self.tick()
        self.assertEqual(self.state.task("M1.01")["status"], "pr_pending")
        self.assertEqual(self.state.run("M1")["tokens"], 50)
        self.assertEqual(self.state.task("M1.01")["attempt"], 1)

    def test_publication_recovery_reuses_implementation_validation_and_reviews(self):
        from tools.orchestrator.github import GitHubError
        original = self.github.ensure_pr
        failed = [False]
        def publish(*args, **kwargs):
            if not failed[0]:
                failed[0] = True
                raise GitHubError("Transient publication failure")
            return original(*args, **kwargs)
        with patch.object(self.github, "ensure_pr", side_effect=publish), patch("tools.orchestrator.controller.time.sleep"):
            with patch.object(self.controller, "validate_candidate", wraps=self.controller.validate_candidate) as checks:
                self.tick()
                self.assertEqual(self.state.task("M1.01")["data"]["stage"], "publish")
                self.assertEqual(self.state.task("M1.01")["status"], "retry")
                self.tick()
                self.assertEqual(checks.call_count, 1)
        self.assertEqual(len(self.agent.calls), 4)
        self.assertEqual(self.state.task("M1.01")["attempt"], 1)
        self.assertEqual(self.state.task("M1.01")["status"], "pr_pending")

    def test_recheck_preserves_candidate_and_skips_implementer_after_budget_exhaustion(self):
        self.agent.outcomes["implementer"] = ["blocked"]
        self.tick()
        self.assertEqual(self.state.task("M1.01")["status"], "blocked")
        self.state.save("M1.01", "blocked", attempt=3)
        with self.state.lock():
            self.controller.queue_recheck("M1.01", "Missing supervisor checks recovered")
        self.tick()
        record = self.state.task("M1.01")
        self.assertEqual(record["status"], "pr_pending")
        self.assertEqual(record["attempt"], 3)
        self.assertEqual(sum(role == "implementer" for _,role,_ in self.agent.calls), 1)

    def test_recheck_reconciles_integration_without_reimplementing_or_losing_commits(self):
        self.agent.outcomes["implementer"] = ["blocked"]
        self.tick()
        self.controller.queue_recheck("M1.01", "checkpoint existing implementation")
        original = self.state.task("M1.01")["data"]["revision"]
        base = self.state.run("M1")["integration_sha"]
        incoming = self.directory / "incoming"
        git(self.root, "worktree", "add", "--detach", str(incoming), base)
        (incoming / "docs").mkdir(exist_ok=True)
        (incoming / "docs/other-package.md").write_text("Accepted independent package\n", encoding="utf-8")
        git(incoming, "add", ".")
        git(incoming, "commit", "-m", "Independent package squash fixture")
        new_base = git(incoming, "rev-parse", "HEAD")
        git(incoming, "push", "origin", "HEAD:automation/milestone-m1")
        self.state.update_run("M1", integration_sha=new_base)
        self.controller.queue_recheck("M1.01", "revalidate on current integration")
        candidate = self.state.task("M1.01")["data"]
        self.assertEqual(candidate["base"], new_base)
        worktree = self.state.directory / "worktrees/M1.01"
        git(worktree, "merge-base", "--is-ancestor", original, candidate["revision"])
        git(worktree, "merge-base", "--is-ancestor", new_base, candidate["revision"])
        self.assertEqual(candidate["saved_reviews"], [])
        self.tick()
        self.assertEqual(self.state.task("M1.01")["status"], "pr_pending")
        self.assertEqual(sum(role == "implementer" for _,role,_ in self.agent.calls), 1)

    def test_integration_conflict_aborts_only_the_merge_and_preserves_candidate(self):
        self.agent.outcomes["implementer"] = ["blocked"]
        self.tick()
        self.controller.queue_recheck("M1.01", "checkpoint existing implementation")
        before = self.state.task("M1.01")["data"]["revision"]
        base = self.state.run("M1")["integration_sha"]
        incoming = self.directory / "conflicting"
        git(self.root, "worktree", "add", "--detach", str(incoming), base)
        (incoming / "docs").mkdir(exist_ok=True)
        (incoming / "docs/result.md").write_text("Conflicting accepted content\n", encoding="utf-8")
        git(incoming, "add", ".")
        git(incoming, "commit", "-m", "Conflicting integration fixture")
        new_base = git(incoming, "rev-parse", "HEAD")
        git(incoming, "push", "origin", "HEAD:automation/milestone-m1")
        self.state.update_run("M1", integration_sha=new_base)
        with self.assertRaisesRegex(ValueError, "original candidate preserved"):
            self.controller.queue_recheck("M1.01", "reconcile")
        worktree = self.state.directory / "worktrees/M1.01"
        self.assertEqual(git(worktree, "rev-parse", "HEAD"), before)
        self.assertFalse(git(worktree, "status", "--porcelain"))

    def test_unknown_token_usage_requires_operator_accounting_before_resume(self):
        self.agent.tokens = None
        with self.assertRaises(TimeoutError):
            self.tick()
        self.assertEqual(self.state.run("M1")["status"], "usage_unknown")
        calls = list(self.agent.calls)
        with self.assertRaisesRegex(RuntimeError, "Unknown token consumption"):
            self.tick()
        self.assertEqual(self.agent.calls, calls)

    def test_accepted_external_attestation_change_invalidates_resume(self):
        self.change_manifest_external()
        inputs = self.state.directory / "inputs"
        inputs.mkdir()
        fixture = inputs / "schema.txt"
        fixture.write_text("Verified sanitized schema")
        record = {"task": "M1.01", "verified_by": "Operator", "references": [
            {"path": "schema.txt", "sha256": hashlib.sha256(fixture.read_bytes()).hexdigest()}]}
        path = inputs / "M1.01.json"
        path.write_text(json.dumps(record))
        self.tick()
        self.tick(merge=True)
        record["verified_by"] = "Different operator"
        path.write_text(json.dumps(record))
        with self.assertRaisesRegex(RuntimeError, "external evidence changed"):
            self.tick()

    def test_external_evidence_change_while_waiting_ci_blocks_squash(self):
        self.change_manifest_external()
        inputs = self.state.directory / "inputs"
        inputs.mkdir()
        fixture = inputs / "schema.txt"
        fixture.write_text("Verified sanitized schema")
        record = {"task": "M1.01", "verified_by": "Operator", "references": [
            {"path": "schema.txt", "sha256": hashlib.sha256(fixture.read_bytes()).hexdigest()}]}
        path = inputs / "M1.01.json"
        path.write_text(json.dumps(record))
        self.tick()
        record["verified_by"] = "Attestation changed during CI"
        path.write_text(json.dumps(record))
        self.tick(merge=True)
        self.assertEqual(self.state.task("M1.01")["status"], "blocked")
        self.assertEqual(self.github.merge_calls, [])

    def test_reviewer_cannot_change_candidate(self):
        self.agent.review_dirty = True
        self.tick()
        self.assertEqual(self.state.task("M1.01")["status"], "blocked")
        self.assertEqual(self.github.prs, {})

    def test_attempt_budget_blocks_without_another_agent_call(self):
        self.state.save("M1.01", "retry", attempt=self.controller.policy["max_attempts"])
        self.tick()
        self.assertEqual(self.state.task("M1.01")["status"], "blocked")
        self.assertEqual(self.agent.calls, [])

    def test_pause_leaves_task_unstarted(self):
        (self.state.directory / "PAUSE").touch()
        self.tick()
        self.assertEqual(self.state.run("M1")["status"], "paused")
        self.assertEqual(self.agent.calls, [])

    def test_develop_movement_stops_resume(self):
        self.tick()
        git(self.root, "commit", "--allow-empty", "-m", "Concurrent develop change")
        git(self.root, "push", "origin", "develop")
        with self.assertRaisesRegex(RuntimeError, "develop moved"):
            self.tick(merge=True)
        self.assertEqual(self.github.merge_calls, [])

    def test_external_evidence_hash_change_is_rejected(self):
        inputs = self.state.directory / "inputs"
        inputs.mkdir()
        fixture = inputs / "ddl.txt"
        fixture.write_text("CREATE TABLE fixture (id INT);\n")
        record = {"task": "M1.01", "verified_by": "Operator", "references": [
            {"path": "ddl.txt", "sha256": hashlib.sha256(fixture.read_bytes()).hexdigest()}]}
        (inputs / "M1.01.json").write_text(json.dumps(record))
        self.assertIsNotNone(external_evidence(self.state.directory, self.task))
        fixture.write_text("Different DDL")
        with self.assertRaisesRegex(ValueError, "fingerprint changed"):
            external_evidence(self.state.directory, self.task)

    def test_external_evidence_cannot_escape_inputs(self):
        inputs = self.state.directory / "inputs"
        inputs.mkdir()
        record = {"task": "M1.01", "verified_by": "Operator", "references": [
            {"path": "../../execution/config.json", "sha256": "irrelevant"}]}
        (inputs / "M1.01.json").write_text(json.dumps(record))
        with self.assertRaisesRegex(ValueError, "outside inputs"):
            external_evidence(self.state.directory, self.task)


if __name__ == "__main__":
    unittest.main()
