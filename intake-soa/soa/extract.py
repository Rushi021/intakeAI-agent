"""Build the structured SoA record from a located table, its footnotes, and its marker linkage.

Division of labour, and the reason for it: everything the document literally says is extracted
deterministically and verbatim — cell values, row labels, header rows, footnote text, marker
positions. The model is asked only for the *interpretation* layer that no rule can supply reliably:
which header row means study period vs visit number vs day vs window, and which rows are category
headings rather than activities. It never sees or edits a cell value, and its answer is validated
against the extracted structure before use — anything it drops falls back to the rule-based default
and is flagged. A model that hallucinates cannot delete a row or a column here.
"""
from __future__ import annotations

import re

from .footnotes import marker_key
from .locator import cell_text, split_axes, table_grid

# A row whose label is filled but which holds no value in any column is a grouping heading
# ("Safety Assessments"), not an activity. Structural, and it matches Docling's own row_section flag
# where that flag is set.
HEADER_ROLES = ("study_period", "visit_name", "visit_number", "study_day",
                "study_week", "visit_window", "other")

_WINDOW = re.compile(r"[±+]\s*\d|\bwindow\b|\bdays?\b\s*[±+]", re.IGNORECASE)
_DAY    = re.compile(r"\bday\b", re.IGNORECASE)
_WEEK   = re.compile(r"\bweek\b", re.IGNORECASE)
_VISIT  = re.compile(r"\bvisit\b", re.IGNORECASE)
_PERIOD = re.compile(r"screen|baseline|treatment|follow[\s-]?up|random|"
                     r"end of|termination|period|epoch|extension", re.IGNORECASE)


def _rule_header_role(cells: list[str]) -> str:
    """Fallback role for a header row when no model answer is available."""
    joined = " ".join(cells)
    if _WINDOW.search(joined):
        return "visit_window"
    if _VISIT.search(joined):
        return "visit_number" if sum(c.strip().lstrip("-").isdigit() for c in cells) >= 2 \
            else "visit_name"
    if _DAY.search(joined):
        return "study_day"
    if _WEEK.search(joined):
        return "study_week"
    if _PERIOD.search(joined):
        return "study_period"
    return "other"


def build_fragment(table, table_id: str, page: int) -> dict:
    """Verbatim structure of one Docling table fragment. No interpretation, no normalization."""
    grid = table_grid(table)
    header_rows, label_cols = split_axes(grid)
    width = max((len(r) for r in grid), default=0)

    columns = []
    for i in range(width):
        if i in label_cols:
            continue
        path = [cell_text(grid[r][i]) for r in sorted(header_rows) if i < len(grid[r])]
        columns.append({"col_index": i, "header_path": path})

    rows = []
    for r, row in enumerate(grid):
        if r in header_rows:
            continue
        label = " ".join(cell_text(row[i]) for i in sorted(label_cols)
                         if i < len(row) and cell_text(row[i])).strip()
        values = [cell_text(row[i]) for i in range(width)
                  if i not in label_cols and i < len(row) and cell_text(row[i])]
        is_section = any(getattr(c, "row_section", False) for c in row)
        rows.append({
            "row_index": r,
            "label": label,
            "kind": "category" if (is_section or (label and not values)) else "activity",
            "kind_source": "docling_row_section" if is_section else "rule_no_values",
        })

    cells = []
    for r, row in enumerate(grid):
        if r in header_rows:
            continue
        for i, cell in enumerate(row):
            if i in label_cols:
                continue
            value = cell_text(cell)
            if value:
                cells.append({"row": r, "col": i, "value": value})   # verbatim, never normalized

    return {
        "table_id": table_id,
        "page": page,
        "grid_size": [len(grid), width],
        "header_rows": [
            {"row_index": r,
             "cells": [cell_text(c) for c in grid[r]],
             "role": _rule_header_role([cell_text(c) for c in grid[r]]),
             "role_source": "rules"}
            for r in sorted(header_rows)
        ],
        "label_cols": sorted(label_cols),
        "columns": columns,
        "rows": rows,
        "cells": cells,
        "_grid": grid, "_header_rows": header_rows, "_label_cols": label_cols,
    }


