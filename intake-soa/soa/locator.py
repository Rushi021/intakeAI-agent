"""SoA table identification: score every Docling table, gate on a timepoint axis, merge fragments.

A protocol may hold more than one SoA (main + sub-study + PK + long-term extension), so this returns
every table above threshold, never "the top one". Structure is scored; headings, captions and sponsor
templates are never matched.
"""
from __future__ import annotations

import re

from .footnotes import MAX_TABLE_GAP_PT, page_lines

# --- Scoring weights ---------------------------------------------------------------------------
W_MARK_SHARE = 1.0    # rule 1: body cells are overwhelmingly activity marks
W_FOOTNOTE   = 0.5    # rule 2: a footnote block hangs off this table
W_GRID       = 0.5    # rule 3: the table is a large grid, not a small lookup

# Rule 1 separates cleanly on the corpus: real SoAs score 0.75-1.00, every other table 0.00.
# The threshold sits well below the gap for recall margin on templates we have not seen.
MARK_SHARE_MIN        = 0.60   # rule 1 threshold: marks / non-empty body cells
MIN_MARK_CELLS        = 10     # ...over at least this many cells; 3 cells prove nothing
MAX_MARK_CHARS        = 40     # a cell longer than this is a note, not a mark
MIN_GRID_BODY_ROWS    = 5      # rule 3: an SoA lists at least this many activities
MIN_GRID_VALUE_COLS   = 4      # rule 3: ...across at least this many timepoint columns
MIN_TIMEPOINT_LABELS  = 3      # rule 4 gate: ordered timepoint-like labels needed on an axis
FOOTNOTE_HEADER_CHARS = 60     # a short line under a table that reads as a legend header
SOA_SCORE_THRESHOLD   = 1.5    # select at or above this: rule 1 plus either rule 2 or rule 3
SOA_REVIEW_THRESHOLD  = 1.0    # 1.0..1.5 -> surfaced as a near miss, never silently dropped

# An SoA cell is a mark, not a boolean: "X", "1X", "3X/week", "(X)", "b X" (a split superscript),
# "Weekly x 2 weeks". A bare number is deliberately NOT a mark — that is what count and dose tables
# are full of, and treating it as one selects adverse-event tallies as schedules.
_MARK_TOKEN = re.compile(r"^[(\[]?\d{0,2}\s?[x✓✔●•√][)\]]?$", re.IGNORECASE)
# Header-stack walk still needs the strict form: a row holding X-values is a body row, not a header.
_X_VALUE = re.compile(r"^\d*X$")
# Generic timepoint vocabulary — study-design words, not sponsor or template strings.
_TIMEPOINT_WORD = re.compile(
    r"\b(visit|day|week|month|year|cycle|hour|screen\w*|baseline|random\w*|"
    r"treatment|follow[\s-]?up|end of|eot|eos|unscheduled|termination|period|epoch)\b",
    re.IGNORECASE,
)
_INT = re.compile(r"-?\d+")


def table_grid(table):
    return getattr(getattr(table, "data", None), "grid", None) or []


def cell_text(cell) -> str:
    return (getattr(cell, "text", "") or "").strip()


def is_mark(text: str) -> bool:
    """Rule 1: does this cell read as an activity mark rather than a value, count, or sentence?"""
    if not text or len(text) > MAX_MARK_CHARS:
        return False
    return any(_MARK_TOKEN.match(t) for t in re.split(r"[\s/,]+", text) if t)


def split_axes(grid):
    """(header row indices, row-label column indices).

    Docling's `column_header` flag is unreliable on stacked headers — on protocol1's SoA it flags the
    VISIT row but not the WEEK row under it, which leaks 8 timepoint labels into the body and drags
    the x-value ratio down by ~9 points. So: take the flagged rows, then keep walking down while a
    row still reads as header (timepoint-like labels, no body value in it).
    """
    header_rows = {r for r, row in enumerate(grid)
                   if any(getattr(c, "column_header", False) for c in row)}
    label_cols = {i for row in grid for i, c in enumerate(row)
                  if getattr(c, "row_header", False)}
    if not label_cols and grid:
        label_cols = {0}          # unflagged: first column carries the activity labels

    for r, row in enumerate(grid):
        if r in header_rows:
            continue
        cells = [cell_text(c) for i, c in enumerate(row) if i not in label_cols]
        cells = [c for c in cells if c]
        if cells and not any(_X_VALUE.match(c) for c in cells) \
                and all(_TIMEPOINT_WORD.search(c) or _INT.search(c) for c in cells):
            header_rows.add(r)
            continue
        break                     # first real body row ends the header stack
    return header_rows, label_cols


def body_texts(grid) -> list[str]:
    header_rows, label_cols = split_axes(grid)
    out = []
    for r, row in enumerate(grid):
        if r in header_rows:
            continue
        for i, cell in enumerate(row):
            if i in label_cols or getattr(cell, "row_section", False):
                continue
            out.append(cell_text(cell))
    return out


def timepoint_axis(grid) -> tuple[bool, str]:
    """Rule 4 gate: some header row or the label column holds ordered timepoint-like labels."""
    header_rows, label_cols = split_axes(grid)
    axes: list[tuple[str, list[str]]] = [
        (f"header row {r}", [cell_text(c) for c in grid[r]]) for r in sorted(header_rows)
    ]
    for i in sorted(label_cols):
        axes.append((f"column {i}", [cell_text(row[i]) for row in grid if i < len(row)]))

    for name, cells in axes:
        cells = [c for c in cells if c]
        words = sum(1 for c in cells if _TIMEPOINT_WORD.search(c))
        if words >= MIN_TIMEPOINT_LABELS:
            return True, f"{name}: {words} timepoint labels"
        nums = [int(m.group()) for c in cells for m in [_INT.search(c)] if m]
        if len(nums) >= MIN_TIMEPOINT_LABELS and len(set(nums)) >= MIN_TIMEPOINT_LABELS:
            if nums == sorted(nums) or nums == sorted(nums, reverse=True):
                return True, f"{name}: ordered numeric sequence {nums[:6]}…"
    return False, "no ordered timepoint axis"


