# MeshKor Healthcare — Phase 1: Ohio CMS Reference Master

**Status:** Initial ingestion and lookup implementation, not yet a populated national/Ohio reference database. The public marketing site remains untouched. No live claim adjudication or certified AIN runtime is included.

## Intended Phase 1 deliverable

As described in the MeshKor architecture guide, Phase 1 is the local `data/cms/` collection of ZSTD Parquet references to support Ohio provider/CPT lookups: NPPES, Medicare Physician Fee Schedule (MPFS), Hospital OPPS/ASC Addendum B, HCRIS and Medicare NCCI edits. These are distinct feeds; they do not share one uniform raw CSV schema.

This initial implementation provides:

- Constant-memory CSV iteration, including streamed ZIP member reading.
- Ohio practice-location filtering of the NPPES dissemination file.
- Canonical CSV import adapters for the other five datasets, including per-source mappings.
- ZSTD Parquet outputs, provenance with SHA-256 of each input and source member.
- DuckDB exact-match lookup by NPI, HCPCS, locality and effective date, leaving unavailable values empty instead of guessing.
- Offline fixtures and smoke tests.

**Not completed:** downloading and parsing all actual CMS releases, raw fixed-width PFS conversions, OPPS Excel normalization, HCRIS RPT/NMRC/ALPHNMRC reconstruction, NCCI ZIP text normalization, authoritative CMS locality mapping, cost-center ratio calculations, 2026-specific reconciliations, integration tests with verified official source files, performance benchmarks, or production readiness. Do not describe this as a completed Phase 1 data load.

## Official CMS source landing pages (verify year/release before import)

- NPPES downloads: https://download.cms.gov/nppes/NPI_Files.html
- Medicare PFS RVU releases: https://www.cms.gov/medicare/payment/fee-schedules/physician/pfs-relative-value-files
- Hospital OPPS quarterly Addenda A/B: https://www.cms.gov/medicare/payment/prospective-payment-systems/hospital-outpatient-pps/quarterly-addenda-updates
- HCRIS cost report extracts: https://www.cms.gov/data-research/statistics-trends-and-reports/cost-reports
- Medicare NCCI PTP edits: https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-procedure-procedure-ptp-edits

**Source licensing:** Check CMS package notices and AMA CPT licensing restrictions before redistribution. No CMS data files or sensitive information are committed here.

## Setup

Use Linux/macOS/Windows WSL2; Python 3.12+.

```bash
cd healthcare_backend/phase1
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pytest -q
```

On Windows PowerShell activate `.venv\\Scripts\\Activate.ps1`.

## Import NPPES (official CMS dissemination CSV)

Download NPPES from CMS; point to the ZIP containing the main CSV (some releases contain multiple CSV members: specify `--member` with the exact member path).

```bash
python cms_reference.py ingest --kind nppes --input /secure/downloads/nppes.zip --member npidata_pfile_20050523-20261011.csv
```

The filename in the example is illustrative; use the real entry shown by `unzip -l`. NPPES state is based on provider *business-practice location*, not a claim that the provider only serves Ohio.

## Import standardized MPFS example

MPFS PFS fee amounts are **not interchangeable with relative value units**. Use the right CMS release, amount file, locality, place-of-service setting and applicable clinician payment factor. Normalize to:

```csv
hcpcs,modifier,locality,setting,effective_date,amount
99213,,EXAMPLE_LOCALITY,facility,2026-01-01,72.50
```

The row above is synthetic for testing; it is not a CMS Medicare rate.

```bash
python cms_reference.py ingest --kind pfs --input /secure/normalized/pfs_ohio.csv
python cms_reference.py lookup --npi 1234567890 --hcpcs 99213 --locality EXAMPLE_LOCALITY --date 2026-10-01
```

When importing an official exported CSV with different headers, provide a mapping JSON with canonical keys, e.g.:

```json
{"hcpcs":"HCPCS CODE","modifier":"MODIFIER","locality":"LOCALITY","setting":"SETTING","effective_date":"START DATE","amount":"PAYMENT AMOUNT"}
```

Use `--mapping /path/to/mapping.json`. Real CMS datasets may require a separate preparatory converter and explicit validation of dates and payment categories; the import tool does **not** infer those fields.

Other canonical headers:

| Kind | Canonical CSV columns |
| --- | --- |
| `opps` | hcpcs, apc, status_indicator, effective_date, national_rate |
| `asc` | hcpcs, effective_date, national_rate |
| `hcris` | ccn, report_end_date, cost, charges |
| `ncci` | code1, code2, modifier_indicator, effective_date, deletion_date |

All dates use YYYY-MM-DD, and NCCI rows are only candidates for an edit evaluation, **not** automatic denial determinations. HCRIS rows are cost/charges source values, not validated department-specific cost-to-charge ratios. Some HCRIS codes and CMS rate formats may be more complex than these canonical imports and require additional normalization.

For imports, output is `data/cms/<kind>/data.parquet` plus `provenance.json`; this path is Git-ignored. Reimport atomically replaces that one dataset. Each kind can be imported independently.

## Acceptance gates before Phase 1 is marked complete

1. Download *actual* applicable official CMS files and record their release/effective dates, URLs and checksums.
2. Implement raw-source adapters for the specific 2026 formats instead of requiring manual normalization.
3. Validate sample NPI/taxonomy and Ohio locality/CPT rates against official CMS lookups (facility and nonfacility, dates, modifiers).
4. Confirm HCRIS relationships and published cost-to-charge calculations, NCCI modifier and deletion rules, and OPPS/ASC payment basis.
5. Benchmark Ohio data loads and lookups, check Parquet reproducibility, document failures and re-runs.

**Security:** This pipeline uses public CMS reference data only. Never upload EDI 837/835 or PHI into this data factory.
