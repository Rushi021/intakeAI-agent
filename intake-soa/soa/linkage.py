"""Marker → cell linkage: which cell does each footnote marker sit on.

Docling gives table structure and cell text but drops most superscripts, so cell-text matching
systematically under-reports. This module reads the same page a second time with pdfplumber at the
character level, finds superscript glyphs by font size *and* raised baseline, and maps each one onto
the Docling cell whose bbox contains it.

Why two conditions and not one: on protocol1's SoA page the body font is 9pt and the superscripts are
8pt — but the column-header text ("VISIT", "WEEK", "ACTIVITY") is 7-8pt too. Size alone flags the
headers; raise alone flags noise. Both together isolate the markers exactly.
"""
from __future__ import annotations

import re
from collections import Counter

import pdfplumber

from .footnotes import marker_key

MAX_SIZE_RATIO   = 0.92   # a marker glyph is at most this fraction of its line's body font size
MIN_RAISE_PT     = 1.0    # ...and its baseline sits at least this far above the line's baseline
PEER_X_WINDOW    = 60.0   # horizontal reach when looking for a glyph's same-line neighbours
LINE_BAND_PT     = 5.0    # vertical tolerance for "same text line"
# A superscript's baseline sits ABOVE its line's baseline, so peers are searched asymmetrically:
# a little above (same baseline, rounding) to half a line below. Widening this to a full line pulls
# in the NEXT line of text, whose lower baseline makes every ordinary glyph look raised.
PEER_ABOVE_PT    = 1.5
PEER_BELOW_PT    = 6.0
MARKER_X_GAP_PT  = 2.5    # adjacent superscript glyphs closer than this are one marker ("**")
MAX_MARKER_CHARS = 4      # a longer run of small raised glyphs is small print, not a marker
BBOX_PAD_PT      = 1.0    # cell bboxes are tight; pad before testing containment

_MARKER_SHAPE = re.compile(r"^(?:[*†‡§¶#•]+|[A-Za-z]{1,2}|\d{1,2})$")

# Not every marker is a superscript. Symbol markers are routinely set at full size and inline —
# "* Morphine", "Chemistries plus liver function tests**", "Vital signs**" — so the char-level pass
# cannot see them and a text-level pass has to run alongside it. A candidate here only counts if the
# legend actually defines it, which is what keeps ordinary words out.
_LEAD_SYMBOL  = re.compile(r"^([*†‡§¶#•]+)\s*\S")
_TRAIL_SYMBOL = re.compile(r"([*†‡§¶#•]+)$")
_TRAIL_LETTER = re.compile(r"\S\s+([A-Za-z]{1,2})$")


def _text_marker_candidates(text: str) -> set[str]:
    """Marker tokens visible in a cell's own text."""
    out: set[str] = set()
    text = (text or "").strip()
    for pattern in (_LEAD_SYMBOL, _TRAIL_SYMBOL, _TRAIL_LETTER):
        m = pattern.search(text)
        if m:
            out.add(m.group(1))
    return out


