#!/usr/bin/env python3
"""Smoke check for the extraction rules. Run: python test_soa.py

Asserts the behaviour that would break silently: mark classification, marker normalization, header
splitting, and superscript detection needing size AND raise. Uses the cached Docling dumps in
outputs/ so it does not re-convert any PDF.
"""
import json
from pathlib import Path

from docling_core.types.doc import DoclingDocument

from soa import fallback, llm
from soa.extract import assemble
from soa.footnotes import detect_footnotes, marker_key, marker_token, norm_marker
from soa.locator import grid_shape, is_mark, locate, score_tables, split_axes, table_grid

HERE = Path(__file__).resolve().parent


def _doc(name):
    dump = HERE / "outputs" / f"{name}-docling.json"
    return DoclingDocument.model_validate(json.loads(dump.read_text())) if dump.is_file() else None


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


def test_fallback_menu():
    """The menu the model sees carries headers, labels and shape — never a body cell value —
    and never names a table that is not in the document."""
    doc = _doc("protocol1")
    if not doc:
        print("  skip (no cached dump)")
        return
    scored = score_tables(doc, detect_footnotes(doc))
    menu = fallback._menu(doc, scored)
    valid = {f"table-{i}" for i in range(1, len(doc.tables) + 1)}
    allowed = {"table_id", "page", "caption", "header_rows", "row_labels", "shape",
               "heuristic_verdict", "rejected_because"}
    body_values = {"X", "1X", "3X"}
    for e in menu:
        assert e["table_id"] in valid, e["table_id"]
        assert set(e) == allowed, set(e) ^ allowed
        assert e["shape"][0] >= fallback.FALLBACK_MENU_MIN_ROWS
        assert e["shape"][1] >= fallback.FALLBACK_MENU_MIN_COLS
        flat = {c for row in e["header_rows"] for c in row} | set(e["row_labels"])
        assert not (flat & body_values), f"body value leaked into menu: {flat & body_values}"
    assert any(e["table_id"] in ("table-7", "table-8") for e in menu), "real SoA missing from menu"
    print(f"  menu: {len(menu)} candidates, no cell values, ids all valid")


def test_fallback_offline_is_noop():
    """No API key -> recover() is a strict no-op and reports it did not trigger."""
    doc = _doc("protocol1")
    if not doc:
        print("  skip (no cached dump)")
        return
    scored = score_tables(doc, detect_footnotes(doc))
    orig = llm.available
    llm.available = lambda: False
    try:
        groups, report = fallback.recover(doc, scored)
        assert groups == [] and report["triggered"] is False, report
    finally:
        llm.available = orig
    print("  offline recover(): no-op, triggered=False")


def test_fallback_validates_model_output():
    """Invented ids, a bare {"none": true}, and a malformed reply must never raise or promote."""
    doc = _doc("protocol1")
    if not doc:
        print("  skip (no cached dump)")
        return
    scored = score_tables(doc, detect_footnotes(doc))
    orig_av, orig_call = llm.available, llm._call
    llm.available = lambda: True
    try:
        llm._call = lambda payload, system=None: ({"picks": [{"table_id": "table-9999"}],
                                                   "none": False}, "stub")
        groups, report = fallback.recover(doc, scored)
        assert groups == [] and "table-9999" in report["invented"], report

        llm._call = lambda payload, system=None: ({"none": True, "picks": []}, "stub")
        groups, report = fallback.recover(doc, scored)
        assert groups == [] and report["outcome"] == "model_found_none", report

        def boom(payload, system=None):
            raise ValueError("bad json")
        llm._call = boom
        groups, report = fallback.recover(doc, scored)
        assert groups == [] and report["outcome"].startswith("model_error"), report
    finally:
        llm.available, llm._call = orig_av, orig_call
    print("  invented / none / malformed: all handled, nothing promoted")


def test_column_axis_flag():
    """protocol12's SoA collapses to one value column — it must be flagged. The others must not."""
    expected = {"protocol1": False, "protocol5": False, "protocol9": False,
                "protocol12": True, "protocol15": False}
    for name, should_flag in expected.items():
        doc = _doc(name)
        if not doc:
            print(f"  skip {name} (no cached dump)")
            continue
        blocks = detect_footnotes(doc)
        _scored, groups = locate(doc, blocks)
        flagged = False
        for i, group in enumerate(groups, 1):
            soa = assemble(group, doc, blocks, i)
            soa["review"] = {}
            fallback.check_column_axis(soa, use_model=False)
            flagged = flagged or bool(soa["review"].get("column_axis_warning"))
        assert flagged == should_flag, f"{name}: flagged={flagged}, expected {should_flag}"
        print(f"  {name}: {'flagged' if flagged else 'clean'}")


def test_fallback_recovers_gated_soa():
    """With every heuristic select wiped, the model fallback finds the same table the rules would."""
    if not llm.available():
        print("  skip (no MISTRAL_API_KEY)")
        return
    for name in ("protocol1", "protocol15"):
        doc = _doc(name)
        if not doc:
            print(f"  skip {name} (no cached dump)")
            continue
        blocks = detect_footnotes(doc)
        _s, groups0 = locate(doc, blocks)
        want = sorted({r["table_id"] for g in groups0 for r in g})
        scored = score_tables(doc, blocks)
        for r in scored:
            if r["verdict"] == "select":
                r["verdict"] = "reject"
        groups, report = fallback.recover(doc, scored)
        got = sorted({r["table_id"] for g in groups for r in g})
        assert report["outcome"] in ("recovered", "recovered_unverified"), report
        assert set(want).issubset(set(got)), f"{name}: want {want}, got {got}"
        print(f"  {name}: rules-select wiped, fallback recovered {got} ({report['outcome']})")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            print(f"{name}:")
            fn()
    print("\nall checks passed")
