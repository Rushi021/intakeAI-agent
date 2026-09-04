"""Model fallback for the locator: pick the SoA table when the structural rules score nothing.

`locator.py` gates on an ordered timepoint axis and then sums a few weighted signals. On an unseen
template — a landscape header, an OCR-mangled row, a Docling mis-parse — a real Schedule of
Activities can score zero, and `pipeline.run()` returns no schedules at all. This module is the only
recovery path. When `locate()` selects nothing, it shows the model a menu of every table (captions,
header-row text, first-column labels, grid shape — never a body cell value), asks which table is the
schedule, validates the pick against the real table ids, promotes it to a normal `select` record,
and hands it back to the deterministic `assemble` / `link` / `interpret` pipeline unchanged.

A wrong pick either names a table that does not exist (rejected) or one that fails the same
timepoint-axis check the rules apply (re-asked once, then either kept-and-flagged if the model is
confident, or dropped). It can never drop a row or a column — that stays the extractor's job, working
verbatim off the grid.

Never fires when the rules already selected a table. No-ops entirely with no API key, so a rules-only
run is byte-identical with this module present or absent. `check_column_axis` is the sibling guard for
the opposite case — the rules DID select a table, but its column axis came back narrower than the
locator's own definition of a schedule's grid, which is what a parser that merges timepoint columns
looks like. Deterministic detection against `MIN_GRID_VALUE_COLS`, plus one small call to read the
real column count when a key is present.
"""
from __future__ import annotations

import time

from . import llm
from .locator import (MIN_GRID_VALUE_COLS, _INT, _TIMEPOINT_WORD, cell_text, grid_shape,
                      merge_fragments, split_axes, table_grid, timepoint_axis)

MAX_FALLBACK_ROUNDS = 2       # pick -> structural re-check -> ask once more, then stop
PICK_RETRIES = 1             # this is the "never escalate to a human" path — one retry on a flaky 429/5xx
PICK_RETRY_WAIT_S = 3
FALLBACK_MENU_MIN_ROWS = 2    # a 1-row table is a caption or a key/value line, never a schedule
FALLBACK_MENU_MIN_COLS = 2    # ...same for a single column
FALLBACK_MENU_LABELS = 12     # first-column labels sent per table: enough to recognise a schedule
FALLBACK_MENU_HEADER_ROWS = 3 # header rows sent per table: a timepoint stack is rarely deeper

PICK_SYSTEM = """You are shown a list of tables extracted from a clinical trial protocol PDF. A
structural heuristic already ran and matched nothing, so this is a fallback.

Identify which table(s) are the Schedule of Activities — also called Schedule of Assessments, Study
Flow Chart, Time and Events Schedule, or Table of Events. It is the grid that lists study activities
down the side and study timepoints (visits, days, weeks) across the top.

One schedule is often split across consecutive pages and arrives as two or more separate table
entries — pick every piece. A protocol may also hold a genuinely separate second schedule (a PK
sub-study or a long-term extension); pick those too. If none of these tables is a Schedule of
Activities, say so.

You are given each table's caption, header rows, and first column of row labels — never the body
values. Reply JSON only:
{"picks": [{"table_id": str, "confidence": "high" | "low", "reason": str}], "none": bool}
Use only table_id values from the list. If "none" is true, "picks" must be empty."""

COLUMN_SYSTEM = """You are shown the stacked header rows of one clinical trial Schedule of Activities
table, extracted verbatim. The parser reported fewer timepoint columns than a schedule should have,
so its column axis is suspect. Read the header text and report how many distinct study timepoint
columns (separate visits, days, or weeks) it actually describes.
Reply JSON only: {"distinct_timepoint_columns": int, "reason": str}"""


def _caption(table, doc) -> str | None:
    try:
        return (table.caption_text(doc) or "").strip() or None
    except Exception:                                # no caption, or Docling could not resolve it
        return None


def _menu(doc, scored) -> list[dict]:
    """One compact entry per Docling table — rules only, no body cell values leave the machine."""
    by_id = {r["table_id"]: r for r in scored}
    entries = []
    for idx, table in enumerate(doc.tables, start=1):
        table_id = f"table-{idx}"
        grid = table_grid(table)
        rows = len(grid)
        cols = max((len(r) for r in grid), default=0)
        if rows < FALLBACK_MENU_MIN_ROWS or cols < FALLBACK_MENU_MIN_COLS:
            continue
        header_rows, label_cols = split_axes(grid)
        hdr = [[cell_text(c) for c in grid[r]]
               for r in sorted(header_rows)[:FALLBACK_MENU_HEADER_ROWS]]
        labels: list[str] = []
        for r, row in enumerate(grid):
            if r in header_rows:
                continue
            txt = " ".join(cell_text(row[i]) for i in sorted(label_cols)
                           if i < len(row) and cell_text(row[i])).strip()
            if txt:
                labels.append(txt)
            if len(labels) >= FALLBACK_MENU_LABELS:
                break
        rec = by_id.get(table_id, {})
        entries.append({
            "table_id": table_id,
            "page": rec.get("page"),
            "caption": _caption(table, doc),
            "header_rows": hdr,
            "row_labels": labels,
            "shape": [rows, cols],
            "heuristic_verdict": rec.get("verdict", "reject"),
            "rejected_because": rec.get("gate_why") or rec.get("fn_why") or "not scored",
        })
    entries.sort(key=lambda e: (e["heuristic_verdict"] != "review", e["page"] or 0))
    return entries


