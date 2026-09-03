"""Footnote detection: structural scoring over reconstructed page lines.

Docling's `footnote` layout label is trained on journal-style PDFs and undercounts the small-font
legend blocks under SoA tables badly (4 hits across the whole corpus, most of them wrong). So the
label is ignored entirely and blocks are scored on structure. Design: ../footnote_detect.md §1-2.

No sponsor string, template header, or section title is matched anywhere in this module.
"""
from __future__ import annotations

import re

from docling_core.types.doc import TextItem

# --- Scoring weights ---------------------------------------------------------------------------
W_R1_TOKEN_SHAPE = 1   # leading token is a single-class run, or X+letter
W_R2_SEPARATOR   = 1   # token followed by a separator, or run on into prose
W_R3_CLUSTER     = 1   # part of a run of 2+ marker-lines
W_R4_AFTER_TABLE = 1   # block sits immediately below a table
W_R5_IN_TABLE    = 2   # a block marker recurs inside that table

ACCEPT_SCORE        = 6   # >= this -> auto-accept (max is 6, so "all five fired")
REVIEW_SCORE        = 3   # 3..5 -> flag for human review; < 3 -> discard
ACCEPT_R5_MIN_OTHER = 2   # R5 plus this many other signals also auto-accepts

MAX_TABLE_GAP_PT    = 80    # table bottom -> block top; sized off observed 3-25pt legend gaps
LINE_Y_TOL_PT       = 3     # y tolerance when merging items into one visual line
MAX_INTERRUPT_LINES = 1     # non-candidate lines tolerated inside a block (one wrapped line)
MIN_CLUSTER_LINES   = 2     # R3 threshold
PAGE_BOTTOM_FRAC    = 0.25  # "table ends at page bottom"
LEAD_PROSE_CHARS    = 60    # a line this long above a block is body prose, not a repeated heading

SEPARATORS   = "-–—=:"
SYMBOLS      = "*†‡§¶#•"
SKIP_LABELS  = {"page_footer", "page_header", "picture"}
BREAK_LABELS = {"section_header", "title", "table"}

MAX_MARKER_FRAGS = 2        # a marker may arrive split in two ("X a", "b X")
MAX_FRAG_LEN     = 2        # ...each fragment that short — longer means it is a word

# Head is one token, or two short ones: the superscript is its own text run and may sort
# either side of its base glyph.
_SEP_SPLIT = re.compile(rf"^(\S+(?:\s+\S+)?)\s*([{re.escape(SEPARATORS)}])\s+(\S.*)$")
_SYM_RUNON = re.compile(rf"^([{re.escape(SYMBOLS)}]+)\s*(\S.*)$")
_GLUED_SYM = re.compile(rf"([{re.escape(SYMBOLS)}]+)$")   # "tests**" -> "**"
# A legend line reads "X^a = Performed at this visit if...", which reconstructs as the token "Xa".
# The marker is the superscript `a`; `X` is the cell value it rides on. The char-level reader in
# linkage.py sees only the raised glyph, so both sides are compared on this key.
_VALUE_PREFIX = re.compile(r"^\d*[Xx](.+)$")


def marker_key(marker: str) -> str:
    """Identity of a marker, with any cell-value prefix stripped: Xa -> a, 3Xb -> b, X -> X."""
    m = _VALUE_PREFIX.match(marker)
    return m.group(1) if m else marker


def item_label(item) -> str:
    label = getattr(item, "label", None)
    if label is None:
        return type(item).__name__
    return label.value if hasattr(label, "value") else str(label)


def item_page(item) -> int | None:
    prov = getattr(item, "prov", None) or []
    return getattr(prov[0], "page_no", None) if prov else None


def _token_shape_ok(tok: str) -> bool:
    """R1: leading token is a single character class, or X+letter."""
    if tok and tok[0] in SYMBOLS and all(c == tok[0] for c in tok):
        return True                      # *, **, *****, †, ‡
    if tok.isalpha():
        if tok.isupper() or tok.islower():
            return True                  # a, aa, A, CT, RT (uniform case, any length)
        return len(tok) == 2 and tok[0].isupper() and tok[1].islower()   # Xa, Xb
    if tok.isdigit():
        return len(tok) <= 2             # 1, 2, 12 — "1." never gets here (no separator)
    return False                         # (06), 3a, mixed-case words


def norm_marker(head: str) -> str | None:
    """Canonical marker for a line/cell head, or None.

    A superscript is a separate text run in the PDF, so "X^a" reaches us as "X a" — and when the
    raised glyph sorts first, as "b X". Join the fragments in either order and keep whichever
    passes the shape test.
    """
    frags = head.split()
    if len(frags) == 1:
        return frags[0] if _token_shape_ok(frags[0]) else None
    if len(frags) > MAX_MARKER_FRAGS or any(len(f) > MAX_FRAG_LEN for f in frags):
        return None                      # two real words, not a split marker
    for cand in ("".join(frags), "".join(reversed(frags))):
        if _token_shape_ok(cand):
            return cand
    return None


