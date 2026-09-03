# intake-soa — Schedule of Activities extraction

Find the Schedule of Activities in any clinical trial protocol PDF and produce a faithful,
machine-readable representation of it — including footnotes bound to the cells they modify.

Part 2 of Take-Home 1b. Independent of [`intake-agent/`](../intake-agent/) (Part 1); nothing here
imports from or modifies the extension.

---

## Setup

Python 3.10+ (3.12 used here).

```bash
cd intake-soa
python3 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Optional — the interpretation layer (see [Architecture](#architecture)). **The tool runs fully
without it**; only the header-role and row-grouping labels fall back to rules.

```bash
export MISTRAL_API_KEY=...
```

The key is looked up in this order, first hit wins: `$MISTRAL_API_KEY` → `intake-soa/.env` →
`../intake-agent/.env` (Part 1's `VITE_MISTRAL_API_KEY`, so one key covers both parts of the
take-home). If none is found the pipeline says so and runs on rules alone.

### Run the UI

```bash
python -m soa.server                 # http://127.0.0.1:8000
```

Drag in any protocol PDF (several at once), remove any you did not mean to add, press **Run agent**.
Documents are extracted in parallel; each finished document gets its own tab.

### Run headless

```bash
python run_corpus.py                 # every PDF in ../takehome-1b/ -> outputs/<name>-soa.json
python run_corpus.py --no-model      # rules only, no API key needed
python run_corpus.py protocol9       # one document
```

The committed output in [`outputs/`](outputs/) is produced by exactly this script.

### Check it still works

```bash
python test_soa.py
```

Asserts what would otherwise break silently: mark classification against the brief's own list of
non-boolean cell values, split-superscript marker normalization, the header-stack walk, that every
protocol still locates its SoA on the right pages with the right fragment count, and that superscript
detection needs *both* small size and a raised baseline. Runs off the cached Docling dumps, so it
re-converts nothing and takes a few seconds.

---

## Architecture

```
PDF ─▶ Docling parse ─▶ footnote blocks ─▶ SoA table scoring ─▶ fragment merge
                             │                     │                  │
                             └── rule 2 signal ────┘                  ▼
                                                          verbatim structure extraction
                                                                      │
                                             marker → cell linkage ◀───┤ (pdfplumber, char level)
                                                                      │
                                              model interpretation ◀──┘ (header roles, row grouping)
