import copy
import unittest
from unittest.mock import patch
from catalog import load_catalog
from validate import validate_catalog
from github_api import ApiError, GitHub, REPOSITORY
from sync_relationships import synchronize
from project import options, field_values, provision
from contracts import build_api, validate_references


class FakeAPI:
    def __init__(self):
        self.issues = []
        self.edges = {}
        self.writes = []

    def pages(self, path):
        if path.endswith("/issues?state=all"):
            return self.issues
        return self.edges.get(path, []).copy()

    def request(self, method, path, data=None):
        assert method == "POST"
        self.writes.append((path, data))
        issue_id = data.get("sub_issue_id", data.get("issue_id"))
        self.edges.setdefault(path, []).append({"id": issue_id})
        return {"id": issue_id}


def small_fixture():
    items = [{"key": "PROGRAM", "title": "program"},
             {"key": "M1", "title": "epic", "milestone": 1, "parent": "PROGRAM"},
             {"key": "M1.01", "title": "first", "milestone": 1, "parent": "M1", "deps": []},
             {"key": "M1.02", "title": "second", "milestone": 1, "parent": "M1", "deps": ["M1.01"]}]
    manifest = {"repository": REPOSITORY, "items": items}
    mapping = {x["key"]: {"number": i + 10} for i, x in enumerate(items)}
    api = FakeAPI()
    api.issues = [{"id": 100 + i, "number": mapping[x["key"]]["number"], "title": x["title"],
                   "body": f'<!-- meta-v2-key: {x["key"]} -->', "labels": [{"name": "program:meta-v2"}],
                   "milestone": {"number": 1} if x.get("milestone") else None}
                  for i, x in enumerate(items)]
    return api, manifest, mapping


class PlanningTests(unittest.TestCase):
    def test_full_catalog_has_acyclic_complete_dependencies(self):
        tasks = load_catalog()
        waves = validate_catalog(tasks)
        self.assertEqual(66, len(tasks))
        self.assertEqual(280, sum(len(x["deps"]) for x in tasks))
        self.assertEqual(66, sum(map(len, waves)))

    def test_missing_dependency_rejected(self):
        tasks = copy.deepcopy(load_catalog())
        tasks[0]["deps"] = ["DOES_NOT_EXIST"]
        with self.assertRaises(ValueError):
            validate_catalog(tasks)

    def test_cycle_rejected(self):
        tasks = copy.deepcopy(load_catalog())
        tasks[0]["deps"] = ["M1.02"]
        with self.assertRaises(ValueError):
            validate_catalog(tasks)

    def test_native_sync_adds_and_verifies_expected_edges(self):
        api, manifest, mapping = small_fixture()
        report = synchronize(api, manifest, mapping)
        self.assertEqual(3, report["hierarchy_edges_verified"])
        self.assertEqual(1, report["dependency_edges_verified"])
        self.assertEqual(4, len(api.writes))
        self.assertTrue(all("replace_parent" not in data for _, data in api.writes))

    def test_native_sync_rerun_does_not_duplicate_mutations(self):
        api, manifest, mapping = small_fixture()
        synchronize(api, manifest, mapping)
        api.writes.clear()
        report = synchronize(api, manifest, mapping)
        self.assertEqual([], api.writes)
        self.assertEqual(0, report["hierarchy_edges_added"] + report["dependency_edges_added"])

    def test_identity_mismatch_rejected_before_any_mutation(self):
        api, manifest, mapping = small_fixture()
        api.issues[-1]["title"] = "unrelated work"
        with self.assertRaises(ApiError):
            synchronize(api, manifest, mapping)
        self.assertEqual([], api.writes)

    def test_repository_mismatch_rejected_before_any_mutation(self):
        api, manifest, mapping = small_fixture()
        manifest["repository"] = "other/repo"
        with self.assertRaises(ApiError):
            synchronize(api, manifest, mapping)
        self.assertEqual([], api.writes)

    def test_wrong_milestone_rejected_before_any_mutation(self):
        api, manifest, mapping = small_fixture()
        api.issues[-1]["milestone"]["number"] = 2
        with self.assertRaises(ApiError):
            synchronize(api, manifest, mapping)
        self.assertEqual([], api.writes)

    def test_project_option_ids_preserved(self):
        result = options(["Backlog", "Done"], [{"name": "Done", "id": "existing"}])
        self.assertEqual("existing", result[1]["id"])
        self.assertNotIn("id", result[0])

    def test_project_reads_existing_progress(self):
        item = {"fieldValues": {"nodes": [{"name": "In progress", "field": {"name": "Status"}}, {"number": 8, "field": {"name": "Esforco"}}]}}
        self.assertEqual({"Status": "In progress", "Esforco": 8}, field_values(item))

    def test_public_project_cannot_import_private_metadata(self):
        with patch("project.find_or_create", return_value={"id": "p", "public": True}):
            with self.assertRaises(ApiError):
                provision(object(), {}, {})

    def test_api_refuses_external_host_before_network(self):
        with patch.dict("os.environ", {"GITHUB_REPOSITORY": REPOSITORY}):
            api = GitHub(token="synthetic-test-token")
        with self.assertRaises(ApiError):
            api.request("POST", "https://example.invalid/steal", {})

    def test_proposed_contract_references_and_operation_ids(self):
        api = build_api()
        validate_references(api)
        ids = [op["operationId"] for path in api["paths"].values() for method, op in path.items()
               if method in ["get", "post", "delete", "patch"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(28, len(ids))

    def test_connection_and_asset_ids_have_separate_contracts(self):
        api = build_api()
        response = api["paths"]["/connections"]["get"]["responses"]["200"]
        self.assertEqual("#/components/schemas/ConnectionPage", response["content"]["application/json"]["schema"]["$ref"])
        self.assertIn("asset", api["components"]["schemas"]["Connection"]["properties"])
        self.assertIn("servers", api["paths"]["/internal/v1/assets/{id}/operations"])

    def test_public_response_schemas_have_no_permanent_secret_fields(self):
        api = build_api()
        forbidden = {"access_token", "accessToken", "client_secret", "appSecret", "ciphertext", "auth_tag", "privateKey"}
        def inspect(schema, seen=None):
            seen = set() if seen is None else seen
            if isinstance(schema, dict):
                if "$ref" in schema:
                    name = schema["$ref"].split("/")[-1]
                    if name not in seen:
                        seen.add(name)
                        inspect(api["components"]["schemas"][name], seen)
                self.assertTrue(forbidden.isdisjoint(schema.get("properties", {})))
                for value in schema.values():
                    inspect(value, seen)
            elif isinstance(schema, list):
                for value in schema:
                    inspect(value, seen)
        for path in api["paths"].values():
            for method, op in path.items():
                if method in ["get", "post", "delete", "patch"]:
                    inspect(op.get("responses", {}))


if __name__ == "__main__":
    unittest.main()