def _promote(picks: list[dict], scored: list[dict], doc) -> list[list[dict]]:
    """Turn model picks into select-verdict records and run the normal page-split merge."""
    by_id = {r["table_id"]: r for r in scored}
    recs = []
    for p in picks:
        base = by_id.get(p["table_id"])
        if not base:
            continue
        recs.append({**base, "verdict": "select", "verdict_source": "model_fallback",
                     "fallback_reason": p["reason"], "fallback_confidence": p["confidence"]})
    return merge_fragments(recs, doc)


def _group_ok(group: list[dict], doc) -> bool:
    """Does this promoted group hold a real SoA shape — an ordered timepoint axis and value columns?

    Judged across the merged group, not per fragment: a page-1 fragment may carry only the header
    stack and a page-2 fragment only body rows, and each fails alone where the pair is fine.
    """
    grids = [table_grid(doc.tables[rec["index"]]) for rec in group]
    return (any(timepoint_axis(g)[0] for g in grids)
            and max((grid_shape(g)[1] for g in grids), default=0) >= MIN_GRID_VALUE_COLS)


def _ask(payload: dict) -> tuple[dict, str]:
    """One PICK_SYSTEM call, retried once on a transient error before giving up."""
    for attempt in range(PICK_RETRIES + 1):
        try:
            return llm._call(payload, system=PICK_SYSTEM)
        except Exception:
            if attempt == PICK_RETRIES:
                raise
            time.sleep(PICK_RETRY_WAIT_S)


def recover(doc, scored: list[dict]) -> tuple[list[list[dict]], dict]:
    """Ask the model which table is the SoA. Returns (merged groups, report). Never raises.

    `groups` may be empty. The report carries `outcome`, one of:
      unavailable          - no API key; strictly a no-op, output unchanged
      no_tables            - nothing worth showing the model
      model_found_none     - the model reviewed the menu and found no schedule
      model_error: <type>  - the call failed (network / quota / malformed)
      recovered            - a pick passed the structural re-check
      recovered_unverified - a confident pick that still fails the re-check, kept and flagged
      exhausted            - rounds spent, nothing usable
    """
    report = {"triggered": True, "model": None, "rounds": 0, "candidates_considered": 0,
              "picked": [], "invented": [], "outcome": "unavailable"}
    if not llm.available():
        report["triggered"] = False
        return [], report
    if not getattr(doc, "tables", None):
        report["outcome"] = "no_tables"
        return [], report

    menu = _menu(doc, scored)
    report["candidates_considered"] = len(menu)
    if not menu:
        report["outcome"] = "no_tables"
        return [], report

    valid = {f"table-{i}" for i in range(1, len(doc.tables) + 1)}
    tried: set[str] = set()
    last_groups: list[list[dict]] = []
    last_conf: dict[str, str] = {}

    for rnd in range(1, MAX_FALLBACK_ROUNDS + 1):
        report["rounds"] = rnd
        remaining = [e for e in menu if e["table_id"] not in tried]
        if not remaining:
            break
        try:
            answer, model = _ask({"tables": remaining})
        except Exception as exc:                      # network, auth, quota, malformed JSON
            report["outcome"] = f"model_error: {type(exc).__name__}"
            break                                     # a confident earlier pick can still be salvaged
        report["model"] = model

        picks, seen = [], set()
        if answer.get("none") is not True:
            for p in answer.get("picks", []):
                if not isinstance(p, dict):
                    continue
                tid = p.get("table_id")
                if tid in valid and tid not in seen:
                    seen.add(tid)
                    picks.append({"table_id": tid, "confidence": p.get("confidence", "low"),
                                  "reason": str(p.get("reason", ""))[:200]})
                elif isinstance(tid, str):
                    report["invented"] = sorted(set(report["invented"]) | {tid})

        if not picks:
            if last_groups:
                break                                 # nothing new — try to salvage round 1
            report["outcome"] = "model_found_none"
            return [], report

        tried.update(seen)
        groups = _promote(picks, scored, doc)
        good = [g for g in groups if _group_ok(g, doc)]
        if good:
            report["picked"] = sorted({r["table_id"] for g in good for r in g})
            report["outcome"] = "recovered"
            return good, report

        last_groups = groups
        last_conf = {p["table_id"]: p["confidence"] for p in picks}

    confident = [g for g in last_groups
                 if any(last_conf.get(r["table_id"]) == "high" for r in g)]
    if confident:
        report["picked"] = sorted({r["table_id"] for g in confident for r in g})
        report["outcome"] = "recovered_unverified"
        return confident, report
    if not report["outcome"].startswith("model_error"):
        report["outcome"] = "exhausted"
    return [], report


