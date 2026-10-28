"""Provision only this program's private Project. Dry-run is the default.

Requires an already authorized organization Projects-write credential for apply.
Does not create credentials, grant collaborators, or change repository settings.
"""
import argparse
import json
from pathlib import Path
from github_api import GitHub, ApiError, REPOSITORY
from render import ROLE

ROOT = Path(__file__).resolve().parent
CONFIG = json.loads((ROOT / "project-config.json").read_text(encoding="utf-8"))
PROJECT_FIELDS = """... on ProjectV2Field {id name dataType}
... on ProjectV2SingleSelectField {id name dataType options {id name color description}}
... on ProjectV2IterationField {id name dataType}"""
ITEM_FIELDS = """id content {... on Issue {id number}} fieldValues(first:100) {nodes {
... on ProjectV2ItemFieldSingleSelectValue {name field {... on ProjectV2SingleSelectField {name}}}
... on ProjectV2ItemFieldNumberValue {number field {... on ProjectV2Field {name}}}
... on ProjectV2ItemFieldTextValue {text field {... on ProjectV2Field {name}}}
}}"""


def mutation(api, name, input_type, data, selection):
    return api.graphql(f"mutation($input:{input_type}!){{{name}(input:$input){{{selection}}}}}", {"input": data})[name]


def project_node(api, project_id):
    data = api.graphql("query($id:ID!){node(id:$id){... on ProjectV2{id number title url public readme owner{... on Organization{login}}}}}", {"id": project_id})["node"]
    if not data or data["owner"]["login"] != CONFIG["organization"] or data["title"] != CONFIG["title"]:
        raise ApiError("Project ownership/title mismatch")
    return data


def connection(api, project_id, name, selection):
    result, cursor = [], None
    for _ in range(100):
        query = "query($id:ID!,$after:String){node(id:$id){... on ProjectV2{" + name + "(first:100,after:$after){nodes{" + selection + "}pageInfo{hasNextPage endCursor}}}}}"
        page = api.graphql(query, {"id": project_id, "after": cursor})["node"][name]
        result.extend(page["nodes"])
        if not page["pageInfo"]["hasNextPage"]:
            return result
        cursor = page["pageInfo"]["endCursor"]
    raise ApiError("Project pagination safety limit reached")


def options(names, previous=None):
    previous = {x["name"]: x for x in (previous or [])}
    colors = ["GRAY", "BLUE", "ORANGE", "PURPLE", "RED", "GREEN"]
    output = []
    for index, name in enumerate(names):
        item = {"name": name, "description": name, "color": colors[index % len(colors)]}
        if name in previous:
            item["id"] = previous[name]["id"]
        output.append(item)
    return output


def find_or_create(api, mapping):
    state_path = ROOT / "project-state.json"
    if state_path.exists():
        saved = json.loads(state_path.read_text(encoding="utf-8"))
        project = project_node(api, saved["id"])
        if CONFIG["marker"] in (project["readme"] or ""):
            return project
        # Resume our journaled empty creation; no unrelated Project is adopted.
        if (project["readme"] or "").strip() or connection(api, project["id"], "items", "id"):
            raise ApiError("Unmarked journaled Project is not empty; refusing to overwrite")
    else:
        cursor, matches, owner, repo = None, [], None, None
        for _ in range(100):
            data = api.graphql('query($after:String){organization(login:"costaapps"){id projectsV2(first:100,after:$after){nodes{id title}pageInfo{hasNextPage endCursor}}}repository(owner:"costaapps",name:"ca_meta_app"){id nameWithOwner}}', {"after": cursor})
            owner, repo = data["organization"], data["repository"]
            if not owner or not repo or repo["nameWithOwner"] != REPOSITORY:
                raise ApiError("Organization/repository not accessible")
            page = owner["projectsV2"]
            matches.extend(x for x in page["nodes"] if x["title"] == CONFIG["title"])
            if not page["pageInfo"]["hasNextPage"]:
                break
            cursor = page["pageInfo"]["endCursor"]
        else:
            raise ApiError("Organization project pagination safety limit reached")
        if matches:
            if len(matches) != 1:
                raise ApiError("Ambiguous project title; refusing to create or overwrite")
            project = project_node(api, matches[0]["id"])
            if CONFIG["marker"] not in (project["readme"] or ""):
                raise ApiError("Same title belongs to an unmarked Project; refusing to overwrite")
            return project
        project = mutation(api, "createProjectV2", "CreateProjectV2Input", {
            "ownerId": owner["id"], "repositoryId": repo["id"], "title": CONFIG["title"]
        }, "projectV2{id number title url}")["projectV2"]
        state_path.write_text(json.dumps(project, indent=2) + "\n", encoding="utf-8", newline="\n")

    readme = CONFIG["marker"] + "\n\nPlano de implantação Meta v2. Índice: " + mapping["PROGRAM"]["url"] + "\n\nImplementação pendente. Todos os pacotes exigem evidência de aceite. Datas/assignees dependem de capacidade confirmada."
    updated = mutation(api, "updateProjectV2", "UpdateProjectV2Input", {
        "projectId": project["id"], "public": False, "readme": readme,
        "shortDescription": "Quatro fluxos Meta, acesso seguro, credenciais, portal, Docker/CI e migração Msg4/Suite4."
    }, "projectV2{id number title url public readme owner{... on Organization{login}}}")["projectV2"]
    state_path.write_text(json.dumps({k: updated[k] for k in ["id", "number", "url", "title"]}, indent=2) + "\n", encoding="utf-8", newline="\n")
    return updated