def _page_markers(page) -> list[dict]:
    """Superscript runs on one pdfplumber page: [{text, x0, x1, top, bottom}]."""
    chars = [c for c in page.chars if (c.get("text") or "").strip()]
    if not chars:
        return []

    supers = []
    for c in chars:
        peers = [p for p in chars
                 if p is not c
                 and -PEER_ABOVE_PT <= p["bottom"] - c["bottom"] <= PEER_BELOW_PT
                 and abs(p["x0"] - c["x0"]) <= PEER_X_WINDOW]
        if not peers:
            continue
        body_size = Counter(round(p["size"], 1) for p in peers).most_common(1)[0][0]
        if c["size"] > body_size * MAX_SIZE_RATIO:
            continue                                    # not small enough to be a superscript
        baseline = sorted(p["bottom"] for p in peers if round(p["size"], 1) == body_size)
        if not baseline:
            continue
        median = baseline[len(baseline) // 2]
        if median - c["bottom"] >= MIN_RAISE_PT:         # raised above its neighbours' baseline
            supers.append(c)

    supers.sort(key=lambda c: (round(c["bottom"], 1), c["x0"]))
    runs: list[dict] = []
    for c in supers:
        prev = runs[-1] if runs else None
        if prev and abs(prev["bottom"] - c["bottom"]) <= LINE_BAND_PT \
                and c["x0"] - prev["x1"] <= MARKER_X_GAP_PT:
            prev["text"] += c["text"]
            prev["x1"] = c["x1"]
        else:
            runs.append({"text": c["text"], "x0": c["x0"], "x1": c["x1"],
                         "top": c["top"], "bottom": c["bottom"]})
    return [r for r in runs
            if len(r["text"]) <= MAX_MARKER_CHARS and _MARKER_SHAPE.match(r["text"])]


def _cell_at(grid, x: float, y: float):
    """(row, col, cell) for the grid cell containing this point, or None.

    Docling table-cell bboxes use a TOPLEFT origin, the same convention pdfplumber reports, so the
    two compare directly. (The table's own `prov.bbox` is BOTTOMLEFT — a different origin on the
    same object, which is the coordinate trap this module has to get right.)
    """
    for r, row in enumerate(grid):
        for i, cell in enumerate(row):
            bb = getattr(cell, "bbox", None)
            if bb is None:
                continue
            if (bb.l - BBOX_PAD_PT <= x <= bb.r + BBOX_PAD_PT
                    and bb.t - BBOX_PAD_PT <= y <= bb.b + BBOX_PAD_PT):
                return r, i, cell
    return None


def link_markers(pdf_path, fragments, defined_markers) -> tuple[list[dict], list[dict]]:
    """Map every superscript marker inside the SoA fragments onto its cell.

    `fragments` is [{page, grid, header_rows, label_cols}]; `defined_markers` is the set of markers
    that the footnote legend actually defines. Returns (linked, orphans) — a marker found in the
    grid with no definition is an orphan and is surfaced, never dropped.
    """
    linked: list[dict] = []
    orphans: list[dict] = []
    seen: set[tuple] = set()

    def emit(rec: dict) -> None:
        key = (rec["page"], rec["row"], rec["col"], marker_key(rec["marker"]))
        if key in seen:
            return                      # the same marker seen by both passes
        seen.add(key)
        (linked if marker_key(rec["marker"]) in defined_markers else orphans).append(rec)

    with pdfplumber.open(pdf_path) as pdf:
        for frag in fragments:
            page_no = frag["page"]
            if not (1 <= page_no <= len(pdf.pages)):
                continue
            page = pdf.pages[page_no - 1]
            grid = frag["grid"]
            for run in _page_markers(page):
                hit = _cell_at(grid, (run["x0"] + run["x1"]) / 2,
                               (run["top"] + run["bottom"]) / 2)
                if hit is None:
                    continue                    # marker is outside the table (prose, header, legend)
                r, i, cell = hit
                value = (getattr(cell, "text", "") or "").strip()
                if run["text"] == value:
                    continue            # this glyph IS the cell value, not a marker riding on one
                emit({
                    "marker": run["text"],
                    "page": page_no,
                    "row": r, "col": i,
                    "cell_value": value,
                    "target": ("column_header" if r in frag["header_rows"]
                               else "row_label" if i in frag["label_cols"] else "cell"),
                    "via": "superscript",
                    "bbox": [round(run["x0"], 1), round(run["top"], 1),
                             round(run["x1"], 1), round(run["bottom"], 1)],
                })

            for r, row in enumerate(grid):
                for i, cell in enumerate(row):
                    value = (getattr(cell, "text", "") or "").strip()
                    for cand in _text_marker_candidates(value):
                        if marker_key(cand) not in defined_markers:
                            continue     # only markers the legend defines; not every stray glyph
                        emit({
                            "marker": cand, "page": page_no, "row": r, "col": i,
                            "cell_value": value,
                            "target": ("column_header" if r in frag["header_rows"]
                                       else "row_label" if i in frag["label_cols"] else "cell"),
                            "via": "cell_text",
                        })
    return linked, orphans