```

| stage | module |
|---|---|
| parse, orchestration, per-document metadata | [`soa/pipeline.py`](soa/pipeline.py) |
| footnote detection (R1–R5 scoring) | [`soa/footnotes.py`](soa/footnotes.py) |
| SoA table identification + page-split merge | [`soa/locator.py`](soa/locator.py) |
| marker → cell linkage | [`soa/linkage.py`](soa/linkage.py) |
| schema construction | [`soa/extract.py`](soa/extract.py) |
| interpretation layer | [`soa/llm.py`](soa/llm.py) |
| upload / parallel run / review UI | [`soa/server.py`](soa/server.py), [`web/`](web/) |

Design detail and the full decision record live in [`footnote_detect.md`](footnote_detect.md);
per-protocol results and the tuning log in [`extractor_test.md`](extractor_test.md).

### Why footnotes are detected before the table is chosen

Footnote detection is table-agnostic and cheap: it attaches each legend block to whatever table sits
above it, SoA or not. The locator then consumes those attachments as one of its scoring signals
("does a footnote block hang off me?"), which is a strong SoA tell — schedules carry legends, dosing
tables usually do not. Linkage runs last, scoped to the tables the locator selected, so a marker is
never matched against a legend belonging to a different table on the same page.

### The locator

Every table Docling finds is scored. Nothing keys off a page number, a table index, a sponsor name,
a section title, or a caption — the heading "Schedule of Activities" is never matched, because across
the five samples it is variously a flow chart, a table of events, and an untitled appendix table.

| rule | pts | check |
|---|---|---|
| 1 | +1.0 | **Mark share.** Fraction of non-empty body cells that read as an activity mark — `X`, `1X`, `3X/week`, `(X)`, `b X`, `Weekly x 2 weeks`. Bare integers are deliberately *not* marks. Fires at ≥ 0.60. |
| 2 | +0.5 | **Footnote block present**, attached by the detector above, or a short line ending in `:` directly under the table. |
| 3 | +0.5 | **Grid shape** — ≥ 5 body rows across ≥ 4 value columns. |
| 4 | gate | **Timepoint axis** — a header row or the label column carries ≥ 3 ordered timepoint-like labels (study-design vocabulary, or a monotonic integer run). Failing this disqualifies the table outright. |

Selected at ≥ 1.5, flagged for review at 1.0–1.5, rejected below. **Every** table above threshold is
returned, ranked — a protocol may hold a main schedule plus a sub-study, PK, or extension schedule,
so this is never "take the top one". Rejected tables keep their reason and are printed and shown in
the UI, so a miss is visible rather than silent.

Rule 1 is the rule that does the work, and it is worth saying how it was set. It started as
`^\d*X$` over 90% of body cells, which fired on protocol1 and **nothing else** — the other four
protocols use `1X`, `3X/week`, `b X`, `Weekly x 2 weeks`, exactly the non-boolean values the brief
warns about. Measured across the corpus, mark share separates completely: real SoAs 0.75–1.00, every
other table 0.00. The threshold sits in the middle of that gap. Refusing bare integers is what keeps
protocol15's 41×12 adverse-event count table and protocol12's dose table out.

Page-split fragments are merged into one logical schedule when they sit on consecutive pages and
share a column signature (width + label-column count) — deliberately not matched on header *text*,
because a continuation page may abbreviate or omit its headers.

### The extractor

Everything the document literally says is extracted deterministically:

- **Cell values verbatim.** No normalization, no boolean coercion, no repair. `3X/week`, `(X)`,
  `Weekly x 2 weeks`, `Prior to Day 4` come through as written.
- **Both axes' hierarchy.** Column headers keep their full stacked path (`["VISIT 1", "WEEK -2"]`);
  rows keep their category/activity distinction and parent.
- **Footnotes** with their full text, page-break continuations merged, and a legend repeated across a
  split table de-duplicated to one list.
- **Linkage** — which cell, row label, or column header each marker sits on.

### Marker → cell linkage, and why it needs a second reader

This is the part Docling cannot answer. It gives table structure and cell text but drops most
superscripts — on protocol1's SoA, 65 `X` cells come back as bare `X` with the `a`/`b` superscripts
gone. So [`soa/linkage.py`](soa/linkage.py) reads the same page again with pdfplumber at the
character level and runs two passes:

1. **Superscript pass.** A glyph is a marker when it is *both* smaller than its line's body font
   (≤ 0.92×) *and* raised above that line's baseline (≥ 1pt). Both conditions are required: size
   alone flags the small-caps column headers ("VISIT", "WEEK", "ACTIVITY" are 7–8pt against a 9pt
   body), and raise alone flags noise. Together they isolate the markers exactly. Each marker is then
   mapped onto the Docling cell whose bbox contains it.
2. **Cell-text pass.** Symbol markers are routinely set at full size and inline — `* Morphine`,
   `Chemistries plus liver function tests**`, `Vital signs**` — so the char pass cannot see them. A
   marker token in a cell's own text counts too, but only if the legend actually defines it, which is
   what keeps ordinary words out.

Legend markers and in-table markers are compared on a normalized key: the legend writes `X^a = …`,
which reconstructs as the token `Xa`, while the char reader sees only the raised `a`. `marker_key()`
strips the cell-value prefix so both sides meet at `a`.

Footnotes are classified by scope: `cell_marker` (rides on specific cells), `value_legend` (defines
what a cell *value* means — `X = Performed at this visit` modifies all 130 cells holding `X`), or
`unlinked`. Conflating the first two would misreport what a footnote governs.

**Coordinate trap, for anyone extending this.** Three systems are in play on the same object: Docling
text and table `prov.bbox` is BOTTOMLEFT, Docling *cell* bboxes are TOPLEFT, pdfplumber is top-left
with its own page height. Cell bboxes and pdfplumber agree directly; the table's own bbox does not.

### Where the model is used, and where it is deliberately not

The model is asked for exactly one thing: the **interpretation** layer that no rule supplies
reliably — which header row means study period vs visit number vs day vs window, and which rows are
category headings rather than activities.

It never sees a cell value, never sees the protocol prose, and cannot write one. It receives the
header rows and the row labels, already extracted; its answer is validated index-by-index against the
structure we already have; anything it omits, invents, or mislabels falls back to the rule-based
default and is recorded in `review.interpretation`. A hallucination cannot delete a row or a visit
here — which is the failure the brief penalizes most heavily.

This also keeps the assignment's ground rule about not uploading protocols anywhere they would be
retained: what leaves the machine is one table's headers and row labels, not the document. Use a paid
(no-train) Mistral key, or run with `--no-model` and lose nothing but label precision.

---

## Output schema, and why

One JSON file per protocol. Shape:

```jsonc
{
  "document":  { "filename", "pages", "tables", "text_items", "labels": [{label, count}] },
  "schedules": [{
    "soa_id": "soa-1",
    "pages": [53, 54],
    "fragments": [{                     // one per page fragment of a split table
      "table_id", "page", "grid_size", "label_cols",
      "header_rows": [{ "row_index", "cells": [...], "role", "role_source", "markers"? }],
      "columns":     [{ "col_index", "header_path": ["VISIT 1", "WEEK -2"] }],
      "rows":        [{ "row_index", "label", "kind": "activity"|"category",
                        "kind_source", "parent"?, "markers"? }],
      "cells":       [{ "row", "col", "value", "markers"? }]
    }],
    "footnotes": [{ "marker", "text", "page", "scope", "targets": [...], "value_cells": [...],
                    "verdict", "score", "attach" }],
    "detection": [{ "table_id", "page", "score", "signals", "mark_share", "gate" }],
    "review":    { "markers_in_table_without_definition", "footnotes_never_used_in_table", ... }
  }],
  "review":       { "schedules_found", "near_miss_tables", "footnote_blocks", ... },
  "table_scores": [ /* every table in the document, with its score and rejection reason */ ]
}
```

Choices worth defending:

- **Cells are a sparse list, not a dense matrix.** An SoA is mostly empty. A list of
  `{row, col, value}` keeps the addressing explicit and makes a missing cell distinguishable from an
  empty one — a dense matrix has to invent a filler value, and that filler becomes indistinguishable
  from a real dash or dot.
- **Row and column identity are integer indices into the source grid.** Every footnote target, every
  marker, every cell refers back to a position in the table as Docling parsed it, so any claim in the
  output can be traced to a specific place on a specific page.
- **`header_path` per column rather than a flattened header string.** Flattening loses the stacked
  hierarchy the brief calls out; keeping the path lets a consumer reconstruct study period → visit →
  day → window without re-parsing anything.
- **`role` and `kind` carry a `_source` field** (`rules` / `model` / `docling_row_section`). Where an
  interpretation came from is part of the output, so a reviewer can weight it.
- **Provenance and uncertainty are in the file, not just the logs.** `detection`, `table_scores` and
  `review` ship with every extraction. `table_scores` lists every table that was *rejected* and why —
  which is what you need to audit a miss, and the reason a locator failure is checkable rather than
  invisible.
- **Three buckets everywhere** — accept / flag for review / discard — for footnote blocks, tables,
  and marker linkage. Nothing is silently dropped and nothing is silently accepted.

---

## Tools evaluated

| tool | verdict | why |
|---|---|---|
| **Docling** | **chosen** — primary reader | The only option tried that returns a real table *grid* with per-cell row/column spans and bounding boxes, which is what makes row × column structure and marker→cell mapping possible at all. Layout labels are unreliable (below) but the geometry is good. |
| **pdfplumber** | **chosen** — second reader, narrow scope | Used only where Docling provably cannot answer: per-character `size` and baseline, which is the only way to see a superscript marker. Not used for table extraction — its `extract_table` has no concept of stacked headers or spans. |
| Docling's `DocItemLabel.FOOTNOTE` | **rejected** | Trained on journal-style PDFs. Across the five protocols it produced 4 hits total, all in protocol1, and it mislabelled protocol1's own SoA legend 4 lines out of 5 — it returns 0 on protocol9, which has a full legend, and 5 on protocol5, which has 10 footnote lines. Structural scoring replaced it entirely. |
| PyMuPDF | **not adopted** | Equivalent to pdfplumber for the one thing we need it for (`get_text("dict")` gives size and bbox). pdfplumber's `page.chars` is a flatter API for exactly this and one dependency was enough. Would be the drop-in if pdfplumber's licence or speed became a problem. |
| Generic PDF→text (pypdfium2 / pdftotext) | **rejected** | Reading order collapses on a landscape SoA and column identity is gone entirely. Useful only for rasterizing pages for eyeball verification, which is what pypdfium2 is still used for. |
| An LLM reading the raw page | **rejected as the extractor** | Recall is the graded axis and a model that silently drops a row is the exact failure mode to avoid. Used instead in a narrow, validated role where a wrong answer degrades a label rather than losing data. |
| Mistral (`mistral-large-latest`, falling back to `medium` then `small`) | **chosen** for the interpretation layer | Already the provider used in Part 1 of this take-home, so one key covers both. The task is small and structured; model choice is not load-bearing here and any instruction-following model would do. A key whose tier lacks the large model answers **403 rather than downgrading itself**, so `soa/llm.py` walks the chain — 4 of the 5 committed corpus runs landed on `mistral-medium-latest` this way. Set `MISTRAL_MODEL` to pin one and skip the chain. |

---

## Manual verification

Detection and linkage results for all five protocols, with what is wrong and how, are in
[`extractor_test.md`](extractor_test.md) §8.

**Honest status: this is a detection-level pass. The cell-by-cell eyeball pass has not been done on
any protocol, and that is the single biggest gap in this submission.** Every protocol has been run
end to end and its output inspected against Docling's parsed grid and the detected footnote blocks —
that is, against another tool's reading of the page, not against the page itself. The check the brief
asks for — rasterize the page, compare every row, every column and every special cell value against
the rendered source — is still owed on all five.

What *is* verified, and how:

- **Locator**: the selected table's page and dimensions were checked against the source PDF for each
  protocol, and every rejected table was reviewed with its score and rejection reason. All five find
  the right table; no false positive anywhere in the corpus.
- **Footnote text**: read and compared against the legend as extracted, for every protocol. Markers
  and text match.
- **Linkage**: spot-checked on protocol1 p53/p54 at the character level — the two superscripts the
  reader finds (`a` on the Hemoglobin A1C screening cell, `b` on four NPI-X cells) are the only two
  on those pages, and the cells they map to carry `Xa`/`Xb` in Docling's own cell text, which is an
  independent confirmation. Not spot-checked this way on the other four.
- **Row and column counts have not been reconciled against the rendered page on any protocol.**
  Since a dropped row or column is the most heavily penalized failure, read the row and column counts
  below as "what the pipeline produced", not "what the page contains".

Summary of what the corpus run produces:

| doc | SoA pages | fragments | rows | cols | footnotes | linkages | notes |
|---|---|---|---|---|---|---|---|
| protocol1 | 53–54 | 2 → merged | 56 | 16 | 4 | 5 | all footnotes linked, no orphans |
| protocol5 | 50 | 1 | 30 | 11 | 10 | 9 | `*` has no target in the table |
| protocol9 | 26–28 | 3 → merged | 39 | 33 | 4 | 3 | `SCID` is a false-positive marker (an abbreviation) |
| protocol12 | 48 | 1 | 40 | **1** | 12 | 12 | **column axis lost — see below** |
| protocol15 | 25 | 1 | 34 | 9 | 5 | 47 | `Xa` has no target in the table |

---

## Where it breaks, and what it does when it breaks

1. **protocol12: Docling parses the SoA as 42 × 2.** The visit columns collapse into a single column.
   Rows, footnotes and linkage survive; the column axis does not. This is the one failure where the
   tool loses data without flagging it as missing — the extraction is internally consistent and looks
   fine. Everything downstream is honest about what it received; nothing detects that Docling's
   column count is wrong. **This is the most important known defect.**
2. **A continuation page that Docling re-columns will not merge.** `merge_fragments` requires a
   matching column signature. A rotated or landscape continuation parsed with a different width is
   reported as a *separate* schedule rather than silently dropped — visible, but wrong.
3. **Scanned pages.** OCR is off (`do_ocr=False`). A scanned SoA yields no text, no marks, and the
   locator reports no schedule found plus its near-miss list. Turning OCR on is a one-line change in
   `pipeline.py` but roughly triples runtime and has not been benchmarked here.
4. **Rule 4 is the one place vocabulary gates rather than scores.** A landscape or scanned SoA whose
   header row OCRs badly is disqualified outright, whatever its mark share. No corpus protocol trips
   this, so it has not been demoted to a weighted signal — but it is the most likely cause of a total
   miss on an unseen document.
5. **Uniform-case letter runs earn full R1 credit**, so an abbreviation legend line (`SCID : The
   Structured Clinical Interview…`) opens a footnote candidate. These reach `review`, never `accept`,
   and link to nothing.
6. **When the model call fails** (no key, quota, network, malformed JSON) the pipeline keeps the
   rule-based labels and records the failure in `review.interpretation`. No structure is lost.
7. **When nothing scores above threshold** the UI says so and lists the near misses with their
   scores and rejection reasons, rather than showing an empty table.

Runtime is 35s–4min per document (Docling conversion dominates); documents run 4-way parallel.

---

## Assumptions, and the questions for a clinical SME

Written down rather than guessed at silently:

- **Is a repeated legend on each page of a split SoA one footnote set or two?** Assumed one, and
  de-duplicated on (marker, text). If a sponsor ever re-uses marker `a` for a *different* note on the
  continuation page, this silently merges two distinct footnotes. I would want an SME to confirm that
  never happens before trusting the de-duplication.
- **Does `X = Performed at this visit` count as a footnote?** Treated as one, with
  `scope: "value_legend"`, because it changes what every `X` cell means. A consumer wanting only
  marker footnotes can filter on `scope`.
- **Is a drug name in parentheses on its own row a category or an activity?** protocol1 row 22 is
  `(Xanomeline)`; the model calls it a category. Genuinely ambiguous from the page alone.
- **When a cell reads `1&2`, is that two visits or a visit labelled "1&2"?** Captured verbatim and
  not resolved, per "represent the ambiguity".
- **Should a PK sub-schedule with 3 timepoints count as an SoA?** The rule-3 floor (5 rows × 4
  columns) currently says no. That floor is a guess about what is worth surfacing, not a fact.

---

## What I would build next, given two more weeks

1. **Fix the protocol12 class of failure — a table-structure cross-check.** Re-derive the column grid
   from pdfplumber's ruling lines and character x-clusters, and compare against Docling's column
   count. A disagreement is the signal that is missing today, and it would have caught the one defect
   that currently passes silently. This is the first thing I would do.
2. **The cell-by-cell eyeball pass on all five**, rasterized page against extracted grid, recorded in
   `extractor_test.md` §5. Detection-level confidence is not extraction-level confidence and the gap
   should be closed before any of this is trusted.
3. **Row and column recall assertions.** Count the row labels pdfplumber sees inside the table bbox
   and compare against the grid's row count; a shortfall means a dropped assessment. Same for
   columns. Recall is the graded axis and there is currently no automated check on it.
4. **OCR path with a benchmark**, so a scanned protocol degrades instead of returning nothing.
5. **Feed linkage back into footnote scoring.** R5 currently reads Docling cell text and runs before
   linkage; the char-level results would upgrade protocol9's legend from `review` to `accept`. Left
   out because it makes scoring circular and needs its own verification pass.
6. **Rule 4 demoted from gate to weighted signal**, once there is a corpus large enough to show what
   it costs in false positives.

---

## AI tools used

Claude Code (Opus) wrote most of this repository, working from the design in
[`footnote_detect.md`](footnote_detect.md) and the constraints in [`CLAUDE.md`](CLAUDE.md).

**Where it helped.** Fast on mechanical lifting: turning the exploration notebook into modules, the
coordinate-system bookkeeping between Docling and pdfplumber, and the UI. Most valuable when pointed
at measured data — the rule 1 and rule 3 fixes both came from dumping every table's statistics across
all five protocols and reading the separation, rather than reasoning about what an SoA "should" look
like.

**Where it got in the way.** Its first instinct on almost every rule was to pattern-match strings it
had seen in one sample PDF — sponsor names, legend headers like `Abbreviations:`, the literal phrase
"Schedule of Activities". That is precisely the overfit the assignment disqualifies, and it took an
explicit written standard ([`CLAUDE.md`](CLAUDE.md)) plus repeated correction to keep structural
scoring in and template strings out. It also produced a confidently-wrong rule 3 (rewarding table
*density*, when an SoA is sparse) that looked reasonable in prose and selected zero tables in
practice — caught only by running it. The general lesson: the model is good at implementing a
measurement and bad at knowing whether the measurement means anything.
