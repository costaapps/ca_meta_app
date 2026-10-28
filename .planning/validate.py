"""Validate catalog structure, DAG, links and issue mapping without network."""
import csv
import io
import json
import re
from pathlib import Path
from catalog import ROOT, REPO, load_catalog
from render import build
from contracts import build_api, validate_references, EVENT_SCHEMA

PROJECT_ROOT = ROOT.parent
DOCS = PROJECT_ROOT / "docs" / "meta-v2"


def validate_catalog(tasks):
    keys = [x["key"] for x in tasks]
    if len(keys) != len(set(keys)):
        raise ValueError("Duplicate planning key")
    table = {x["key"]: x for x in tasks}
    finished = set()
    waves = []
    while len(finished) < len(table):
        ready = sorted(k for k, x in table.items() if k not in finished and set(x["deps"]).issubset(finished))
        if not ready:
            raise ValueError("Missing dependency or cycle")
        waves.append(ready)
        finished.update(ready)
    for t in tasks:
        if len(t["steps"]) < 6 or len(t["acceptance"]) < 5 or len(t["tests"]) < 3:
            raise ValueError("Insufficient construction/acceptance/validation detail: " + t["key"])
        if not t["contract"] or not t["risk"] or not t["refs"]:
            raise ValueError("Missing evidence/contract/risk: " + t["key"])
        if len(t["deps"]) != len(set(t["deps"])) or t["key"] in t["deps"]:
            raise ValueError("Duplicate/self dependency")
        if t["effort"] not in [3, 5, 8]:
            raise ValueError("Unexpected effort scale")
    return waves


def check_links():
    broken = []
    for path in DOCS.rglob("*.md"):
        for target in re.findall(r"\]\(([^)]+)\)", path.read_text(encoding="utf-8")):
            if "://" in target or target.startswith("#"):
                continue
            target = target.split("#", 1)[0]
            if target and not (path.parent / target).exists():
                broken.append((str(path.relative_to(PROJECT_ROOT)), target))
    if broken:
        raise ValueError("Broken local links: " + repr(broken))


def generate_catalog(tasks, mapping, waves):
    lines = ["# Catálogo de pacotes e sequência técnica", "", "Esta lista é gerada do mesmo catálogo das issues. Ondas indicam pré-requisitos, não datas ou alocação automática de equipe.", "", "| Chave | Pacote / issue | Milestone | Prioridade | Pontos | Dependências |", "|---|---|---|---|---:|---|"]
    for t in tasks:
        m = mapping.get(t["key"])
        label = f'[{t["title"]}]({m["url"]})' if m else t["title"]
        deps = ", ".join(f'[{d}]({mapping[d]["url"]})' if d in mapping else d for d in t["deps"]) or "—"
        lines.append(f'| {t["key"]} | {label} | {t["milestone"]} | {t["priority"]} | {t["effort"]} | {deps} |')
    lines.extend(["", "## Ondas topológicas", "", "Uma onda pode exigir múltiplas funções. Respeitar evidências externas e limites de trabalho em curso; não tratar esta ordenação como cronograma contratado.", ""])
    for index, wave in enumerate(waves, 1):
        lines.append(f'- Onda {index}: ' + ", ".join(wave))
    (DOCS / "work-packages.md").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["requirement_id", "package", "issue_url", "milestone", "acceptance", "planned_validation", "evidence_status"])
    for t in tasks:
        for i, acceptance in enumerate(t["acceptance"], 1):
            writer.writerow([f'{t["key"]}.AC{i:02}', t["key"], mapping.get(t["key"], {}).get("url", ""), t["milestone"], acceptance, " | ".join(t["tests"]), "PLANNED"])
    (DOCS / "acceptance-matrix.csv").write_text(output.getvalue(), encoding="utf-8", newline="\n")
    (ROOT / "dependency-waves.json").write_text(json.dumps(waves, indent=2) + "\n", encoding="utf-8", newline="\n")


def main():
    tasks = load_catalog()
    waves = validate_catalog(tasks)
    mapping = json.loads((ROOT / "issues-map.json").read_text(encoding="utf-8"))
    manifest = build(mapping)
    expected = {x["key"] for x in manifest["items"]}
    if set(mapping) != expected or len({x["number"] for x in mapping.values()}) != len(expected):
        raise ValueError("Incomplete/duplicate issue mapping")
    for m in mapping.values():
        if m["url"] != f'https://github.com/{REPO}/issues/{m["number"]}':
            raise ValueError("Issue URL mismatch")
    for item in manifest["items"]:
        if len(item["title"]) > 256 or len(item["body"]) > 60000:
            raise ValueError("GitHub content size exceeds safety limit")
    saved = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    if saved != manifest:
        raise ValueError("Generated manifest is stale; run render.py")
    generate_catalog(tasks, mapping, waves)
    api = build_api()
    validate_references(api)
    if json.loads((DOCS / "contracts/openapi.proposed.json").read_text(encoding="utf-8")) != api:
        raise ValueError("Proposed OpenAPI is stale; run contracts.py")
    if json.loads((DOCS / "contracts/internal-event.proposed.schema.json").read_text(encoding="utf-8")) != EVENT_SCHEMA:
        raise ValueError("Proposed event schema is stale")
    check_links()
    summary = {"issues": len(expected), "work_packages": len(tasks), "milestones": 6,
               "hierarchy_edges": sum(bool(x.get("parent")) for x in manifest["items"]),
               "dependency_edges": sum(len(t["deps"]) for t in tasks),
               "acceptance_criteria": sum(len(t["acceptance"]) for t in tasks),
               "construction_steps": sum(len(t["steps"]) for t in tasks),
               "planned_validation_groups": sum(len(t["tests"]) for t in tasks),
               "relative_points": sum(t["effort"] for t in tasks), "topological_waves": len(waves)}
    (ROOT / "validation-report.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