def grid_shape(grid) -> tuple[int, int]:
    """(body rows, value columns) — the part of the grid that carries activities × timepoints."""
    header_rows, label_cols = split_axes(grid)
    body_rows = sum(1 for r, row in enumerate(grid)
                    if r not in header_rows and any(cell_text(c) for c in row))
    value_cols = max((len(row) for row in grid), default=0) - len(label_cols)
    return body_rows, max(value_cols, 0)


def footnote_evidence(table_id, page, bottom, blocks, lines_by_page):
    """Rule 2: a detected footnote block attached to this table, or a legend header under it."""
    attached = [r for r in blocks
                if r["table"] and r["table"]["id"] == table_id and r["verdict"] != "discard"]
    if attached:
        markers = sorted({m for r in attached for m in r["block"]["markers"]})
        return True, f"{len(attached)} block(s), markers {markers}", attached
    for ln in lines_by_page.get(page, []):
        if 0 <= bottom - ln["t"] <= MAX_TABLE_GAP_PT \
                and len(ln["text"]) <= FOOTNOTE_HEADER_CHARS \
                and ln["text"].rstrip().endswith(":"):
            return True, f"legend header {ln['text']!r}", []
    return False, "none", []


def score_tables(doc, footnote_blocks) -> list[dict]:
    """One scored record per Docling table, ranked. Nothing is dropped — rejects carry their reason."""
    lines = page_lines(doc)
    rows: list[dict] = []

    for idx, table in enumerate(doc.tables, start=1):
        table_id = f"table-{idx}"
        grid = table_grid(table)
        prov = (getattr(table, "prov", None) or [None])[0]
        page = prov.page_no if prov else None

        texts = body_texts(grid)
        non_empty = [t for t in texts if t]
        empty = len(texts) - len(non_empty)
        marks = [t for t in non_empty if is_mark(t)]
        mark_share = len(marks) / len(non_empty) if non_empty else 0.0

        body_rows, value_cols = grid_shape(grid)
        eligible, gate_why = timepoint_axis(grid)
        has_fn, fn_why, fn_blocks = footnote_evidence(
            table_id, page, prov.bbox.b if prov else 0.0, footnote_blocks, lines)

        sig = {
            "R1_marks": W_MARK_SHARE if (mark_share >= MARK_SHARE_MIN
                                         and len(non_empty) >= MIN_MARK_CELLS) else 0.0,
            "R2_footnotes": W_FOOTNOTE if has_fn else 0.0,
            "R3_grid": W_GRID if (body_rows >= MIN_GRID_BODY_ROWS
                                  and value_cols >= MIN_GRID_VALUE_COLS) else 0.0,
        }
        score = sum(sig.values()) if eligible else 0.0
        verdict = ("select" if score >= SOA_SCORE_THRESHOLD
                   else "review" if score >= SOA_REVIEW_THRESHOLD else "reject")

        rows.append({
            "table_id": table_id, "index": idx - 1, "page": page,
            "rows": len(grid), "cols": max((len(r) for r in grid), default=0),
            "body_rows": body_rows, "value_cols": value_cols,
            "non_empty": len(non_empty), "empty": empty,
            "mark_share": round(mark_share, 3), "marks": len(marks),
            "eligible": eligible, "gate_why": gate_why,
            "fn_why": fn_why, "fn_blocks": fn_blocks,
            "score": score, "signals": sig, "verdict": verdict,
        })

    rows.sort(key=lambda r: (r["score"], r["mark_share"]), reverse=True)
    return rows


def header_signature(grid) -> tuple:
    """Structural fingerprint of a table's column axis, for deciding if two fragments are one table.

    Column *count* plus the shape of the header stack. Deliberately not the header text: a
    continuation page may repeat its headers abbreviated, or not at all.
    """
    header_rows, label_cols = split_axes(grid)
    return (max((len(r) for r in grid), default=0), len(label_cols))


def merge_fragments(selected: list[dict], doc) -> list[list[dict]]:
    """Group page-split fragments of one logical SoA.

    Two selected tables are the same SoA when they sit on consecutive pages and share a column
    signature. An SoA runs 2-4 pages and Docling emits one table per page fragment; reporting those
    as separate schedules is the failure the brief calls out.

    ponytail: consecutive-page + column-count only. A continuation that Docling re-columns (a
    rotated or landscape page) will not merge and is reported as its own SoA — visible, not silent.
    """
    ordered = sorted(selected, key=lambda r: (r["page"] or 0, r["index"]))
    groups: list[list[dict]] = []
    for rec in ordered:
        grid = table_grid(doc.tables[rec["index"]])
        sig = header_signature(grid)
        prev = groups[-1][-1] if groups else None
        if prev and prev["_sig"] == sig and (rec["page"] or 0) - (prev["page"] or 0) in (0, 1):
            groups[-1].append({**rec, "_sig": sig})
        else:
            groups.append([{**rec, "_sig": sig}])
    return groups


def locate(doc, footnote_blocks):
    """(scored rows, merged groups of selected fragments)."""
    scored = score_tables(doc, footnote_blocks)
    selected = [r for r in scored if r["verdict"] == "select"]
    return scored, merge_fragments(selected, doc)
