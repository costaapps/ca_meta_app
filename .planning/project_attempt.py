"""Attempt Project provisioning with existing authority; report an access gap safely."""
import json
import os
from github_api import GitHub, ApiError
from project import ROOT, provision

manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
mapping = json.loads((ROOT / "issues-map.json").read_text(encoding="utf-8"))
try:
    report = provision(GitHub(), manifest, mapping)
except ApiError as error:
    report = {"status": "blocked", "project_created": False, "reason": str(error),
              "next_step": "Use an already authorized organization Projects credential; no access was expanded"}
    # A partial creation can exist; journal makes that state explicit for safe resume.
    if (ROOT / "project-state.json").exists():
        report["partial_state"] = json.loads((ROOT / "project-state.json").read_text(encoding="utf-8"))
        report["project_created"] = "partial; inspect journal before claiming completion"
    (ROOT / "project-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
print(json.dumps(report))
summary = os.environ.get("GITHUB_STEP_SUMMARY")
if summary:
    with open(summary, "a", encoding="utf-8") as target:
        target.write("## Meta v2 · Project nativo\n\n```json\n" + json.dumps(report, indent=2) + "\n```\n")