def field_values(item):
    values = {}
    for value in item.get("fieldValues", {}).get("nodes", []):
        name = (value.get("field") or {}).get("name")
        if name:
            values[name] = value.get("name", value.get("number", value.get("text")))
    return values


def provision(api, manifest, mapping):
    project = find_or_create(api, mapping)
    if project.get("public") is not False:
        raise ApiError("Project must be confirmed private before importing private issue metadata")
    pid = project["id"]
    existing_items = connection(api, pid, "items", ITEM_FIELDS)
    fields = {x["name"]: x for x in connection(api, pid, "fields", PROJECT_FIELDS)}
    status = fields.get("Status")
    if not status:
        raise ApiError("Default Status field not found; refusing to guess")
    names = {x["name"] for x in status.get("options", [])}
    if not set(CONFIG["status_options"]).issubset(names):
        if existing_items:
            raise ApiError("Existing Status options differ; preserve work and adjust explicitly")
        mutation(api, "updateProjectV2Field", "UpdateProjectV2FieldInput", {
            "fieldId": status["id"], "singleSelectOptions": options(CONFIG["status_options"], status.get("options"))
        }, "projectV2Field{... on ProjectV2SingleSelectField{id}}")
    for name, names in CONFIG["select_fields"].items():
        if name not in fields:
            mutation(api, "createProjectV2Field", "CreateProjectV2FieldInput", {
                "projectId": pid, "name": name, "dataType": "SINGLE_SELECT", "singleSelectOptions": options(names)
            }, "projectV2Field{... on ProjectV2SingleSelectField{id}}")
    for name, kind in CONFIG["other_fields"].items():
        if name not in fields:
            mutation(api, "createProjectV2Field", "CreateProjectV2FieldInput", {
                "projectId": pid, "name": name, "dataType": kind
            }, "projectV2Field{... on ProjectV2Field{id}}")
    fields = {x["name"]: x for x in connection(api, pid, "fields", PROJECT_FIELDS)}
    issues = {x["number"]: x for x in api.pages(f"/repos/{REPOSITORY}/issues?state=all") if "pull_request" not in x}
    by_content = {x["content"]["id"]: x for x in existing_items if x.get("content")}
    for spec in manifest["items"]:
        live = issues.get(mapping[spec["key"]]["number"])
        if not live or f'<!-- meta-v2-key: {spec["key"]} -->' not in (live.get("body") or ""):
            raise ApiError("Issue identity mismatch before project import")
        item = by_content.get(live["node_id"])
        if item is None:
            item = mutation(api, "addProjectV2ItemById", "AddProjectV2ItemByIdInput", {
                "projectId": pid, "contentId": live["node_id"]
            }, "item{id}")["item"]
        previous = field_values(item)
        kind = "Programa" if spec["key"] == "PROGRAM" else "Pacote" if "." in spec["key"] else "Epic"
        metadata = {"Status": "Backlog", "Etapa": "Programa" if kind == "Programa" else spec["key"][:2],
                    "Tipo": kind, "Area": spec.get("area", "architecture"), "Prioridade": spec.get("priority", "P0"),
                    "Risco": "Alto" if spec.get("external") or spec.get("priority", "P0") == "P0" else "Medio",
                    "Responsabilidade": ROLE[spec.get("area", "architecture")]}
        if "effort" in spec:
            metadata["Esforco"] = spec["effort"]
        pending = []
        for name, value in metadata.items():
            if name in previous:  # Preserve progress and user refinements on rerun.
                continue
            field = fields[name]
            if field["dataType"] == "SINGLE_SELECT":
                selected = [x for x in field["options"] if x["name"] == value]
                if len(selected) != 1:
                    raise ApiError("Field option missing: " + name)
                field_value = {"singleSelectOptionId": selected[0]["id"]}
            elif field["dataType"] == "NUMBER":
                field_value = {"number": value}
            elif field["dataType"] == "TEXT":
                field_value = {"text": value}
            else:
                raise ApiError("Field type mismatch: " + name)
            pending.append({
                "projectId": pid, "itemId": item["id"], "fieldId": field["id"], "value": field_value
            })
        if pending:
            declarations = ",".join(f"$i{i}:UpdateProjectV2ItemFieldValueInput!" for i in range(len(pending)))
            operations = " ".join(f"f{i}:updateProjectV2ItemFieldValue(input:$i{i}){{projectV2Item{{id}}}}" for i in range(len(pending)))
            api.graphql("mutation(" + declarations + "){" + operations + "}", {f"i{i}": data for i, data in enumerate(pending)})

    views = {x["name"]: x for x in connection(api, pid, "views", "id name layout")}
    visible_names = ["Title", "Status", "Etapa", "Prioridade", "Area", "Esforco", "Risco", "Responsabilidade", "Milestone"]
    visible = [fields[x]["id"] for x in visible_names if x in fields]
    for view in CONFIG["views"]:
        if view["name"] in views:
            continue
        created = mutation(api, "createProjectV2View", "CreateProjectV2ViewInput", {
            "projectId": pid, "name": view["name"], "layout": view["layout"], "configuration": {"visibleFieldIds": visible}
        }, "projectV2View{id}")["projectV2View"]
        mutation(api, "updateProjectV2View", "UpdateProjectV2ViewInput", {
            "viewId": created["id"], "filter": view["filter"]
        }, "projectV2View{id}")
    verified = connection(api, pid, "items", ITEM_FIELDS)
    present = {x["content"]["id"] for x in verified if x.get("content")}
    if not all(issues[mapping[x["key"]]["number"]]["node_id"] in present for x in manifest["items"]):
        raise ApiError("Project import verification failed")
    result = {"status": "created_or_reconciled", "url": project["url"], "number": project["number"],
              "private": True, "issues_verified": len(manifest["items"]), "views": len(CONFIG["views"])}
    (ROOT / "project-report.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8", newline="\n")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    if args.probe:
        try:
            api = GitHub()
            api.graphql('query{organization(login:"costaapps"){projectsV2(first:1){totalCount}}}')
            result = {"project_read_access": True, "write_access": "not verified"}
        except ApiError as exc:
            result = {"project_read_access": False, "reason": str(exc), "project_created": False}
        (ROOT / "project-access-report.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8", newline="\n")
        print(json.dumps(result))
        return
    if not args.apply:
        print(json.dumps({"mode": "dry-run", "organization": CONFIG["organization"], "title": CONFIG["title"],
                          "private_required": True, "fields": list(CONFIG["select_fields"]) + list(CONFIG["other_fields"]),
                          "views": CONFIG["views"]}, ensure_ascii=False))
        return
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    mapping = json.loads((ROOT / "issues-map.json").read_text(encoding="utf-8"))
    print(json.dumps(provision(GitHub(), manifest, mapping), ensure_ascii=False))


if __name__ == "__main__":
    main()