def marker_token(line: str):
    """(token, has_separator) if the line opens like a footnote marker, else None."""
    line = line.strip()
    m = _SEP_SPLIT.match(line)
    if m:
        tok = norm_marker(m.group(1))
        if tok:
            return tok, True
    m = _SYM_RUNON.match(line)           # run-on: *Days -15 through -9 are allotted...
    if m and _token_shape_ok(m.group(1)):
        return m.group(1), False
    return None


def page_lines(doc):
    """{page: [line dicts, top->bottom]} — items sharing a y-band merge into one visual line."""
    raw: dict[int, list[dict]] = {}
    for item, _lvl in doc.iterate_items():
        if not isinstance(item, TextItem) or item_label(item) in SKIP_LABELS:
            continue
        prov = (getattr(item, "prov", None) or [None])[0]
        if prov is None:
            continue
        bbox = prov.bbox
        for part in (item.text or "").split("\n"):
            if part.strip():
                raw.setdefault(prov.page_no, []).append(
                    {"text": part.strip(), "label": item_label(item),
                     "t": bbox.t, "b": bbox.b, "l": bbox.l, "r": bbox.r}
                )

    lines: dict[int, list[dict]] = {}
    for page, items in raw.items():
        items.sort(key=lambda d: (-d["t"], d["l"]))
        merged: list[dict] = []
        for it in items:
            prev = merged[-1] if merged else None
            if prev and abs(prev["t"] - it["t"]) <= LINE_Y_TOL_PT:
                prev["text"] = f"{prev['text']} {it['text']}"
                prev["r"] = max(prev["r"], it["r"])
                prev["b"] = min(prev["b"], it["b"])
            else:
                merged.append(dict(it))
        lines[page] = merged
    return lines


def page_tables(doc):
    """{page: [table dicts]} with bbox (BOTTOMLEFT) and flat cell texts."""
    out: dict[int, list[dict]] = {}
    for idx, table in enumerate(doc.tables, start=1):
        prov = (getattr(table, "prov", None) or [None])[0]
        if prov is None:
            continue
        cells = getattr(getattr(table, "data", None), "table_cells", []) or []
        out.setdefault(prov.page_no, []).append(
            {"id": f"table-{idx}", "page": prov.page_no,
             "t": prov.bbox.t, "b": prov.bbox.b,
             "cell_texts": [(c.text or "").strip() for c in cells]}
        )
    return out


def _close(entries: list[dict]) -> dict:
    while entries and not entries[-1]["marker"]:
        entries.pop()                    # trim trailing interrupt line
    return {"page": entries[0]["page"], "lines": entries,
            "top": max(e["t"] for e in entries),
            "bottom": min(e["b"] for e in entries),
            "markers": [e["marker"] for e in entries if e["marker"]]}


def build_blocks(lines_by_page) -> list[dict]:
    """Contiguous runs of marker-lines, tolerating MAX_INTERRUPT_LINES non-candidates."""
    blocks: list[dict] = []
    for page, lines in sorted(lines_by_page.items()):
        cur: list[dict] = []
        gap = 0

        def flush():
            nonlocal cur, gap
            if any(e["marker"] for e in cur):
                blocks.append(_close(cur))
            cur, gap = [], 0

        for ln in lines:
            if ln["label"] in BREAK_LABELS:      # heading breaks the sequence
                flush()
                continue
            hit = marker_token(ln["text"])
            entry = {**ln, "page": page,
                     "marker": hit[0] if hit else None,
                     "has_sep": hit[1] if hit else False}
            if hit:
                cur.append(entry)
                gap = 0
            elif cur and gap < MAX_INTERRUPT_LINES:
                cur.append(entry)
                gap += 1
            else:
                flush()
        flush()
    return blocks


def first_content_on_page(block, lines) -> bool:
    """Is this block the first real content on its page?

    Replaces an earlier "high on the page" test (`block.top >= 0.75 * page_height`), which was too
    strict whenever a continuation page repeats its title: protocol9's legend sits under a
    `Table 4, Continued` / title / legend-header stack starting at y=438 on a 792pt page, so the
    fractional gate never fired and a correctly-detected legend lost R4. Headings and short lines
    above a block are page furniture; a long line above it is body prose and means the block is not
    a continuation.
    """
    return not any(
        ln["t"] > block["top"]
        and ln["label"] not in BREAK_LABELS
        and len(ln["text"]) > LEAD_PROSE_CHARS
        for ln in lines
    )


