"""GitHub control-plane adapter. No shell, permission changes or non-squash merges.

The controller must serialize all writes to an integration branch. GitHub's REST
merge API has a head-SHA precondition, but no base-SHA precondition. We re-read the
base immediately before merging and verify the squash commit's sole parent
afterward. A racing external base update is an ambiguous outcome requiring
reconciliation, never a blind retry or a rollback of other contributors' work.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote, urlencode

REPOSITORY = "costaapps/ca_meta_app"
INTEGRATION = re.compile(r"^automation/milestone-m[1-6]$")
ISSUE_HEAD = re.compile(r"^codex/m([1-6])-[0-9]{2}(?:-[a-z0-9-]+)?$")
SHA = re.compile(r"^[0-9a-f]{40}$")
Command = Callable[[list[str], str | None], str]


class GitHubError(RuntimeError):
    """A transport or verified remote-state failure (no secret payload attached)."""


class MergeBlocked(GitHubError):
    """A precondition has not been satisfied. No merge was requested."""


class MergeOutcomeUnknown(GitHubError):
    """A merge may have happened; inspect remote state before trying again."""


def _sha(value: str) -> str:
    if not isinstance(value, str) or not SHA.fullmatch(value):
        raise GitHubError("Expected a full lowercase 40-character commit SHA")
    return value


def _branch(value: str) -> str:
    if (not isinstance(value, str) or not value or len(value) > 180
            or not re.fullmatch(r"[A-Za-z0-9._/-]+", value)
            or any(x in value for x in ("..", "//", "@{", "/.", ".lock"))
            or value.startswith(("-", ".", "/")) or value.endswith(("/", "."))):
        raise GitHubError("Invalid branch name")
    return value


def _number(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise GitHubError("Expected a positive GitHub number")
    return value


class GitHub:
    """Operations on the fixed repository, using the operator's gh identity.

    ``command`` is an injectable boundary for offline tests. It receives the
    complete argument vector and optional JSON stdin, and returns UTF-8 stdout.
    Never pass this adapter or its credentials into a worker's model context.
    """

    def __init__(self, cwd: Path, repository: str = REPOSITORY,
                 command: Command | None = None):
        if repository != REPOSITORY:
            raise GitHubError("Cross-repository control is prohibited")
        self.cwd = Path(cwd).resolve()
        self.repository = repository
        self._command = command or self._subprocess

    def _subprocess(self, args: list[str], data: str | None) -> str:
        try:
            result = subprocess.run(args, cwd=self.cwd, input=data, text=True,
                                    capture_output=True, timeout=90, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise GitHubError("GitHub CLI unavailable or timed out") from exc
        if result.returncode:
            # stderr can contain remote content; never echo it or credentials.
            raise GitHubError(f"GitHub CLI request failed (exit {result.returncode})")
        return result.stdout

    def _api(self, endpoint: str, method: str = "GET", payload: dict | None = None) -> Any:
        args = ["gh", "api", "--hostname", "github.com", "--method", method,
                endpoint, "-H", "Accept: application/vnd.github+json",
                "-H", "X-GitHub-Api-Version: 2022-11-28"]
        if payload is not None:
            args.extend(["--input", "-"])
        try:
            raw = self._command(args, None if payload is None else json.dumps(payload))
            result = json.loads(raw)
        except GitHubError:
            raise
        except (ValueError, OSError, subprocess.SubprocessError) as exc:
            raise GitHubError("GitHub returned an invalid or incomplete response") from exc
        if isinstance(result, dict) and result.get("errors"):
            raise GitHubError("GitHub GraphQL returned errors")
        return result

    def _pages(self, endpoint: str, member: str | None = None) -> list[dict]:
        rows: list[dict] = []
        separator = "&" if "?" in endpoint else "?"
        for page in range(1, 101):
            data = self._api(f"{endpoint}{separator}per_page=100&page={page}")
            batch = data if member is None else data.get(member)
            if not isinstance(batch, list):
                raise GitHubError("GitHub pagination returned an invalid page")
            rows.extend(batch)
            if len(batch) < 100:
                return rows
        raise GitHubError("GitHub pagination exceeded the bounded page limit")

    def branch_sha(self, branch: str) -> str:
        data = self._api(f"repos/{self.repository}/git/ref/heads/{quote(_branch(branch), safe='')}")
        return _sha(data["object"]["sha"])

    def ensure_branch(self, branch: str, sha: str) -> dict:
        """Create an execution branch; never reset an existing branch."""
        _branch(branch)
        _sha(sha)
        if not (INTEGRATION.fullmatch(branch) or ISSUE_HEAD.fullmatch(branch)):
            raise GitHubError("Only execution branches may be created")
        # Listing avoids interpreting auth/transport errors as a missing ref.
        refs = self._api(f"repos/{self.repository}/git/matching-refs/heads/{quote(branch, safe='')}")
        if not isinstance(refs, list):
            raise GitHubError("GitHub ref response is invalid")
        existing = [x for x in refs if x.get("ref") == f"refs/heads/{branch}"]
        if existing:
            actual = _sha(existing[0]["object"]["sha"])
            if actual != sha:
                raise GitHubError("Existing execution branch has a different SHA; reconciliation required")
            return {"ref": existing[0]["ref"], "sha": actual, "created": False}
        created = self._api(f"repos/{self.repository}/git/refs", "POST",
                            {"ref": f"refs/heads/{branch}", "sha": sha})
        if created.get("ref") != f"refs/heads/{branch}" or created.get("object", {}).get("sha") != sha:
            raise GitHubError("Created branch could not be verified")
        return {"ref": created["ref"], "sha": sha, "created": True}

    def ensure_pr(self, head: str, base: str, title: str, body: str) -> dict:
        _branch(head)
        _branch(base)
        if not (ISSUE_HEAD.fullmatch(head) and INTEGRATION.fullmatch(base)
                and ISSUE_HEAD.fullmatch(head).group(1) == base[-1]
                or INTEGRATION.fullmatch(head) and base == "develop"):
            raise GitHubError("PR branch pair is outside the execution policy")
        query = urlencode({"state": "all", "head": f"costaapps:{head}", "base": base})
        matches = self._pages(f"repos/{self.repository}/pulls?{query}")
        if len(matches) > 1:
            raise GitHubError("Multiple matching pull requests require reconciliation")
        if matches:
            pr = matches[0]
            if pr.get("state") != "open":
                raise GitHubError("Matching PR is already closed or merged; reconciliation required")
        else:
            # No closing keywords: issues remain open until the human milestone gate.
            if re.search(r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*"
                         r"(?:(?:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?#\d+|"
                         r"https://github\.com/[^/\s]+/[^/\s]+/issues/\d+)", body, re.I):
                raise GitHubError("Automatic issue-closing directives are prohibited")
            pr = self._api(f"repos/{self.repository}/pulls", "POST",
                           {"head": head, "base": base, "title": title,
                            "body": body, "draft": base == "develop"})
        normalized = self._normalize(pr)
        if normalized["head"] != head or normalized["base"] != base or not normalized["same_repository"]:
            raise GitHubError("Pull request identity does not match the requested execution")
        return normalized

    def _normalize(self, pr: dict) -> dict:
        try:
            return {"number": _number(pr["number"]), "url": pr["html_url"],
                    "head": pr["head"]["ref"], "base": pr["base"]["ref"],
                    "head_sha": _sha(pr["head"]["sha"]), "base_sha": _sha(pr["base"]["sha"]),
                    "same_repository": pr["head"]["repo"]["full_name"] == self.repository
                    and pr["base"]["repo"]["full_name"] == self.repository,
                    "state": pr["state"], "draft": pr.get("draft", False),
                    "merged": pr.get("merged", False), "mergeable": pr.get("mergeable"),
                    "merge_commit_sha": pr.get("merge_commit_sha")}
        except (KeyError, TypeError) as exc:
            raise GitHubError("Incomplete pull request identity") from exc

    def inspect_pr(self, number: int) -> dict:
        pr = self._normalize(self._api(f"repos/{self.repository}/pulls/{_number(number)}"))
        sha = pr["head_sha"]
        runs = self._pages(f"repos/{self.repository}/commits/{sha}/check-runs?filter=latest", "check_runs")
        statuses = self._pages(f"repos/{self.repository}/commits/{sha}/statuses")
        reviews = self._pages(f"repos/{self.repository}/pulls/{number}/reviews")
        # Latest run/status wins; never accept an old success over a new failure.
        checks: dict[str, dict] = {}
        for run in sorted(runs, key=lambda x: (x.get("started_at") or x.get("created_at") or "", x.get("id", 0))):
            checks[run["name"]] = {"state": "success" if run.get("status") == "completed"
                                    and run.get("conclusion") == "success" else "pending" if run.get("status") != "completed"
                                    else "failure", "app": run.get("app", {}).get("slug"),
                                    "sha": run.get("head_sha"), "kind": "check"}
        for status in sorted(statuses, key=lambda x: (x.get("created_at", ""), x.get("id", 0))):
            name = status["context"]
            # Same-named legacy status cannot overwrite a modern check.
            if name not in checks or checks[name]["kind"] == "status":
                checks[name] = {"state": status.get("state", "pending"), "kind": "status",
                                "app": None, "sha": sha}
        decisions: dict[str, str] = {}
        for review in sorted(reviews, key=lambda x: (x.get("submitted_at") or "", x.get("id", 0))):
            if review.get("state") in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED"):
                decisions[review.get("user", {}).get("login", "unknown")] = review["state"]
        pr.update(checks=checks, changes_requested=any(x == "CHANGES_REQUESTED" for x in decisions.values()))
        return pr

    def _verify_merge(self, number: int, expected_head: str, expected_base: str, merge_sha: str) -> dict:
        pr = self._normalize(self._api(f"repos/{self.repository}/pulls/{number}"))
        commit = self._api(f"repos/{self.repository}/git/commits/{_sha(merge_sha)}")
        candidate = self._api(f"repos/{self.repository}/git/commits/{expected_head}")
        parents = [p.get("sha") for p in commit.get("parents", [])]
        head_match = ISSUE_HEAD.fullmatch(pr["head"])
        if not (pr["same_repository"] and pr["merged"] and pr["head_sha"] == expected_head
                and INTEGRATION.fullmatch(pr["base"]) and head_match
                and head_match.group(1) == pr["base"][-1]
                and pr["merge_commit_sha"] == merge_sha and parents == [expected_base]
                and SHA.fullmatch(candidate.get("tree", {}).get("sha", ""))
                and commit.get("tree", {}).get("sha") == candidate["tree"]["sha"]):
            raise MergeOutcomeUnknown("Merge outcome differs from the pinned squash; reconciliation required")
        return {"number": number, "merged": True, "sha": merge_sha, "method": "squash", "url": pr["url"]}

    def merge_squash(self, number: int, expected_head: str, expected_base: str,
                     required_checks: list[str]) -> dict:
        """Merge only issue -> milestone PRs, with fresh checks and SHA guards.

        Final milestone -> develop PRs are always left for human acceptance.
        Branch protection remains authoritative. This adapter never bypasses it.
        """
        _sha(expected_head)
        _sha(expected_base)
        if not required_checks or len(set(required_checks)) != len(required_checks):
            raise MergeBlocked("At least one unique required CI check must be configured")
        pr = self.inspect_pr(number)
        match = ISSUE_HEAD.fullmatch(pr["head"])
        if (not pr["same_repository"] or not INTEGRATION.fullmatch(pr["base"])
                or not match or match.group(1) != pr["base"][-1]
                or pr["head_sha"] != expected_head):
            raise MergeBlocked("PR is outside the pinned issue-to-milestone scope")
        if pr["merged"]:
            return self._verify_merge(number, expected_head, expected_base, pr["merge_commit_sha"])
        if pr["state"] != "open" or pr["draft"] or pr["mergeable"] is not True:
            raise MergeBlocked("PR is closed, draft, conflicting or mergeability is unknown")
        if pr["base_sha"] != expected_base or pr["changes_requested"]:
            raise MergeBlocked("PR base changed or an outstanding change request exists")
        for name in required_checks:
            check = pr["checks"].get(name)
            if not (check and check["state"] == "success" and check["sha"] == expected_head
                    and check["kind"] == "check" and check["app"] == "github-actions"):
                raise MergeBlocked(f"Required GitHub Actions check is missing or unsuccessful: {name}")
        if any(x["state"] != "success" for x in pr["checks"].values()):
            raise MergeBlocked("A reported check or commit status is pending or failing")
        if self.branch_sha(pr["base"]) != expected_base:
            raise MergeBlocked("Integration branch advanced before merge")
        try:
            outcome = self._api(f"repos/{self.repository}/pulls/{number}/merge", "PUT",
                                {"merge_method": "squash", "sha": expected_head})
        except GitHubError as exc:
            raise MergeOutcomeUnknown("Merge response unavailable; reconcile the PR before retrying") from exc
        if outcome.get("merged") is not True or not SHA.fullmatch(outcome.get("sha", "")):
            raise MergeOutcomeUnknown("GitHub did not confirm a squash merge; reconcile the PR")
        try:
            return self._verify_merge(number, expected_head, expected_base, outcome["sha"])
        except GitHubError as exc:
            if isinstance(exc, MergeOutcomeUnknown):
                raise
            raise MergeOutcomeUnknown("Merge accepted but verification failed; reconcile the PR") from exc

    def sync_issue_comment(self, issue_number: int, marker: str, body: str) -> dict:
        _number(issue_number)
        if not isinstance(marker, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", marker):
            raise GitHubError("Invalid bounded comment marker")
        tag = f"<!-- meta-orchestrator:{marker} -->"
        target = tag + "\n" + body
        if len(target) > 60000:
            raise GitHubError("Issue update exceeds the bounded comment size")
        rows = self._pages(f"repos/{self.repository}/issues/{issue_number}/comments")
        matches = [x for x in rows if x.get("body", "").startswith(tag + "\n")]
        if len(matches) > 1:
            raise GitHubError("Duplicate control comments require reconciliation")
        if matches:
            comment = matches[0]
            if comment["body"] == target:
                return {"id": comment["id"], "changed": False}
            updated = self._api(f"repos/{self.repository}/issues/comments/{comment['id']}", "PATCH", {"body": target})
            if updated.get("id") != comment["id"] or updated.get("body") != target:
                raise GitHubError("Issue comment update could not be verified")
            return {"id": comment["id"], "changed": True}
        comment = self._api(f"repos/{self.repository}/issues/{issue_number}/comments", "POST", {"body": target})
        if not isinstance(comment.get("id"), int) or comment.get("body") != target:
            raise GitHubError("Created issue comment could not be verified")
        return {"id": comment["id"], "changed": True}

    def close_issue(self, issue_number: int) -> dict:
        """Close a work item after the caller verifies the human milestone gate.

        This method deliberately does not infer acceptance from PR text. The
        controller must verify the final merged squash before calling it.
        """
        _number(issue_number)
        issue = self._api(f"repos/{self.repository}/issues/{issue_number}")
        if issue.get("number") != issue_number or "pull_request" in issue:
            raise GitHubError("Requested work item is not the expected issue")
        if issue.get("state") == "closed":
            if issue.get("state_reason") not in (None, "completed"):
                raise GitHubError("Issue was closed for another reason; reconciliation required")
            return {"number": issue_number, "closed": True, "changed": False}
        if issue.get("state") != "open":
            raise GitHubError("Issue state is unknown")
        result = self._api(f"repos/{self.repository}/issues/{issue_number}", "PATCH",
                           {"state": "closed", "state_reason": "completed"})
        if (result.get("number") != issue_number or result.get("state") != "closed"
                or result.get("state_reason") != "completed"):
            raise GitHubError("Issue close could not be verified")
        return {"number": issue_number, "closed": True, "changed": True}

    def _graphql(self, query: str, variables: dict) -> dict:
        data = self._api("graphql", "POST", {"query": query, "variables": variables})
        if not isinstance(data, dict) or not isinstance(data.get("data"), dict):
            raise GitHubError("GitHub GraphQL response has no data")
        return data["data"]

    def _project_status_field(self, project_number: int, owner: str) -> tuple[str, dict]:
        _number(project_number)
        if owner != "costaapps":
            raise GitHubError("Project owner is outside the configured scope")
        fields: list[dict] = []
        cursor = None
        project_id = None
        for _ in range(100):
            data = self._graphql("""query($owner:String!,$number:Int!,$cursor:String){
              organization(login:$owner){projectV2(number:$number){id
                fields(first:100,after:$cursor){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}
                  pageInfo{hasNextPage endCursor}}}}}""",
                                 {"owner": owner, "number": project_number, "cursor": cursor})
            project = (data.get("organization") or {}).get("projectV2")
            if not project:
                raise GitHubError("Configured Project is unavailable to the current identity")
            project_id = project["id"]
            connection = project["fields"]
            fields.extend(connection["nodes"])
            if not connection["pageInfo"]["hasNextPage"]:
                break
            next_cursor = connection["pageInfo"]["endCursor"]
            if not next_cursor or next_cursor == cursor:
                raise GitHubError("Project fields pagination made no progress")
            cursor = next_cursor
        else:
            raise GitHubError("Project fields exceeded the bounded page limit")
        selected = [x for x in fields if x.get("name") == "Status"]
        if len(selected) != 1:
            raise GitHubError("Project must contain exactly one native Status select field")
        field = selected[0]
        return project_id, field

    def project_statuses(self, project_number: int = 12, owner: str = "costaapps") -> list[str]:
        """Read existing native Status option names for preflight; no writes."""
        _, field = self._project_status_field(project_number, owner)
        names = [x["name"] for x in field.get("options", [])]
        if not names or len(set(names)) != len(names):
            raise GitHubError("Project Status options are empty or ambiguous")
        return names

    def sync_project(self, issue_number: int, status: str, project_number: int = 12,
                     owner: str = "costaapps") -> dict:
        """Update one existing native Status option. Never create fields or items."""
        _number(issue_number)
        if not isinstance(status, str) or not status or len(status) > 100:
            raise GitHubError("Project status is outside the configured scope")
        project_id, field = self._project_status_field(project_number, owner)
        options = [x for x in field.get("options", []) if x["name"] == status]
        if len(options) != 1:
            raise GitHubError("Configured Status option is missing; configure it before execution")
        cursor = None
        found: list[dict] = []
        for _ in range(100):
            data = self._graphql("""query($id:ID!,$cursor:String){node(id:$id){... on ProjectV2{
              items(first:100,after:$cursor){nodes{id content{... on Issue{number repository{nameWithOwner}}}
                fieldValues(first:100){nodes{... on ProjectV2ItemFieldSingleSelectValue{
                  optionId field{... on ProjectV2SingleSelectField{id}}}}}}
                pageInfo{hasNextPage endCursor}}}}}""", {"id": project_id, "cursor": cursor})
            connection = data["node"]["items"]
            for item in connection["nodes"]:
                issue = item.get("content") or {}
                if (issue.get("number") == issue_number
                        and issue.get("repository", {}).get("nameWithOwner") == self.repository):
                    found.append(item)
            if not connection["pageInfo"]["hasNextPage"]:
                break
            next_cursor = connection["pageInfo"]["endCursor"]
            if not next_cursor or next_cursor == cursor:
                raise GitHubError("Project items pagination made no progress")
            cursor = next_cursor
        else:
            raise GitHubError("Project items exceeded the bounded page limit")
        if len(found) != 1:
            raise GitHubError("Issue must already belong to the Project exactly once")
        item = found[0]
        option_id = options[0]["id"]
        if any(x.get("field", {}).get("id") == field["id"] and x.get("optionId") == option_id
               for x in item["fieldValues"]["nodes"]):
            return {"item_id": item["id"], "status": status, "changed": False}
        result = self._graphql("""mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){
          updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,
            value:{singleSelectOptionId:$option}}){projectV2Item{id}}}""",
                      {"project": project_id, "item": item["id"], "field": field["id"], "option": option_id})
        if (result.get("updateProjectV2ItemFieldValue") or {}).get("projectV2Item", {}).get("id") != item["id"]:
            raise GitHubError("Project status update could not be verified")
        return {"item_id": item["id"], "status": status, "changed": True}
