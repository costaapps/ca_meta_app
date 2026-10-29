# M1.02 integrity report and executed synthetic dry-run

## Evidence boundary

The reviewed source snapshot is milestone base 54787a9f18c1cb88ed881bb3a5dd207077b2facf. Search covered the four versioned PHP references listed in M1.01 and found the database reads/writes summarized in [schema-legacy.md](schema-legacy.md). No production database, local sensitive PHP file, token value, provider account, or business data was read. Physical DDL, row counts, key constraints, values, and real conflicts are **Not confirmed**.

## Code-derived integrity checks required before import

| Check | Required key / treatment | Current evidence |
|---|---|---|
| Asset kind | accept only the explicit observed page-type literals; quarantine an unmapped kind | Unknown synthetic kind tested; physical enum values remain Not confirmed |
| Company ownership | resolve (IdDatabase, IdCompany) to one authorized tenant_id; never use IdDatabase alone | PHP obtains both values from Company; actual ownership map and uniqueness are Not confirmed |
| Same database, multiple companies | evaluate each company pair separately even when ExternalId matches | Covered by synthetic rows 1 and 2 |
| Asset duplicates | group by (tenant_id, kind, external_asset_id); quarantine all colliding rows pending resolution | Physical duplicate counts and unique indexes are Not confirmed |
| Parent link | resolve ParentChannelId / IdWaba inside the same tenant; quarantine missing, ambiguous or cross-tenant parent | Synthetic rows 8–10 cover missing, cross-tenant and wrong-kind parent cases; live relation integrity is Not confirmed |
| Expiry | distinguish provider-observed deadline, provider-explicitly-omitted deadline, and unknown; Never alone becomes unknown | Versioned WhatsApp code writes a Never sentinel; real provider provenance is absent |
| Credential reporting | report presence/counts by internal identifiers or protected handles only; never select or log values | No credentials were read; synthetic fixture rejects credential fields |
| Notifications | resolve a tenant owner beyond IdDatabase; inventory wildcard fields before projection | Current endpoint queries by IdDatabase and uses SELECT *; ownership and physical fields are Not confirmed |

The code includes ON DUPLICATE KEY UPDATE for page and number rows. Without catalog evidence, the uniqueness key and whether a conflict can cross tenants are **Not confirmed**. GeneralSettings has no reference in the reviewed versioned PHP and no field list is claimed.

## Executed experiment

Environment: Windows x64, PowerShell 7.6.5, Python 3.13.7. The harness uses only the Python standard library; it has no network/database driver or production connection path.

Commands:

    python -m py_compile tools/m1-02/dry_run.py tools/m1-02/test_dry_run.py
    python tools/m1-02/dry_run.py
    python -m unittest discover -s tools/m1-02 -p "test_*.py" -v

The fixture [m1-02-synthetic.json](fixtures/m1-02-synthetic.json) explicitly labels every row as synthetic, carries sourceVersion and projectionVersion metadata, and contains no credential/connection values. The harness rejected a test copy containing UserAccessToken. It is a deterministic classifier, not a data import tool; its output includes row ordinals/reason codes but not source row IDs, tenant IDs or external IDs.

Observed dry-run summary:

| Result | Count |
|---|---:|
| Synthetic source rows | 10 |
| Candidate rows bound to exactly one tenant | 3 |
| Quarantined rows | 7 |
| Duplicate rows quarantined inside one tenant/kind | 2 (one collision group) |
| Conflicting tenant mapping rows quarantined | 1 |
| Unmapped/orphan rows quarantined | 1 |
| Expiry with known provider deadline | 1 |
| Provider explicitly omitted expiry field | 1 |
| Unknown expiry, including legacy Never only | 1 |
| Database connections / writes | 0 / 0 |

Same-IdDatabase companies with a matching synthetic ExternalId remain separate candidates tied to distinct synthetic tenant IDs. A different database/company pair resolves independently. A conflicting pair has two synthetic tenant mappings with different last-login timestamps; neither timestamp is consulted, and its row is quarantined. The duplicate group and orphan row are also quarantined. Three child rows with a missing, cross-tenant, or wrong-kind parent are quarantined.

The unittest run passed **11 tests**: same-database isolation, different-database resolution, ambiguous/orphan quarantine, duplicate and parent-link quarantine, missing parent-type rule and unknown-kind quarantine, three expiry states, field-map coverage, pure/no-write behavior and fixture credential rejection.

## Remaining operational gate

The experiment proves only the proposed deterministic classification rules against invented fixtures. It does not prove production ownership, DDL, uniqueness, live row counts, migration completeness, provider validity, or credentials. Before any import: obtain authorized sanitized DDL/catalog evidence, prove notification ownership, inventory all wildcard notification fields and unique indexes, reconcile IdDatabase + IdCompany, and run the read-only plan against an approved snapshot. No issue closure or production migration is justified by this synthetic result.
