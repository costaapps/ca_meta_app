"""Offline contract tests for the GitHub control plane; no live credentials."""
import copy
import json
import unittest
from pathlib import Path

from tools.orchestrator.github import GitHub, GitHubError, MergeBlocked, MergeOutcomeUnknown

HEAD = "a" * 40
BASE = "b" * 40
SQUASH = "c" * 40
TREE = "e" * 40
REPO = "repos/costaapps/ca_meta_app"


def pull(**changes):
    value = {"number": 80, "html_url": "https://github.com/costaapps/ca_meta_app/pull/80",
             "head": {"ref": "codex/m1-01", "sha": HEAD,
                      "repo": {"full_name": "costaapps/ca_meta_app"}},
             "base": {"ref": "automation/milestone-m1", "sha": BASE,
                      "repo": {"full_name": "costaapps/ca_meta_app"}},
             "state": "open", "draft": False, "merged": False,
             "mergeable": True, "merge_commit_sha": None}
    value.update(changes)
    return value


def run(name="orchestrator", state="success", **changes):
    value = {"id": 1, "name": name, "head_sha": HEAD, "status": "completed",
             "conclusion": state, "app": {"slug": "github-actions"},
             "started_at": "2026-10-28T10:00:00Z"}
    value.update(changes)
    return value


class Fake:
    def __init__(self, steps):
        self.steps = list(steps)
        self.calls = []

    def __call__(self, args, stdin):
        self.calls.append((args, None if stdin is None else json.loads(stdin)))
        if not self.steps:
            raise AssertionError(f"Unexpected request: {args}")
        endpoint, result = self.steps.pop(0)
        if endpoint is not None:
            assert args[6] == endpoint, (args[6], endpoint)
        assert args[:6] == ["gh", "api", "--hostname", "github.com", "--method", args[5]]
        if isinstance(result, Exception):
            raise result
        return json.dumps(result)


def inspected(pr=None, checks=None, reviews=None, statuses=None):
    return [(f"{REPO}/pulls/80", pull() if pr is None else pr),
            (f"{REPO}/commits/{HEAD}/check-runs?filter=latest&per_page=100&page=1",
             {"check_runs": [run()] if checks is None else checks}),
            (f"{REPO}/commits/{HEAD}/statuses?per_page=100&page=1", statuses or []),
            (f"{REPO}/pulls/80/reviews?per_page=100&page=1", reviews or [])]


def merge_steps(**kwargs):
    return inspected(**kwargs) + [
        (f"{REPO}/git/ref/heads/automation%2Fmilestone-m1", {"object": {"sha": BASE}}),
        (f"{REPO}/pulls/80/merge", {"merged": True, "sha": SQUASH}),
        (f"{REPO}/pulls/80", pull(merged=True, state="closed", merge_commit_sha=SQUASH)),
        (f"{REPO}/git/commits/{SQUASH}", {"parents": [{"sha": BASE}], "tree": {"sha": TREE}}),
        (f"{REPO}/git/commits/{HEAD}", {"tree": {"sha": TREE}})]


def field_page(options=None, next_page=False):
    return {"data": {"organization": {"projectV2": {"id": "P12", "fields": {
        "nodes": [{"id": "F", "name": "Status", "options": options or [{"id": "O", "name": "In progress"}]}],
        "pageInfo": {"hasNextPage": next_page, "endCursor": "next" if next_page else None}}}}}}


def item_page(items, next_page=False):
    return {"data": {"node": {"items": {"nodes": items,
        "pageInfo": {"hasNextPage": next_page, "endCursor": "next" if next_page else None}}}}}


def item(number=10, status=None, repository="costaapps/ca_meta_app"):
    return {"id": f"I{number}", "content": {"number": number, "repository": {"nameWithOwner": repository}},
            "fieldValues": {"nodes": [] if status is None else [{"field": {"id": "F"}, "optionId": status}]}}