def check_column_axis(soa: dict, use_model: bool) -> None:
    """Flag a schedule whose column axis is narrower than a schedule's own definition of one.

    The locator already states what a schedule's grid looks like: at least `MIN_GRID_VALUE_COLS`
    timepoint columns (rule 3). A table that was *selected* as a schedule but comes back under that
    is internally inconsistent — either the parser collapsed its columns, or it was never a schedule.
    Either way it is a review item, and the test is the locator's own constant rather than a shape
    read off any one document: a parse that merges twenty visit columns into three trips it exactly
    as one that merges them into one.

    The count of timepoint-like labels still present in the header rows is reported as corroborating
    evidence, never as a second gate. With a key, one small call reads the column count the header
    text actually describes. Runs on every schedule, fallback-promoted or not.
    """
    for frag in soa["fragments"]:
        grid = frag.get("_grid")
        if not grid:
            continue
        label_cols = frag.get("_label_cols") or {0}
        header_rows = frag.get("_header_rows") or set()
        width = max((len(r) for r in grid), default=0)
        value_cols = max(width - len(label_cols), 0)
        if value_cols >= MIN_GRID_VALUE_COLS:
            continue

        hdr_labels = sum(
            1 for r in header_rows if r < len(grid) for c in grid[r]
            if cell_text(c) and (_TIMEPOINT_WORD.search(cell_text(c)) or _INT.search(cell_text(c))))
        warning = {
            "table_id": frag["table_id"],
            "parsed_value_cols": value_cols,
            "expected_at_least": MIN_GRID_VALUE_COLS,
            "timepoint_labels_in_header": hdr_labels,
            "model_columns_read": None,
            "source": "rules",
            "note": "column axis is narrower than a schedule's grid shape; "
                    "the parser has probably merged timepoint columns",
        }
        if use_model and llm.available():
            try:
                answer, _ = llm._call(
                    {"header_rows": [[cell_text(c) for c in grid[r]] for r in sorted(header_rows)]},
                    system=COLUMN_SYSTEM)
                n = answer.get("distinct_timepoint_columns")
                if isinstance(n, int) and n > value_cols:
                    warning["model_columns_read"] = n
                    warning["source"] = "model_fallback"
            except Exception:
                pass                                 # deterministic flag stands on its own
        soa.setdefault("review", {})["column_axis_warning"] = warning
        return


def _selfcheck() -> None:
    """Validator behaviour without a network: run `python -m soa.fallback`."""
    class _Cell:
        def __init__(self, t): self.text = t
        column_header = row_header = row_section = False

    class _Table:
        def __init__(self, grid): self.data = type("D", (), {"grid": grid})()
        prov = [type("P", (), {"page_no": 1, "bbox": type("B", (), {"b": 0.0})()})()]

    class _Doc:
        def __init__(self, tables): self.tables = tables

    grid = [[_Cell("Activity"), _Cell("Visit 1"), _Cell("Visit 2"), _Cell("Visit 3")],
            [_Cell("ECG"), _Cell("X"), _Cell("X"), _Cell("X")]]
    doc = _Doc([_Table(grid)])
    scored = [{"table_id": "table-1", "index": 0, "page": 1, "verdict": "reject",
               "gate_why": "forced", "fn_why": "none"}]

    orig_available, orig_call = llm.available, llm._call
    try:
        llm.available = lambda: True

        llm._call = lambda payload, system=None: ({"picks": [{"table_id": "table-404"}],
                                                   "none": False}, "stub")
        groups, report = recover(doc, scored)
        assert groups == [] and "table-404" in report["invented"], report

        llm._call = lambda payload, system=None: ({"none": True, "picks": []}, "stub")
        groups, report = recover(doc, scored)
        assert groups == [] and report["outcome"] == "model_found_none", report

        llm.available = lambda: False
        groups, report = recover(doc, scored)
        assert groups == [] and report["triggered"] is False, report
    finally:
        llm.available, llm._call = orig_available, orig_call

    # The column-axis guard is sized against the locator's grid rule, not against any one document's
    # collapse. A merge down to three columns must trip it exactly as a merge down to one does.
    def _frag(n_value_cols):
        hdr = [_Cell("Visit")] + [_Cell(f"Week {i}") for i in range(n_value_cols)]
        body = [_Cell("ECG")] + [_Cell("X") for _ in range(n_value_cols)]
        return {"table_id": "t", "_grid": [hdr, body], "_header_rows": {0}, "_label_cols": {0}}

    for cols, expect in ((1, True), (3, True), (MIN_GRID_VALUE_COLS, False), (12, False)):
        soa = {"fragments": [_frag(cols)], "review": {}}
        check_column_axis(soa, use_model=False)
        got = bool(soa["review"].get("column_axis_warning"))
        assert got is expect, f"{cols} value columns: flagged={got}, expected {expect}"

    print("fallback self-check passed")


if __name__ == "__main__":
    _selfcheck()