def attach_table(block, tables_by_page, page_heights, lines_by_page):
    """R4: nearest table above on this page, else one that ran to the previous page's bottom."""
    same = [t for t in tables_by_page.get(block["page"], [])
            if 0 <= t["b"] - block["top"] <= MAX_TABLE_GAP_PT]
    if same:
        return min(same, key=lambda t: t["b"] - block["top"]), "same-page"

    prev = tables_by_page.get(block["page"] - 1, [])
    if not prev:
        return None, None
    last = min(prev, key=lambda t: t["b"])
    prev_height = page_heights.get(block["page"] - 1) or 792.0
    if last["b"] > prev_height * PAGE_BOTTOM_FRAC:
        return None, None               # that table did not run to the bottom of its page

    # Two independent ways to believe a legend continues a table from the previous page. Position
    # alone is not enough: protocol12's legend has one of its own footnote lines above it (a `*`
    # whose superscript Docling dropped), so it is not the first content on the page, yet its
    # markers demonstrably recur in the table above. Evidence beats geometry.
    if first_content_on_page(block, lines_by_page.get(block["page"], [])):
        return last, "page-break"
    if cell_marker_hits(last["cell_texts"], block["markers"]):
        return last, "page-break-markers"
    return None, None


# SoA cell values are X-family: the value is X (sometimes count-prefixed, 2X / 3X) and the marker is
# a superscript riding on it. Docling sometimes flattens that superscript into the text ("Xa", "3Xb")
# and more often drops it, so match on the stripped value rather than expecting a bare marker token.
_CELL_VALUE = re.compile(r"^(?P<count>\d{1,2})?\s*(?P<base>[A-Za-z]{1,2})(?P<suffix>[a-z])?$")


def cell_tokens(cell_texts) -> set[str]:
    """Every form a marker can take inside a cell: the cell, its words, adjacent short-word pairs
    joined both ways ("X a" -> Xa), and a symbol run glued to a word ("tests**" -> **)."""
    tokens: set[str] = set()
    for txt in cell_texts:
        txt = txt.strip()
        if not txt:
            continue
        words = txt.split()
        tokens.add(txt)
        tokens.update(words)
        for a, b in zip(words, words[1:]):
            if len(a) <= MAX_FRAG_LEN and len(b) <= MAX_FRAG_LEN:
                tokens.update((a + b, b + a))
        for w in words:
            m = _GLUED_SYM.search(w)
            if m:
                tokens.add(m.group(1))
    return tokens


def cell_marker_hits(cell_texts, markers) -> list[str]:
    """R5: markers that recur inside the table."""
    tokens = cell_tokens(cell_texts)
    hits = set()
    for m in markers:
        if m in tokens:
            hits.add(m)
            continue
        for tok in tokens:
            mm = _CELL_VALUE.match(tok)
            if not mm or not mm.group("base").isupper():
                continue                 # guard: keeps marker "a" off words like "Data"
            if mm.group("suffix") == m or mm.group("base") == m:
                hits.add(m)
                break
    return sorted(hits)


def score_block(block, table):
    marker_lines = [e for e in block["lines"] if e["marker"]]
    sig = {
        "R1": W_R1_TOKEN_SHAPE if marker_lines else 0,
        "R2": W_R2_SEPARATOR if any(e["has_sep"] or e["marker"][0] in SYMBOLS
                                    for e in marker_lines) else 0,
        "R3": W_R3_CLUSTER if len(marker_lines) >= MIN_CLUSTER_LINES else 0,
        "R4": W_R4_AFTER_TABLE if table else 0,
    }
    linked = cell_marker_hits(table["cell_texts"], block["markers"]) if table else []
    sig["R5"] = W_R5_IN_TABLE if linked else 0

    score = sum(sig.values())
    others = sum(1 for k in ("R1", "R2", "R3", "R4") if sig[k])
    if score >= ACCEPT_SCORE or (sig["R5"] and others >= ACCEPT_R5_MIN_OTHER):
        verdict = "accept"
    elif score >= REVIEW_SCORE:
        verdict = "review"
    else:
        verdict = "discard"
    return score, sig, verdict, linked


def footnote_text(block) -> list[dict]:
    """One entry per marker: the marker and the full text of its definition.

    Wrapped continuation lines carry no marker of their own, so they belong to the marker above.
    """
    out: list[dict] = []
    for entry in block["lines"]:
        if entry["marker"]:
            out.append({"marker": entry["marker"], "text": entry["text"],
                        "page": entry["page"]})
        elif out:
            out[-1]["text"] += " " + entry["text"]     # wrapped line
    return out


def detect_footnotes(doc) -> list[dict]:
    """Scored footnote blocks for one document."""
    tables_by_page = page_tables(doc)
    page_heights = {no: getattr(getattr(pg, "size", None), "height", 792.0)
                    for no, pg in (getattr(doc, "pages", {}) or {}).items()}

    lines = page_lines(doc)
    out = []
    for blk in build_blocks(lines):
        table, how = attach_table(blk, tables_by_page, page_heights, lines)
        score, sig, verdict, linked = score_block(blk, table)
        out.append({
            "block": blk, "table": table, "attach": how,
            "score": score, "signals": sig, "verdict": verdict,
            "linked": linked,
            "unlinked": sorted({m for m in blk["markers"] if m not in linked}),
            "notes": footnote_text(blk),
        })
    return out
