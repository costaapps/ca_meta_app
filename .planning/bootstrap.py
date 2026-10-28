"""Create missing labels/milestones only. Never changes app code or credentials."""
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG = json.loads((ROOT / "bootstrap.json").read_text(encoding="utf-8"))
REPO = CONFIG["repository"]
if os.environ.get("GITHUB_REPOSITORY", REPO) != REPO:
    raise SystemExit("Repository mismatch; refusing cross-repository writes")
TOKEN = os.environ["GH_TOKEN"]


def api(path, data=None):
    request = urllib.request.Request(
        "https://api.github.com" + path,
        data=None if data is None else json.dumps(data).encode(),
        headers={"Authorization": "Bearer " + TOKEN,
                 "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json",
                 "X-GitHub-Api-Version": "2022-11-28"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def pages(path):
    result = []
    for page in range(1, 101):
        batch = api(path + ("&" if "?" in path else "?") + f"per_page=100&page={page}")
        result.extend(batch)
        if len(batch) < 100:
            return result
    raise RuntimeError("Pagination limit exceeded")


def main():
    labels = {x["name"] for x in pages(f"/repos/{REPO}/labels")}
    for label in CONFIG["labels"]:
        if label["name"] not in labels:
            api(f"/repos/{REPO}/labels", label)
    milestones = {x["title"]: x for x in pages(f"/repos/{REPO}/milestones?state=all")}
    lines = ["## Meta v2 · milestones provisionadas", "", "| Chave | Milestone |", "|---|---|"]
    mapping = {}
    for spec in CONFIG["milestones"]:
        item = milestones.get(spec["title"])
        if item is None:
            item = api(f"/repos/{REPO}/milestones", {"title": spec["title"], "description": spec["description"]})
        mapping[spec["key"]] = {"number": item["number"], "url": item["html_url"]}
        lines.append(f'| {spec["key"]} | [{spec["title"]}]({item["html_url"]}) |')
    print(json.dumps(mapping, ensure_ascii=False))
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as target:
            target.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
