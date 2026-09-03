#!/usr/bin/env python3
"""Smoke check for the extraction rules. Run: python test_soa.py

Asserts the behaviour that would break silently: mark classification, marker normalization, header
splitting, and superscript detection needing size AND raise. Uses the cached Docling dumps in
outputs/ so it does not re-convert any PDF.
"""
import json
from pathlib import Path

from docling_core.types.doc import DoclingDocument

from soa.footnotes import detect_footnotes, marker_key, marker_token, norm_marker
from soa.locator import grid_shape, is_mark, locate, split_axes, table_grid

HERE = Path(__file__).resolve().parent


def test_marks():
    """Rule 1 must accept the non-boolean cell values the brief lists, and refuse bare numbers."""
    for value in ("X", "1X", "3X", "(X)", "b X", "X a", "3X/week", "Weekly x 2 weeks", "2X/day"):
        assert is_mark(value), f"{value!r} should be a mark"
    for value in ("", "0", "1", "42", "136.25 ± 7.90", "400mg", "saline", "Prior to Day 4",
                  "Admission, Monday, Wednesday, Friday, Discharge and As Needed"):
        assert not is_mark(value), f"{value!r} should NOT be a mark"


def test_markers():
    """A superscript arrives as its own text run, either side of its base glyph."""
    assert norm_marker("X a") == "Xa"
    assert norm_marker("b X") == "Xb"           # raised glyph sorted first
    assert norm_marker("Female subjects") is None
    assert marker_token("1. Female subjects must be...") is None   # enumeration, not a marker
    assert marker_token("* Days -15 through -9 are allotted")[0] == "*"
    assert marker_token("Xa = Performed at this visit")[0] == "Xa"
    # legend writes "Xa", the char reader sees only the raised "a" — both must meet at "a"
    assert marker_key("Xa") == "a" and marker_key("3Xb") == "b"
    assert marker_key("X") == "X" and marker_key("*") == "*" and marker_key("CT") == "CT"


def test_corpus():
    """Every protocol locates an SoA, and the page-split ones come back merged, not fragmented."""
    expected = {                       # (pages, fragment count) verified against the source PDFs
        "protocol1":  ([53, 54], 2),
        "protocol5":  ([50], 1),
        "protocol9":  ([26, 27, 28], 3),
        "protocol12": ([48], 1),
        "protocol15": ([25], 1),
    }
    for name, (pages, frags) in expected.items():
        dump = HERE / "outputs" / f"{name}-docling.json"
        if not dump.is_file():
            print(f"  skip {name} (no cached dump)")
            continue
        doc = DoclingDocument.model_validate(json.loads(dump.read_text()))
        _scored, groups = locate(doc, detect_footnotes(doc))
        assert len(groups) == 1, f"{name}: expected 1 schedule, got {len(groups)}"
        got = [r["page"] for r in groups[0]]
        assert got == pages, f"{name}: expected pages {pages}, got {got}"
        assert len(groups[0]) == frags, f"{name}: expected {frags} fragments, got {len(groups[0])}"
        print(f"  {name}: pages {got}, {len(groups[0])} fragment(s)")


def test_header_stack():
    """Docling flags the VISIT row but not the WEEK row under it; the walk must catch both,
    or those timepoint labels leak into the body and wreck the mark share."""
    dump = HERE / "outputs" / "protocol1-docling.json"
    if not dump.is_file():
        print("  skip (no cached dump)")
        return
    doc = DoclingDocument.model_validate(json.loads(dump.read_text()))
    grid = table_grid(doc.tables[6])              # protocol1 p53 SoA
    header_rows, label_cols = split_axes(grid)
    assert header_rows == {0, 1}, f"expected header rows 0 and 1, got {header_rows}"
    assert label_cols == {0}, f"expected label column 0, got {label_cols}"
    body_rows, value_cols = grid_shape(grid)
    assert body_rows >= 5 and value_cols >= 4, (body_rows, value_cols)


def test_superscript_needs_size_and_raise():
    """Size alone flags the small-caps column headers; both conditions are required."""
    try:
        import pdfplumber
    except ImportError:
        print("  skip (pdfplumber not installed)")
        return
    pdf = HERE / ".." / "takehome-1b" / "protocol1.pdf"
    if not pdf.is_file():
        print("  skip (protocol1.pdf not present)")
        return
    from soa.linkage import _page_markers
    with pdfplumber.open(pdf) as f:
        runs = _page_markers(f.pages[52])         # p53
    found = {r["text"] for r in runs}
    assert found == {"a", "b"}, f"expected the a/b superscripts only, got {found}"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            print(f"{name}:")
            fn()
    print("\nall checks passed")