class GitHubTests(unittest.TestCase):
    def adapter(self, steps):
        fake = Fake(steps)
        return GitHub(Path("."), command=fake), fake

    def test_rejects_cross_repository_before_transport(self):
        with self.assertRaises(GitHubError):
            GitHub(Path("."), repository="other/repo")

    def test_branch_name_does_not_become_an_option_or_traversal(self):
        api, fake = self.adapter([])
        for name in ("--help", "../main", "a//b", "x;curl", "a.lock"):
            with self.assertRaises(GitHubError):
                api.branch_sha(name)
        self.assertEqual([], fake.calls)

    def test_ensure_branch_is_idempotent(self):
        endpoint = f"{REPO}/git/matching-refs/heads/automation%2Fmilestone-m1"
        api, fake = self.adapter([(endpoint, [{"ref": "refs/heads/automation/milestone-m1", "object": {"sha": BASE}}])])
        self.assertFalse(api.ensure_branch("automation/milestone-m1", BASE)["created"])
        self.assertEqual(1, len(fake.calls))

    def test_ensure_branch_does_not_reset_divergent_ref(self):
        api, fake = self.adapter([(None, [{"ref": "refs/heads/codex/m1-01", "object": {"sha": HEAD}}])])
        with self.assertRaisesRegex(GitHubError, "reconciliation"):
            api.ensure_branch("codex/m1-01", BASE)
        self.assertEqual(1, len(fake.calls))

    def test_branch_creation_uses_only_pinned_sha(self):
        api, fake = self.adapter([(None, []), (None, {"ref": "refs/heads/codex/m1-01", "object": {"sha": BASE}})])
        self.assertTrue(api.ensure_branch("codex/m1-01", BASE)["created"])
        self.assertEqual({"ref": "refs/heads/codex/m1-01", "sha": BASE}, fake.calls[1][1])
        with self.assertRaises(GitHubError):
            api.ensure_branch("develop", BASE)

    def test_squash_request_and_result_are_verified(self):
        api, fake = self.adapter(merge_steps())
        result = api.merge_squash(80, HEAD, BASE, ["orchestrator"])
        mutations = [(a, b) for a, b in fake.calls if a[5] == "PUT"]
        self.assertEqual([{"merge_method": "squash", "sha": HEAD}], [b for _, b in mutations])
        self.assertEqual({"method": "squash", "sha": SQUASH}, {k: result[k] for k in ("method", "sha")})
        self.assertFalse(fake.steps)

    def test_cannot_automatically_merge_develop(self):
        value = pull()
        value["head"]["ref"] = "automation/milestone-m1"
        value["base"]["ref"] = "develop"
        api, fake = self.adapter(inspected(pr=value))
        with self.assertRaises(MergeBlocked):
            api.merge_squash(80, HEAD, BASE, ["orchestrator"])
        self.assertTrue(all(a[5] == "GET" for a, _ in fake.calls))

    def test_cross_milestone_or_fork_pr_cannot_merge(self):
        for field, val in (("ref", "codex/m2-01"), ("repo", {"full_name": "attacker/fork"})):
            value = pull()
            value["head"][field] = val
            api, _ = self.adapter(inspected(pr=value))
            with self.assertRaises(MergeBlocked):
                api.merge_squash(80, HEAD, BASE, ["orchestrator"])

    def test_head_and_base_drift_block_merge(self):
        for expected_head, expected_base in (("d" * 40, BASE), (HEAD, "d" * 40)):
            api, fake = self.adapter(inspected())
            with self.assertRaises(MergeBlocked):
                api.merge_squash(80, expected_head, expected_base, ["orchestrator"])
            self.assertFalse(any(a[5] == "PUT" for a, _ in fake.calls))

    def test_integration_branch_is_reread_before_merge(self):
        steps = inspected() + [(None, {"object": {"sha": "d" * 40}})]
        api, fake = self.adapter(steps)
        with self.assertRaisesRegex(MergeBlocked, "advanced"):
            api.merge_squash(80, HEAD, BASE, ["orchestrator"])
        self.assertFalse(any(a[5] == "PUT" for a, _ in fake.calls))

    def test_missing_required_checks_and_legacy_spoof_block(self):
        for checks, statuses in (([], []), ([], [{"id": 1, "context": "orchestrator", "state": "success"}])):
            api, _ = self.adapter(inspected(checks=checks, statuses=statuses))
            with self.assertRaisesRegex(MergeBlocked, "missing"):
                api.merge_squash(80, HEAD, BASE, ["orchestrator"])

    def test_foreign_app_or_wrong_sha_is_not_accepted_as_ci(self):
        for value in (run(app={"slug": "unknown"}), run(head_sha="d" * 40)):
            api, _ = self.adapter(inspected(checks=[value]))
            with self.assertRaises(MergeBlocked):
                api.merge_squash(80, HEAD, BASE, ["orchestrator"])

    def test_pending_or_failure_anywhere_blocks(self):
        for value in (run("extra", "failure"), run("extra", status="queued", conclusion=None)):
            api, _ = self.adapter(inspected(checks=[run(), value]))
            with self.assertRaisesRegex(MergeBlocked, "pending or failing"):
                api.merge_squash(80, HEAD, BASE, ["orchestrator"])

    def test_newer_failed_rerun_overrides_old_success(self):
        api, _ = self.adapter(inspected(checks=[run(), run(id=2, state="failure", started_at="2026-10-28T11:00:00Z")]))
        with self.assertRaises(MergeBlocked):
            api.merge_squash(80, HEAD, BASE, ["orchestrator"])

    def test_outstanding_changes_request_is_not_erased_by_comment(self):
        reviews = [{"id": 1, "user": {"login": "reviewer"}, "state": "CHANGES_REQUESTED"},
                   {"id": 2, "user": {"login": "reviewer"}, "state": "COMMENTED"}]
        api, _ = self.adapter(inspected(reviews=reviews))
        with self.assertRaisesRegex(MergeBlocked, "change request"):
            api.merge_squash(80, HEAD, BASE, ["orchestrator"])

    def test_draft_conflicts_and_unknown_mergeability_block(self):
        for changes in ({"draft": True}, {"mergeable": False}, {"mergeable": None}, {"state": "closed"}):
            api, _ = self.adapter(inspected(pr=pull(**changes)))
            with self.assertRaises(MergeBlocked):
                api.merge_squash(80, HEAD, BASE, ["orchestrator"])

    def test_empty_required_check_policy_blocks_before_transport(self):
        api, fake = self.adapter([])
        with self.assertRaises(MergeBlocked):
            api.merge_squash(80, HEAD, BASE, [])
        self.assertFalse(fake.calls)

    def test_timeout_during_merge_is_ambiguous_and_not_retried(self):
        steps = merge_steps()[:5] + [(None, GitHubError("timeout"))]
        api, fake = self.adapter(steps)
        with self.assertRaises(MergeOutcomeUnknown):
            api.merge_squash(80, HEAD, BASE, ["orchestrator"])
        self.assertEqual(1, sum(a[5] == "PUT" for a, _ in fake.calls))

    def test_squash_base_race_detected_after_remote_merge(self):
        steps = merge_steps()
        steps[-2] = (None, {"parents": [{"sha": "d" * 40}], "tree": {"sha": TREE}})
        api, _ = self.adapter(steps)
        with self.assertRaises(MergeOutcomeUnknown):
            api.merge_squash(80, HEAD, BASE, ["orchestrator"])

    def test_merge_commit_with_two_parents_is_rejected(self):
        steps = merge_steps()
        steps[-2] = (None, {"parents": [{"sha": BASE}, {"sha": HEAD}], "tree": {"sha": TREE}})
        api, _ = self.adapter(steps)
        with self.assertRaises(MergeOutcomeUnknown):
            api.merge_squash(80, HEAD, BASE, ["orchestrator"])

    def test_already_merged_pr_is_reconciled_without_another_put(self):
        value = pull(merged=True, state="closed", merge_commit_sha=SQUASH)
        steps = inspected(pr=value) + [(None, value), (None, {"parents": [{"sha": BASE}], "tree": {"sha": TREE}}),
                                        (None, {"tree": {"sha": TREE}})]
        api, fake = self.adapter(steps)
        self.assertEqual(SQUASH, api.merge_squash(80, HEAD, BASE, ["orchestrator"])["sha"])
        self.assertFalse(any(a[5] == "PUT" for a, _ in fake.calls))

    def test_final_pr_is_draft_and_issue_pr_is_not(self):
        for head, base in (("codex/m1-01", "automation/milestone-m1"), ("automation/milestone-m1", "develop")):
            value = pull()
            value["head"]["ref"] = head
            value["base"]["ref"] = base
            api, fake = self.adapter([(None, []), (None, value)])
            api.ensure_pr(head, base, "Deliver", "Refs #10")
            self.assertEqual(base == "develop", fake.calls[1][1]["draft"])

    def test_duplicate_pr_and_auto_close_directives_fail_closed(self):
        api, _ = self.adapter([(None, [pull(), pull()])])
        with self.assertRaises(GitHubError):
            api.ensure_pr("codex/m1-01", "automation/milestone-m1", "Deliver", "Refs #10")
        api, fake = self.adapter([(None, [])])
        with self.assertRaises(GitHubError):
            api.ensure_pr("codex/m1-01", "automation/milestone-m1", "Deliver", "Fixes #10")
        self.assertEqual(1, len(fake.calls))

    def test_issue_comment_is_idempotent(self):
        comment = {"id": 1, "body": "<!-- meta-orchestrator:M1.01 -->\nValidated"}
        api, fake = self.adapter([(None, [comment])])
        self.assertFalse(api.sync_issue_comment(10, "M1.01", "Validated")["changed"])
        self.assertEqual(1, len(fake.calls))

    def test_comment_pagination_and_update_do_not_duplicate(self):
        page = [{"id": x, "body": "unrelated"} for x in range(100)]
        comment = {"id": 101, "body": "<!-- meta-orchestrator:M1.01 -->\nOld"}
        updated = {"id": 101, "body": "<!-- meta-orchestrator:M1.01 -->\nNew"}
        api, fake = self.adapter([(None, page), (None, [comment]), (None, updated)])
        self.assertTrue(api.sync_issue_comment(10, "M1.01", "New")["changed"])
        self.assertEqual("PATCH", fake.calls[-1][0][5])
        self.assertIn("page=2", fake.calls[1][0][6])

    def test_project_native_status_update_and_idempotency(self):
        for current in (None, "O"):
            steps = [("graphql", field_page()), ("graphql", item_page([item(status=current)]))]
            if current is None:
                steps.append(("graphql", {"data": {"updateProjectV2ItemFieldValue": {"projectV2Item": {"id": "I10"}}}}))
            api, fake = self.adapter(steps)
            result = api.sync_project(10, "In progress")
            self.assertEqual(current is None, result["changed"])
            self.assertEqual(2 if current else 3, len(fake.calls))

    def test_project_items_are_paginated_and_scoped_to_repository(self):
        api, fake = self.adapter([
            ("graphql", field_page()),
            ("graphql", item_page([item(repository="other/repo")], next_page=True)),
            ("graphql", item_page([item(status="O")])),
        ])
        self.assertFalse(api.sync_project(10, "In progress")["changed"])
        self.assertEqual("next", fake.calls[-1][1]["variables"]["cursor"])

    def test_missing_project_fields_options_and_items_are_not_created(self):
        for steps in ([("graphql", field_page())],
                      [("graphql", field_page()), ("graphql", item_page([]))]):
            api, fake = self.adapter(steps)
            with self.assertRaises(GitHubError):
                api.sync_project(10, "Unknown" if len(steps) == 1 else "In progress")
            self.assertFalse(any("mutation" in (b or {}).get("query", "") for _, b in fake.calls))

    def test_graphql_permission_error_is_explicit(self):
        api, _ = self.adapter([("graphql", {"errors": [{"type": "FORBIDDEN", "message": "private detail"}]})])
        with self.assertRaisesRegex(GitHubError, "GraphQL returned errors") as error:
            api.sync_project(10, "In progress")
        self.assertNotIn("private detail", str(error.exception))

    def test_project_wrong_owner_fails_before_transport(self):
        api, fake = self.adapter([])
        with self.assertRaises(GitHubError):
            api.sync_project(10, "Todo", owner="other")
        self.assertFalse(fake.calls)

    def test_unverified_comment_and_project_updates_are_not_reported_as_success(self):
        api, _ = self.adapter([(None, []), (None, {"id": 10})])
        with self.assertRaisesRegex(GitHubError, "could not be verified"):
            api.sync_issue_comment(10, "M1.01", "New")
        api, _ = self.adapter([("graphql", field_page()), ("graphql", item_page([item()])),
                              ("graphql", {"data": {"updateProjectV2ItemFieldValue": None}})])
        with self.assertRaisesRegex(GitHubError, "could not be verified"):
            api.sync_project(10, "In progress")

    def test_squash_result_tree_must_equal_the_reviewed_candidate(self):
        steps = merge_steps()
        steps[-1] = (None, {"tree": {"sha": "f" * 40}})
        api, _ = self.adapter(steps)
        with self.assertRaises(MergeOutcomeUnknown):
            api.merge_squash(80, HEAD, BASE, ["orchestrator"])

    def test_existing_closed_final_pr_requires_reconciliation(self):
        value = pull(state="closed")
        value["head"]["ref"] = "automation/milestone-m1"
        value["base"]["ref"] = "develop"
        api, fake = self.adapter([(None, [value])])
        with self.assertRaisesRegex(GitHubError, "closed or merged"):
            api.ensure_pr("automation/milestone-m1", "develop", "Milestone", "Refs #4")
        self.assertEqual(1, len(fake.calls))

    def test_close_issue_is_verified_and_idempotent(self):
        api, fake = self.adapter([(None, {"number": 10, "state": "open"}),
                                 (None, {"number": 10, "state": "closed", "state_reason": "completed"})])
        self.assertTrue(api.close_issue(10)["changed"])
        self.assertEqual({"state": "closed", "state_reason": "completed"}, fake.calls[-1][1])
        api, fake = self.adapter([(None, {"number": 10, "state": "closed", "state_reason": "completed"})])
        self.assertFalse(api.close_issue(10)["changed"])
        self.assertEqual(1, len(fake.calls))

    def test_close_issue_does_not_close_a_pr_or_override_another_reason(self):
        for issue in ({"number": 10, "state": "open", "pull_request": {}},
                      {"number": 10, "state": "closed", "state_reason": "not_planned"}):
            api, fake = self.adapter([(None, issue)])
            with self.assertRaises(GitHubError):
                api.close_issue(10)
            self.assertEqual(1, len(fake.calls))

    def test_close_issue_requires_verified_response(self):
        api, _ = self.adapter([(None, {"number": 10, "state": "open"}),
                               (None, {"number": 10, "state": "open"})])
        with self.assertRaisesRegex(GitHubError, "could not be verified"):
            api.close_issue(10)

    def test_project_statuses_is_read_only_and_rejects_ambiguous_options(self):
        api, fake = self.adapter([("graphql", field_page())])
        self.assertEqual(["In progress"], api.project_statuses())
        self.assertNotIn("mutation", fake.calls[0][1]["query"])
        api, _ = self.adapter([("graphql", field_page(options=[{"id": "1", "name": "Todo"},
                                                               {"id": "2", "name": "Todo"}]))])
        with self.assertRaisesRegex(GitHubError, "ambiguous"):
            api.project_statuses()


if __name__ == "__main__":
    unittest.main()
