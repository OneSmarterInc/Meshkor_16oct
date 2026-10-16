import csv
import json
import zipfile
from pathlib import Path

import pytest
from cms_reference import ingest, lookup, nppes_row, normalized_row

def test_nppes_ohio_filter_and_taxonomy():
    source = {
        "NPI": "1234567890",
        "Provider Business Practice Location Address State Name": "OH",
        "Entity Type Code": "2",
        "Provider Organization Name (Legal Business Name)": "Example Hospital",
        "Healthcare Provider Taxonomy Code_1": "282N00000X",
    }
    assert nppes_row(source)["taxonomy"] == "282N00000X"
    assert nppes_row({**source, "Provider Business Practice Location Address State Name": "IN"}) is None
    assert nppes_row({**source, "NPI": "invalid"}) is None

def test_pfs_rejects_invalid_setting():
    with pytest.raises(ValueError, match="setting"):
        normalized_row({"hcpcs": "99213", "locality": "00", "setting": "unknown",
                        "effective_date": "2026-01-01", "amount": "90.00"}, "pfs", {})

def test_ingest_and_lookup(tmp_path):
    source = tmp_path / "pfs.csv"
    source.write_text(
        "hcpcs,modifier,locality,setting,effective_date,amount\n"
        "99213,,OHIO-LOCALITY,facility,2026-01-01,72.5\n", encoding="utf-8")
    root = tmp_path / "data"
    meta = ingest(source, "pfs", root, {}, None)
    assert meta["rows"] == 1
    assert len(meta["source_sha256"]) == 64
    data = lookup(root, "1234567890", "99213", "OHIO-LOCALITY", "2026-10-01")
    assert data["pfs"][0]["amount"] == 72.5
    assert not data["provider"]
    assert not lookup(root, "1234567890", "99213", "WRONG", "2026-10-01")["pfs"]

def test_nppes_streaming_zip(tmp_path):
    csvdata = (
        "NPI,Provider Business Practice Location Address State Name,Entity Type Code,"
        "Provider Organization Name (Legal Business Name),Healthcare Provider Taxonomy Code_1\n"
        "1234567890,OH,2,Sample Hospital,282N00000X\n"
        "1111111111,MI,2,Outside Ohio,282N00000X\n"
    )
    archive = tmp_path / "nppes.zip"
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("npidata.csv", csvdata)
    output = tmp_path / "out"
    info = ingest(archive, "nppes", output, {}, None)
    assert info["rows"] == 1
    assert info["filtered_or_incomplete_rows"] == 1
    assert lookup(output, "1234567890", "99213", "00", "2026-10-01")["provider"][0]["organization"] == "Sample Hospital"
    assert (output / "nppes" / "provenance.json").is_file()

def test_missing_columns_produces_no_fabricated_data(tmp_path):
    p = tmp_path / "wrong.csv"
    p.write_text("foo,bar\na,b\n")
    with pytest.raises(ValueError, match="No valid matching"):
        ingest(p, "pfs", tmp_path / "out", {}, None)
