import json
import sys
import unittest
from copy import deepcopy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from dry_run import dry_run, main  # noqa: E402


FIXTURE = Path(__file__).parents[2] / "docs" / "meta-v2" / "fixtures" / "m1-02-synthetic.json"


class DryRunTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def test_same_database_companies_are_separate_even_with_same_external_id(self):
        result = dry_run(self.fixture)
        first, second = result["rows"][:2]
        self.assertEqual(first["disposition"], "candidate")
        self.assertEqual(second["disposition"], "candidate")
        self.assertEqual(self.fixture["records"][0]["externalId"], self.fixture["records"][1]["externalId"])
        self.assertNotEqual(
            (self.fixture["records"][0]["legacyDatabaseId"], self.fixture["records"][0]["legacyCompanyId"]),
            (self.fixture["records"][1]["legacyDatabaseId"], self.fixture["records"][1]["legacyCompanyId"]),
        )
        self.assertNotIn("externalId", first)
        self.assertNotIn("targetTenantId", first)

    def test_different_database_pair_resolves_to_its_own_tenant(self):
        result = dry_run(self.fixture)
        third = result["rows"][2]
        self.assertEqual(third["disposition"], "candidate")
        self.assertEqual(
            (self.fixture["records"][2]["legacyDatabaseId"], self.fixture["records"][2]["legacyCompanyId"]),
            ("db-syn-02", "company-syn-03"),
        )
        self.assertNotIn("targetTenantId", third)

    def test_ambiguous_and_orphan_mappings_are_quarantined_without_recency_choice(self):
        result = dry_run(self.fixture)
        ambiguous, orphan = result["rows"][3], result["rows"][6]
        self.assertEqual(ambiguous["reason"], "tenant_mapping_conflict")
        self.assertEqual(orphan["reason"], "tenant_mapping_missing")
        self.assertNotIn("targetTenantId", ambiguous)
        self.assertNotIn("targetTenantId", orphan)

    def test_duplicate_asset_key_within_one_tenant_quarantines_all_rows(self):
        result = dry_run(self.fixture)
        left, right = result["rows"][4:6]
        self.assertEqual(left["reason"], "duplicate_asset_within_tenant")
        self.assertEqual(right["reason"], "duplicate_asset_within_tenant")
        self.assertEqual(result["duplicateTenantAssetGroups"], 1)

    def test_missing_cross_tenant_and_wrong_kind_parents_are_quarantined(self):
        result = dry_run(self.fixture)
        missing, cross_tenant, wrong_kind = result["rows"][7:10]
        self.assertEqual(missing["reason"], "parent_row_missing")
        self.assertEqual(cross_tenant["reason"], "parent_cross_tenant")
        self.assertEqual(wrong_kind["reason"], "parent_type_conflict")

    def test_expiry_provenance_keeps_known_no_deadline_and_unknown_distinct(self):
        result = dry_run(self.fixture)
        self.assertEqual(
            result["expiryObservations"],
            {"known": 1, "no_deadline_returned": 1, "unknown": 1},
        )

    def test_dry_run_is_pure_and_reports_zero_external_writes(self):
        before = deepcopy(self.fixture)
        result = dry_run(self.fixture)
        self.assertEqual(self.fixture, before)
        self.assertEqual(result["writesPerformed"], 0)
        self.assertEqual(result["sourceVersion"], "synthetic-snapshot-v1")
        self.assertEqual(result["projectionVersion"], "synthetic-projection-v1")
        self.assertEqual(result["databaseConnections"], 0)
        self.assertEqual(result["sourceRows"], 10)
        self.assertTrue(all("sourceRowId" not in row and "externalId" not in row for row in result["rows"]))
        self.assertEqual(result["candidateRows"], 3)
        self.assertEqual(result["quarantinedRows"], 7)

    def test_unknown_asset_kind_is_quarantined(self):
        unknown = deepcopy(self.fixture)
        unknown["records"][0]["type"] = "UNMAPPED_SYNTHETIC_KIND"
        result = dry_run(unknown)
        self.assertEqual(result["rows"][0]["disposition"], "quarantine")
        self.assertEqual(result["rows"][0]["reason"], "unknown_asset_kind")

    def test_child_without_parent_type_rule_is_quarantined(self):
        missing_rule = deepcopy(self.fixture)
        del missing_rule["records"][8]["expectedParentType"]
        result = dry_run(missing_rule)
        self.assertEqual(result["rows"][8]["disposition"], "quarantine")
        self.assertEqual(result["rows"][8]["reason"], "parent_type_rule_missing")

    def test_whatsapp_phone_requires_same_tenant_waba_parent(self):
        valid_link = deepcopy(self.fixture)
        valid_link["records"][7]["parentSourceRowId"] = "synthetic-row-03"
        self.assertEqual(dry_run(valid_link)["rows"][7]["disposition"], "candidate")

        missing_parent = deepcopy(self.fixture)
        del missing_parent["records"][7]["parentSourceRowId"]
        result = dry_run(missing_parent)
        self.assertEqual(result["rows"][7]["disposition"], "quarantine")
        self.assertEqual(result["rows"][7]["reason"], "parent_row_missing")

        wrong_rule = deepcopy(self.fixture)
        wrong_rule["records"][8]["expectedParentType"] = "FACEBOOK"
        result = dry_run(wrong_rule)
        self.assertEqual(result["rows"][8]["disposition"], "quarantine")
        self.assertEqual(result["rows"][8]["reason"], "parent_type_rule_conflict")

    def test_unreviewed_source_versions_are_rejected(self):
        for field in ("sourceVersion", "projectionVersion"):
            with self.subTest(field=field):
                changed_version = deepcopy(self.fixture)
                changed_version[field] = "snapshot-from-elsewhere"
                with self.assertRaisesRegex(ValueError, "reviewed synthetic fixture"):
                    dry_run(changed_version)

    def test_cli_rejects_alternate_fixture_path(self):
        original_argv = sys.argv
        try:
            sys.argv = ["dry_run.py", "--fixture", "outside-synthetic-fixture.json"]
            with self.assertRaises(SystemExit) as error:
                main()
            self.assertEqual(error.exception.code, 2)
        finally:
            sys.argv = original_argv

    def test_fixture_cannot_contain_credential_or_connection_values(self):
        unsafe = deepcopy(self.fixture)
        unsafe["records"][0]["UserAccessToken"] = "synthetic-value"
        with self.assertRaisesRegex(ValueError, "prohibited credential"):
            dry_run(unsafe)


    def test_field_mapping_covers_every_code_observed_source_field(self):
        import csv

        csv_path = Path(__file__).parents[2] / "docs" / "meta-v2" / "field-mapping.csv"
        with csv_path.open(encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.DictReader(handle))

        actual = {(row["source_table"], row["source_field"]) for row in rows}
        required = {
            ("Company", "CompanyUUID"), ("Company", "IdDatabase"), ("Company", "IdCompany"),
            ("Databases", "IdDatabase"), ("Databases", "CompanyUUID"),
            ("MetaConnectedPages", "IdDatabase"), ("MetaConnectedPages", "IdCompany"),
            ("MetaConnectedPages", "Id"), ("MetaConnectedPages", "Type"),
            ("MetaConnectedPages", "ExternalId"), ("MetaConnectedPages", "ExternalName"),
            ("MetaConnectedPages", "ProfilePicture"), ("MetaConnectedPages", "UserAccessToken"),
            ("MetaConnectedPages", "PageAccessToken"), ("MetaConnectedPages", "ExpiresUserAccessTokenAt"),
            ("MetaConnectedPages", "ExpiresPageAccessTokenAt"), ("MetaConnectedPages", "ParentChannelId"),
            ("MetaConnectedPages", "ConnectedAt"), ("MetaConnectedPages", "PrivateWelcomeMessage"),
            ("MetaConnectedPages", "CommentPublicReply"), ("MetaConnectedPages", "CommentPrivateReply"),
            ("MetaConnectedNumbers", "Id"), ("MetaConnectedNumbers", "IdWaba"),
            ("MetaConnectedNumbers", "ExternalId"), ("MetaConnectedNumbers", "DisplayPhoneNumber"),
            ("MetaConnectedNumbers", "VerifiedName"), ("MetaConnectedNumbers", "QualityRating"),
            ("MetaConnectedNumbers", "ConnectedAt"),
            ("MetaAppReviewNotifications", "Id"), ("MetaAppReviewNotifications", "IdDatabase"),
            ("MetaAppReviewNotifications", "IsRead"), ("MetaAppReviewNotifications", "CreatedAt"),
            ("MetaAppReviewNotifications", "PlatformType"), ("MetaAppReviewNotifications", "OriginId"),
            ("MetaAppReviewNotifications", "DestinationId"), ("MetaAppReviewNotifications", "*"),
            ("GeneralSettings", "*"),
            ("migration_contract", "tenant_id"), ("migration_contract", "legacy_database_id"),
            ("migration_contract", "legacy_company_id"), ("migration_contract", "source_version"),
            ("migration_contract", "projection_version"),
        }
        self.assertTrue(required.issubset(actual), f"Missing mappings: {sorted(required - actual)}")
        self.assertTrue(all(row["proposed_destination"] and row["conversion_and_conflict_policy"] for row in rows))
        destinations = {row["proposed_destination"] for row in rows}
        self.assertTrue(any("external_asset_id" in destination for destination in destinations))
        self.assertIn("LegacyAssetMap.source_version", destinations)
        self.assertIn("LegacyAssetMap.projection_version", destinations)


if __name__ == "__main__":
    unittest.main()
