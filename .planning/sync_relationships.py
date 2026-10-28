"""Add native sub-issues and blocked-by edges, preserving existing issue content."""
import argparse
import json
import os
from pathlib import Path
from github_api import GitHub, ApiError, REPOSITORY

ROOT = Path(__file__).resolve().parent


def synchronize(api, manifest, mapping):
    if manifest["repository"] != REPOSITORY:
        raise ApiError("Manifest repository mismatch")
    items = {x["key"]: x for x in manifest["items"]}
    if set(items) != set(mapping):
        raise ApiError("Issue mapping must contain exactly the manifest items")
    all_issues = {x["number"]: x for x in api.pages(f"/repos/{REPOSITORY}/issues?state=all") if "pull_request" not in x}
    issues = {}
    for key, spec in items.items():
        live = all_issues.get(mapping[key]["number"])
        marker = f"<!-- meta-v2-key: {key} -->"
        if not live or marker not in (live.get("body") or "") or live["title"] != spec["title"]:
            raise ApiError("Issue identity mismatch: " + key + "; refusing mutations")
        if "program:meta-v2" not in [x["name"] for x in live.get("labels", [])]:
            raise ApiError("Missing program ownership label: " + key)
        if spec.get("milestone") and (live.get("milestone") or {}).get("number") != spec["milestone"]:
            raise ApiError("Milestone mismatch: " + key)
        issues[key] = live

    parents = {}
    for spec in items.values():
        if spec.get("parent"):
            parents.setdefault(spec["parent"], []).append(spec["key"])
    added_parent = added_deps = 0
    for parent, children in parents.items():
        number = issues[parent]["number"]
        path = f"/repos/{REPOSITORY}/issues/{number}/sub_issues"
        existing = {x["id"] for x in api.pages(path)}
        for child in children:
            cid = issues[child]["id"]
            if cid not in existing:
                # No replace_parent: refuse rather than silently reparenting user work.
                api.request("POST", path, {"sub_issue_id": cid})
                existing.add(cid)
                added_parent += 1
        observed = {x["id"] for x in api.pages(path)}
        if not all(issues[c]["id"] in observed for c in children):
            raise ApiError("Native hierarchy verification failed: " + parent)

    expected_dependencies = 0
    for key, spec in items.items():
        deps = spec.get("deps", [])
        if not deps:
            continue
        number = issues[key]["number"]
        path = f"/repos/{REPOSITORY}/issues/{number}/dependencies/blocked_by"
        existing = {x["id"] for x in api.pages(path)}
        expected_dependencies += len(deps)
        for dependency in deps:
            did = issues[dependency]["id"]
            if did not in existing:
                api.request("POST", path, {"issue_id": did})
                existing.add(did)
                added_deps += 1
        observed = {x["id"] for x in api.pages(path)}
        if not all(issues[d]["id"] in observed for d in deps):
            raise ApiError("Native dependency verification failed: " + key)
    return {"repository": REPOSITORY, "issues_verified": len(issues),
            "hierarchy_edges_verified": sum(len(x) for x in parents.values()),
            "dependency_edges_verified": expected_dependencies,
            "hierarchy_edges_added": added_parent, "dependency_edges_added": added_deps}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    if not args.apply:
        print(json.dumps({"mode": "dry-run", "issues": len(manifest["items"]),
                          "hierarchy_edges": sum(bool(x.get("parent")) for x in manifest["items"]),
                          "dependency_edges": sum(len(x.get("deps", [])) for x in manifest["items"])}))
        return
    mapping = json.loads((ROOT / "issues-map.json").read_text(encoding="utf-8"))
    report = synchronize(GitHub(), manifest, mapping)
    (ROOT / "relationships-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps(report))
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as target:
            target.write("## Meta v2 · relações nativas verificadas\n\n```json\n" + json.dumps(report, indent=2) + "\n```\n")


if __name__ == "__main__":
    main()
