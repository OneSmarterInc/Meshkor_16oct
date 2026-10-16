"""Ohio CMS reference data importer. All external data must be official and user-supplied.

This module never invents a Medicare payment amount, NCCI result, or hospital CCR.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

OHIO = "OH"
BATCH = 25_000
SCHEMAS = {
    "nppes": {"npi": "string", "state": "string", "entity_type": "string",
              "organization": "string", "taxonomy": "string"},
    "pfs": {"hcpcs": "string", "modifier": "string", "locality": "string",
            "setting": "string", "effective_date": "string", "amount": "decimal"},
    "opps": {"hcpcs": "string", "apc": "string", "status_indicator": "string",
             "effective_date": "string", "national_rate": "decimal"},
    "asc": {"hcpcs": "string", "effective_date": "string", "national_rate": "decimal"},
    "hcris": {"ccn": "string", "report_end_date": "string", "cost": "decimal",
              "charges": "decimal"},
    "ncci": {"code1": "string", "code2": "string", "modifier_indicator": "string",
             "effective_date": "string", "deletion_date": "string"},
}
# These are CANONICAL INPUT FIELDS, not claims about raw CMS layouts.
# Different CMS packages/quarters have distinct layouts. Convert vendor files into
# these documented schemas first, then use --mapping or identical column names.
def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(data)
    return h.hexdigest()

def arrow_schema(kind: str) -> pa.Schema:
    types = {"string": pa.string(), "decimal": pa.float64()}
    return pa.schema([(key, types[typ]) for key, typ in SCHEMAS[kind].items()])

def rows_from_file(source: Path, member: str | None = None):
    """Iterate without loading whole CSV into RAM; ZIP members stream too."""
    import io
    if source.suffix.lower() == ".zip":
        with zipfile.ZipFile(source) as archive:
            options = [x for x in archive.namelist() if x.lower().endswith(".csv")]
            if member is None:
                if len(options) != 1:
                    raise ValueError(f"ZIP has {len(options)} CSVs. Choose --member from: {options[:20]}")
                member = options[0]
            if member not in options:
                raise ValueError(f"Invalid member {member!r}")
            with archive.open(member) as binary:
                with io.TextIOWrapper(binary, encoding="utf-8-sig", errors="replace", newline="") as stream:
                    yield from csv.DictReader(stream)
    else:
        with source.open(encoding="utf-8-sig", errors="replace", newline="") as stream:
            yield from csv.DictReader(stream)

def nppes_row(raw: dict) -> dict | None:
    state = (raw.get("Provider Business Practice Location Address State Name") or "").strip().upper()
    npi = (raw.get("NPI") or "").strip()
    if state != OHIO or not re.fullmatch(r"\d{10}", npi):
        return None
    taxonomies = [raw.get(f"Healthcare Provider Taxonomy Code_{i}", "").strip() for i in range(1, 16)]
    return {
        "npi": npi, "state": OHIO,
        "entity_type": (raw.get("Entity Type Code") or "").strip(),
        "organization": (raw.get("Provider Organization Name (Legal Business Name)") or "").strip(),
        "taxonomy": next((v for v in taxonomies if v), ""),
    }

def normalized_row(raw: dict, kind: str, mapping: dict) -> dict | None:
    if kind == "nppes":
        return nppes_row(raw)
    fields = SCHEMAS[kind]
    row = {}
    for name, dtype in fields.items():
        col = mapping.get(name, name)
        value = (raw.get(col) or "").strip()
        if name in {"hcpcs", "code1", "code2"}:
            value = value.upper()
        if dtype == "decimal":
            if value:
                try:
                    value = float(value.replace(",", "").replace("$", ""))
                except ValueError as exc:
                    raise ValueError(f"Invalid numeric field {col}: {value}") from exc
                if value < 0:
                    raise ValueError(f"Negative monetary field {col}")
            else:
                value = None
        row[name] = value if value != "" else None
    required = {
        "pfs": ["hcpcs", "locality", "setting", "effective_date", "amount"],
        "opps": ["hcpcs", "effective_date"],
        "asc": ["hcpcs", "effective_date"],
        "hcris": ["ccn", "report_end_date", "cost", "charges"],
        "ncci": ["code1", "code2", "effective_date"],
    }[kind]
    if any(row.get(x) is None for x in required):
        return None
    if kind == "hcris" and row["charges"] <= 0:
        return None
    if kind == "pfs" and row["setting"] not in {"facility", "nonfacility"}:
        raise ValueError("PFS setting must be facility or nonfacility")
    return row

def ingest(source: Path, kind: str, out: Path, mapping: dict, member: str | None) -> dict:
    if not source.is_file():
        raise FileNotFoundError(source)
    target_dir = out / kind
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / "data.parquet"
    tmp = target.with_suffix(".parquet.tmp")
    count = skipped = 0
    writer = None
    batch = []
    schema = arrow_schema(kind)
    try:
        for raw in rows_from_file(source, member):
            item = normalized_row(raw, kind, mapping)
            if item is None:
                skipped += 1
                continue
            batch.append(item)
            if len(batch) >= BATCH:
                writer = flush_batch(batch, schema, tmp, writer)
                count += len(batch)
                batch.clear()
        if batch:
            writer = flush_batch(batch, schema, tmp, writer)
            count += len(batch)
        if writer is None:
            raise ValueError("No valid matching records; existing output preserved")
        writer.close()
        writer = None
        tmp.replace(target)
    finally:
        if writer:
            writer.close()
        tmp.unlink(missing_ok=True)
    metadata = {
        "kind": kind, "rows": count, "filtered_or_incomplete_rows": skipped,
        "source_name": source.name, "source_sha256": sha256(source),
        "imported_at_utc": datetime.now(timezone.utc).isoformat(),
        "source_member": member, "mapping": mapping,
        "scope": "Ohio business-practice-location" if kind == "nppes" else "source-defined",
        "note": "No patient records. Financial figures are source supplied; not claim adjudications.",
    }
    (target_dir / "provenance.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return metadata

def flush_batch(rows: list, schema: pa.Schema, target: Path, writer):
    if writer is None:
        writer = pq.ParquetWriter(target, schema, compression="zstd")
    writer.write_table(pa.Table.from_pylist(rows, schema=schema))
    return writer

def lookup(root: Path, npi: str, hcpcs: str, locality: str, date: str) -> dict:
    """Exact-match ONLY; unknown monetary amounts remain unknown."""
    db = duckdb.connect(":memory:")
    answer = {"npi": npi, "hcpcs": hcpcs, "locality": locality,
              "as_of": date, "provider": [], "pfs": [], "opps": [], "asc": [], "ncci": []}
    tables = {
        "provider": ("nppes", "npi = ?", [npi]),
        "pfs": ("pfs", "hcpcs = ? AND locality = ? AND effective_date <= ?", [hcpcs, locality, date]),
        "opps": ("opps", "hcpcs = ? AND effective_date <= ?", [hcpcs, date]),
        "asc": ("asc", "hcpcs = ? AND effective_date <= ?", [hcpcs, date]),
        "ncci": ("ncci", "(code1 = ? OR code2 = ?) AND effective_date <= ? AND (deletion_date IS NULL OR deletion_date = '' OR deletion_date >= ?)", [hcpcs, hcpcs, date, date]),
    }
    for key, (folder, condition, params) in tables.items():
        path = root / folder / "data.parquet"
        if not path.is_file():
            continue
        path_string = str(path).replace("'", "''")
        result = db.execute(f"SELECT * FROM read_parquet('{path_string}') WHERE {condition} LIMIT 100", params)
        names = [d[0] for d in result.description]
        answer[key] = [dict(zip(names, row)) for row in result.fetchall()]
    db.close()
    return answer

def main():
    parser = argparse.ArgumentParser(description="CMS Ohio Reference Master (Phase 1)")
    sub = parser.add_subparsers(dest="command", required=True)
    a = sub.add_parser("ingest", help="Import official CMS CSV or CSV inside ZIP")
    a.add_argument("--kind", choices=sorted(SCHEMAS), required=True)
    a.add_argument("--input", type=Path, required=True)
    a.add_argument("--output", type=Path, default=Path("data/cms"))
    a.add_argument("--mapping", type=Path, help="JSON mapping of canonical to CSV column headings")
    a.add_argument("--member", help="CSV member filename within ZIP")
    b = sub.add_parser("lookup", help="Retrieve provider and published baselines")
    b.add_argument("--root", type=Path, default=Path("data/cms"))
    b.add_argument("--npi", required=True)
    b.add_argument("--hcpcs", required=True)
    b.add_argument("--locality", required=True, help="CMS locality code; never inferred from state alone")
    b.add_argument("--date", required=True, help="As-of date YYYY-MM-DD")
    args = parser.parse_args()
    if args.command == "ingest":
        mapping = json.loads(args.mapping.read_text()) if args.mapping else {}
        if set(mapping) - set(SCHEMAS[args.kind]):
            parser.error("Mapping contains unknown canonical columns")
        print(json.dumps(ingest(args.input, args.kind, args.output, mapping, args.member), indent=2))
    else:
        print(json.dumps(lookup(args.root, args.npi, args.hcpcs.upper(), args.locality, args.date), indent=2))

if __name__ == "__main__":
    main()
