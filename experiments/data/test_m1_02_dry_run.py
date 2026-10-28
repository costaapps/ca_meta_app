import csv
import json
import re
import unittest
from pathlib import Path

from m1_02_dry_run import classify_expiry, run_dry_run, validate_expected


FIXTURE_PATH = Path(__file__).with_name("m1_02_fixture.json")
REPO_ROOT = Path(__file__).resolve().parents[2]


class M102DryRunTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        cls.result = run_dry_run(cls.fixture)

    def test_company_pairs_and_database_isolation(self):
        self.assertEqual(self.result["tenant_count"], 3)
        self.assertEqual(self.result["distinct_legacy_database_count"], 2)
        self.assertEqual(self.result["shared_database_company_pair_count"], 1)
        self.assertEqual(self.result["mapped_asset_count"], 3)
        self.assertEqual(self.result["mapped_tenant_count"], 3)
        self.assertTrue(
            all(
                row["legacy_company_uuid"] != row["tenant_id"]
                for row in self.fixture["tenants"]
            )
        )
        changed_aliases = json.loads(json.dumps(self.fixture))
        changed_aliases["tenants"][0]["legacy_company_uuid"], changed_aliases["tenants"][2][
            "legacy_company_uuid"
        ] = (
            changed_aliases["tenants"][2]["legacy_company_uuid"],
            changed_aliases["tenants"][0]["legacy_company_uuid"],
        )
        self.assertEqual(run_dry_run(changed_aliases)["mapped_asset_count"], 3)

    def test_ambiguous_and_duplicate_assets_are_quarantined(self):
        validate_expected(self.result, self.fixture["expected"])
        quarantine_reasons = {
            item["source_row_id"]: item["reason"]
            for item in self.result["quarantines"]
        }
        self.assertEqual(
            quarantine_reasons["ambiguous-incoming-1"], "ambiguous_tenant_match"
        )
        self.assertEqual(quarantine_reasons["duplicate-A-1"], "duplicate_asset_key")
        self.assertEqual(quarantine_reasons["duplicate-A-2"], "duplicate_asset_key")
        self.assertNotIn("tenant_id", self.result["quarantines"][0])

    def test_expiry_requires_provider_evidence(self):
        self.assertEqual(self.result["expiry_counts"]["KNOWN"], 1)
        self.assertEqual(self.result["expiry_counts"]["NO_DEADLINE_RETURNED"], 1)
        self.assertEqual(self.result["expiry_counts"]["UNKNOWN"], 4)
        self.assertEqual(
            classify_expiry(
                {
                    "provider_observation": "missing",
                    "deadline_result": "unknown",
                    "legacy_value": "Never",
                }
            ),
            "UNKNOWN",
        )

    def test_runner_is_synthetic_and_has_no_external_effects(self):
        self.assertTrue(self.result["synthetic"])
        self.assertFalse(self.result["writes_performed"])
        self.assertFalse(self.result["provider_calls_performed"])

    def test_field_mapping_rows_have_valid_source_references(self):
        mapping_path = REPO_ROOT / "specs/data/m1.02/field-mapping.csv"
        with mapping_path.open(newline="", encoding="utf-8") as stream:
            rows = list(csv.DictReader(stream))
        self.assertEqual(len(rows), 45)
        self.assertEqual(len(rows[0]), 9)
        self.assertTrue(all(row["source_refs"].strip() for row in rows))

        required_fields = {
            ("ProjectionContract", "tenant_id"),
            ("ProjectionContract", "legacy_database_id"),
            ("ProjectionContract", "legacy_company_id"),
            ("ProjectionContract", "external_asset_id"),
            ("ProjectionContract", "source_version"),
            ("ProjectionContract", "projection_version"),
        }
        mapped_fields = {(row["source_table"], row["source_column"]) for row in rows}
        self.assertTrue(required_fields.issubset(mapped_fields))

        validated_references = 0
        for row in rows:
            for reference in row["source_refs"].split("; "):
                match = re.match(r"^(.*?):([0-9][0-9,-]*)$", reference)
                if not match:
                    continue
                source_path, locations = match.groups()
                source_file = REPO_ROOT / source_path
                self.assertTrue(source_file.is_file(), source_path)
                line_count = len(source_file.read_text(encoding="utf-8").splitlines())
                for location in locations.split(","):
                    bounds = [int(part) for part in location.split("-", 1)]
                    self.assertLessEqual(1, bounds[0], (source_path, location))
                    self.assertLessEqual(bounds[-1], line_count, (source_path, location))
                validated_references += 1
        self.assertEqual(validated_references, 81)

    def test_fixture_has_no_credential_values_or_fields(self):
        def assert_no_credential_keys(value):
            if isinstance(value, dict):
                for key, nested in value.items():
                    self.assertFalse(
                        any(
                            secret in key.lower()
                            for secret in ("token", "secret", "password", "oauth")
                        ),
                        key,
                    )
                    assert_no_credential_keys(nested)
            elif isinstance(value, list):
                for nested in value:
                    assert_no_credential_keys(nested)

        assert_no_credential_keys(self.fixture)

    def test_required_artifacts_have_no_trailing_whitespace(self):
        artifacts = [
            REPO_ROOT / "specs/data/m1.02/schema-legacy.md",
            REPO_ROOT / "specs/data/m1.02/field-mapping.csv",
            REPO_ROOT / "specs/data/m1.02/integrity-report.md",
            REPO_ROOT / "specs/data/m1.02/read-only-query-plan.md",
            REPO_ROOT / "experiments/data/m1_02_fixture.json",
            REPO_ROOT / "experiments/data/m1_02_dry_run.py",
            REPO_ROOT / "experiments/data/test_m1_02_dry_run.py",
        ]
        for artifact in artifacts:
            self.assertTrue(artifact.is_file(), str(artifact))
            for number, line in enumerate(
                artifact.read_text(encoding="utf-8").splitlines(), start=1
            ):
                self.assertEqual(line, line.rstrip(" \t"), f"{artifact}:{number}")

    def test_deliverables_have_no_token_or_tenant_uuid_shaped_values(self):
        artifacts = [
            REPO_ROOT / "specs/data/m1.02/schema-legacy.md",
            REPO_ROOT / "specs/data/m1.02/field-mapping.csv",
            REPO_ROOT / "specs/data/m1.02/integrity-report.md",
            REPO_ROOT / "specs/data/m1.02/read-only-query-plan.md",
            REPO_ROOT / "experiments/data/m1_02_fixture.json",
            REPO_ROOT / "experiments/data/m1_02_dry_run.py",
            REPO_ROOT / "experiments/data/test_m1_02_dry_run.py",
        ]
        patterns = (
            re.compile(r"\bEA[A-Za-z0-9]{20,}\b"),
            re.compile(
                r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
            ),
        )
        for artifact in artifacts:
            content = artifact.read_text(encoding="utf-8")
            for pattern in patterns:
                self.assertIsNone(pattern.search(content), str(artifact))


if __name__ == "__main__":
    unittest.main()