def assemble(group, doc, footnote_blocks, soa_index: int) -> dict:
    """One logical SoA — possibly several page fragments — with its footnotes."""
    fragments = [build_fragment(doc.tables[rec["index"]], rec["table_id"], rec["page"])
                 for rec in group]

    seen, notes = set(), []
    for rec in group:
        for blk in rec["fn_blocks"]:
            for note in blk["notes"]:
                key = (note["marker"], note["text"])
                if key in seen:
                    continue                     # a legend repeated on each page of a split table
                seen.add(key)
                notes.append({**note, "verdict": blk["verdict"], "score": blk["score"],
                              "attach": blk["attach"]})

    return {
        "soa_id": f"soa-{soa_index}",
        "pages": [rec["page"] for rec in group],
        "fragments": fragments,
        "footnotes": notes,
        "detection": [{
            "table_id": rec["table_id"], "page": rec["page"], "score": rec["score"],
            "verdict": rec["verdict"], "signals": rec["signals"],
            "mark_share": rec["mark_share"], "gate": rec["gate_why"],
            "footnote_evidence": rec["fn_why"],
            # provenance only when the model overrode a rules verdict — absent on a normal run
            **({"verdict_source": rec["verdict_source"],
                "fallback_reason": rec.get("fallback_reason"),
                "fallback_confidence": rec.get("fallback_confidence")}
               if rec.get("verdict_source") == "model_fallback" else {}),
        } for rec in group],
    }


def apply_linkage(soa: dict, linked: list[dict], orphans: list[dict]) -> None:
    """Attach marker records to their cells, rows and headers, in place."""
    by_page: dict[int, list[dict]] = {}
    for rec in linked:
        by_page.setdefault(rec["page"], []).append(rec)

    for frag in soa["fragments"]:
        recs = by_page.get(frag["page"], [])
        index = {(r["row"], r["col"]): [] for r in recs}
        for r in recs:
            index[(r["row"], r["col"])].append(r["marker"])

        for cell in frag["cells"]:
            marks = index.get((cell["row"], cell["col"]))
            if marks:
                cell["markers"] = sorted(set(marks))
        for row in frag["rows"]:
            marks = [r["marker"] for r in recs
                     if r["row"] == row["row_index"] and r["target"] == "row_label"]
            if marks:
                row["markers"] = sorted(set(marks))
        for hdr in frag["header_rows"]:
            marks = [r["marker"] for r in recs
                     if r["row"] == hdr["row_index"] and r["target"] == "column_header"]
            if marks:
                hdr["markers"] = sorted(set(marks))

    values = [(f["page"], c) for f in soa["fragments"] for c in f["cells"]]
    for note in soa["footnotes"]:
        key = marker_key(note["marker"])
        note["targets"] = [
            {"page": r["page"], "row": r["row"], "col": r["col"],
             "target": r["target"], "cell_value": r["cell_value"]}
            for r in linked if marker_key(r["marker"]) == key
        ]
        # A legend whose marker IS a cell value ("X = Performed at this visit", "P = Practice only")
        # defines what that value means wherever it appears, rather than riding on one cell. Both
        # kinds are footnotes on the table; conflating them loses the distinction.
        note["value_cells"] = [{"page": p, "row": c["row"], "col": c["col"]}
                               for p, c in values if c["value"] == note["marker"]]
        note["scope"] = ("cell_marker" if note["targets"]
                         else "value_legend" if note["value_cells"] else "unlinked")

    soa["review"] = {
        "markers_in_table_without_definition": sorted({o["marker"] for o in orphans}),
        "footnotes_never_used_in_table": sorted(
            n["marker"] for n in soa["footnotes"] if n["scope"] == "unlinked"),
        "orphan_positions": orphans,
        "unmerged_fragment_warning": (
            "fragments on non-consecutive pages" if len(set(soa["pages"])) > 1
            and max(soa["pages"]) - min(soa["pages"]) + 1 != len(soa["pages"]) else None),
    }


def strip_internals(soa: dict) -> dict:
    """Drop the working fields that must not reach the committed JSON."""
    for frag in soa["fragments"]:
        for key in ("_grid", "_header_rows", "_label_cols"):
            frag.pop(key, None)
    return soa
