# Footnote detection, SoA table identification & marker linkage — design

Reference for the SoA extraction pipeline. **All sections are now BUILT and shipped as a package** —
the notebook that prototyped them is kept only as the exploration record:

| section | module |
|---|---|
| §1–2 footnote detection | [`soa/footnotes.py`](soa/footnotes.py) |
| §3 marker → cell linkage | [`soa/linkage.py`](soa/linkage.py) |
| §4 page-break handling | [`soa/footnotes.py`](soa/footnotes.py) `attach_table`, [`soa/locator.py`](soa/locator.py) `merge_fragments` |
| §6 SoA table identification | [`soa/locator.py`](soa/locator.py) |

Detection has been run against all 5 protocols (see [`extractor_test.md`](extractor_test.md) §8); the
cell-by-cell eyeball pass against rendered pages is still owed.

**Pipeline order** — each step consumes the one before it:

```
Docling parse  ──▶  §1–2  footnote blocks     ──▶  §6  SoA table identification
(tables + text)      (scored, per table)            (rule 2 = "does a block hang off me?")
                            │                                    │
                            └──────────▶ §3 marker→cell linkage ◀─┘
                                         (scoped to the selected SoA table)
```

Footnote detection runs **first** and is table-agnostic: it attaches a block to whichever table sits
above it, SoA or not. Table identification then reuses those attachments as one of its signals, and
linkage (§3) runs last, scoped to the tables §6 selected.

---

## 0. Why not the layout label

The first version gated on Docling's `DocItemLabel.FOOTNOTE`. That classifier was trained on
journal-style PDFs; the small-font legend blocks under SoA tables in clinical protocols are not what
it saw in training. Across the 5 test protocols it produced 4 hits total, all in protocol1, and it
still got protocol1's SoA legend wrong.

The SoA legend on protocol1 p53, with Docling's label per line:

| line | label |
|---|---|
| `Abbreviations:` + `CT = computed tomography; ECG = electrocardiogram` | `text` (two items sharing a y-band) |
| `X = Performed at this visit.` | `text` |
| `Xa = Performed at this visit if patient is an insulin-dependent diabetic.` | `text` |
| `Xb = Performed at this visit and via telephone interview 2 weeks following this visit.` | `text` |
| `P = Practice only - It is recommended that a sampling of the CIBIC+, ADAS-Cog, DAD, and NPI-X…` | `footnote` |

1 of 5. Meanwhile the structural signals are all present and unambiguous: table 8 on that page has
bbox bottom `y=168.4`, the block starts at `y=165` (a 3pt gap), and the markers `X` / `P` recur inside
that table's cells. So: **ignore the label, score the structure.**

The cross-protocol comparison cell used to report `DocItemLabel.FOOTNOTE` counts in a column named
`footnotes`, which read as "the detector found 5 footnotes in protocol5" when it meant "Docling's
classifier applied its footnote label 5 times". It now runs `detect_footnotes()` per document and
reports both, side by side.

Non-goal: no header string, section title, or sponsor template is matched anywhere. The detector never
looks for "Abbreviations", "Footnotes to Flow Chart", or "Schedule of Activities".

---

## 1. Candidate marker-line detection

**Line reconstruction first.** A visual line is not a Docling text item — on protocol1 p53,
`Abbreviations:` (x=130) and `CT = computed tomography…` (x=202) are two separate items at the same
`y`. Group items per page into y-bands (`LINE_Y_TOL_PT = 3`), order by x, concatenate. Page furniture
(`page_footer`, `page_header`, `picture`) is dropped; `section_header` / `title` is kept only as a hard
block break. When the pipeline moves to pdfplumber for Step 3, its line-level extraction can replace
this — whichever preserves reading order best for the document at hand.

**Leading-token shape.** A line opens like a footnote marker if its first token is a single character
class:

| shape | examples |
|---|---|
| repeated symbol, any length | `*`, `**`, `*****`, `†`, `‡` |
| letters of uniform case, any length | `a`, `aa`, `A`, `CT`, `RT` |
| `X` + short letter suffix | `Xa`, `Xb`, `XA` (the uppercase form falls out of the uniform-case rule) |
| small integer | `1`, `2`, `12` |

**No length cap** — a run of five asterisks or a doubled letter is still a marker. What disqualifies a
token is *mixing* classes (`3a`, `Abbreviations`, `(06)`) or matching a numbered-list pattern
(`1. Female subjects must…` — enumeration, not a marker).

**The marker can arrive split in two.** A superscript is its own text run in the PDF, and Docling does
not glue it back onto its base glyph: `X^a - POMS, BSCS…` reaches us as the line `X a - POMS, BSCS…`,
and when the raised glyph's baseline sorts first, as `b X - atomoxetine will be administered…`. So the
head is *one token, or two of at most `MAX_FRAG_LEN = 2` characters* (`MAX_MARKER_FRAGS = 2`), joined
in both orders and kept if either passes the shape test — `X a` and `b X` both canonicalise to `Xa` /
`Xb`. Two longer tokens are two words, not a split marker, so ordinary prose before a dash still
fails.

This was the single largest recall bug found on the corpus: before the fix, protocol5's 10-line legend
scored as 4 lines (the `*`…`****` block) and its six `X^a`–`X^f` lines were never candidates at all;
protocol12 lost 9 of 12 the same way. It is a general PDF fact, not a protocol5 quirk.

**Separator or run-on.** The token must be followed by a separator (`-` `–` `—` `=` `:`) then prose, or
run directly into prose for symbol markers (`*Days -15 through -9 are allotted…`). Letter tokens with
no separator are indistinguishable from ordinary sentence-initial words, so they are not candidates.

The numbered-list disqualifier is free rather than a special case: `.` is not a separator, so
`1. Female subjects…` never tokenizes.

---

## 2. Scoring

Candidates are grouped into **blocks**: runs of consecutive marker-lines, tolerating up to
`MAX_INTERRUPT_LINES = 1` non-candidate line inside the run (a wrapped continuation line, a legend
header). A heading ends a block outright. Trailing interrupt lines are trimmed off the block.

| signal | pts | check |
|---|---|---|
| R1 | +1 | leading token shape per §1 |
| R2 | +1 | separator, or direct run-on into a sentence |
| R3 | +1 | block contains ≥ 2 marker-lines |
| R4 | +1 | block sits immediately below a table — same page within `MAX_TABLE_GAP_PT`, or below a table that ran to the previous page's bottom |
| R5 | +2 | a block marker recurs inside that table's cells |

R5 has to look for the same distortions inside cells: a cell reads `X a` / `b X` for a superscripted
value, and a symbol marker arrives glued to the end of a row label (`Chemistries plus liver function
tests**`). `cell_tokens` therefore offers each cell as its whole text, its words, adjacent short-word
pairs joined both ways, and any trailing symbol run.

Aggregation: R1/R2 are evaluated per line and awarded once for the block; R3/R4/R5 are per block. Not
an AND-chain — points accumulate.

| score | verdict |
|---|---|
| ≥ `ACCEPT_SCORE` (6), **or** R5 plus ≥ `ACCEPT_R5_MIN_OTHER` (2) other signals | auto-accept |
| 3–5 | flag for human review — surfaced, never silently dropped or accepted |
| < 3 | discard |

Max score is 6, so the threshold alone means "all five fired". The `R5 + 2 others` clause is what does
the real work: it accepts a legend that lost R3 or R4 (a single-line legend, or a block separated from
its table by a page break) as long as its markers are provably reused in the table.

**Why the CRF-number case falls out for free.** One test protocol's flow chart uses parenthetical
numbers `(06)`, `(07)` … `(33)` as CRF form cross-references. They appear *inside* the table but never
recur as marker-lines below it, so they never form a candidate block at all — nothing to score. No
special rule needed. Symmetrically, the ADAS-Cog rating scales in protocol1 (`0 = 0-2 items named
incorrectly`, `1 = 3-5 items…`) *are* clustered marker-lines but sit under no table: R1+R2+R3 = 3 →
review, never accepted.

**Tuning.** Every weight and threshold is a named constant at the top of cell 6. Retune there after
running the corpus; record what moved in `extractor_test.md`.

---

## 3. Linkage: which cell does each footnote belong to — BUILT (`soa/linkage.py`)

Docling gives table structure and cell text but not the sub-cell font/position detail needed to see a
superscript glued onto a cell value. This step is the reason a second reader is needed.

**The cell value is always `X`.** The marker is a superscript riding on it (`X^a`, `X^b`), and the
cell may carry a count prefix (`2X`, `3X`). `Xa` is never a value in the source document — it is only
what Docling sometimes produces when it flattens a superscript into the cell text. On protocol1 both
SoA tables come back as `X` ×65, `P` ×4, and a handful of flattened `Xa` / `Xb`; every other
superscript is dropped. So cell-text matching (all R5 can do today) systematically under-reports, and
the unlinked list from cell 6 is the input to this step.

Plan:

1. **Docling** locates each table on the page and its row/column/cell grid with bounding boxes.
2. **pdfplumber** (`page.chars`) reads the same page for every character's
   `{text, x0, y0, x1, y1, size, fontname}`. PyMuPDF `page.get_text("dict")` is the equivalent
   fallback. `pdfplumber` is **not yet a dependency** — add it to `requirements.txt` when building this.
3. For each cell bbox, take the characters inside it. A character (or short run) is a marker candidate
   when its `size` is meaningfully below the modal size for that line/cell **and** its baseline sits
   above the surrounding baseline. Both conditions — size alone catches small-caps, offset alone
   catches noise.
4. Match those in-table candidates against the marker tokens of the accepted footnote block for **the
   nearest table above that block only**. Never match against every block in the document: one
   document has many tables, each with its own footnote set, reusing the same symbols.
5. Emit one linkage record per match:

```json
{
  "table_id": "table-8",
  "row_label": "Vital signs",
  "column_header": "Visit 3",
  "cell_bbox": [x0, y0, x1, y1],
  "marker": "b",
  "footnote_text": "Once during the week preferably at the first visit of the week.",
  "confidence_score": 8
}
```

**Coordinate trap.** Three systems in play: Docling text/table `prov.bbox` is `BOTTOMLEFT`, Docling
table *cell* bboxes are `TOPLEFT`, pdfplumber is top-left with its own page height. Normalize once at
the boundary, not per comparison.

**Review queues** — both surfaced, neither dropped:

- an in-table marker candidate with no match in an accepted block → a marker exists but its definition
  wasn't found: a missed block, a page-break continuation, or genuinely undefined in the source;
- an accepted block whose markers appear in no table on the page → keep, flagged `unlinked, pending`
  (it may belong to a table continuing from an adjacent page).

---

## 4. Page-break handling — BUILT

Tables in these protocols routinely end at a page boundary with the legend flowing onto the next page.

- A table whose last row is at the bottom of a page with no block below it → check the top of the next
  page before concluding there are no footnotes. *(Implemented: `attach_table`'s `page-break` path,
  gated on `PAGE_TOP_FRAC` / `PAGE_BOTTOM_FRAC`.)*
- **`PAGE_TOP_FRAC` is gone; the positional gate was wrong twice over.** *(Settled.)* It failed on
  protocol9, whose legend sits under a repeated `Table 4, Continued` / title stack at `y=438` on a
  792pt page, and on protocol12, whose legend has one of its own footnote lines above it (a `*` whose
  superscript Docling dropped) so it is not the first content on the page either. `attach_table` now
  requires the previous page's last table to end at the page bottom, plus **either** the block being
  the first real content on the page (`first_content_on_page`, which ignores headings and short
  lines) **or** its markers demonstrably recurring in that table's cells. Evidence beats geometry.
  Effect: protocol9's legend attaches, protocol12 goes 0 → 12 attached markers.
- A **page-split SoA** is merged into one logical schedule by `locator.merge_fragments`: selected
  tables on consecutive pages sharing a column signature (width + label-column count) are one SoA.
  Deliberately not matched on header *text*, since a continuation page may abbreviate or omit its
  headers. Exercised by protocol1 (p53–54, 2 fragments) and protocol9 (p26–28, 3 fragments).
  *Ceiling:* a continuation Docling re-columns (rotated/landscape) will not merge and is reported as
  its own schedule — visible in the output, not silently dropped.
- A **legend repeated on every page** of a split table is de-duplicated by (marker, text) in
  `extract.assemble`, so protocol1's twice-printed legend yields one footnote list, not two.

---

## 6. SoA table identification — BUILT (cell 7)

Docling gives us N tables per document (21 on protocol1) with no idea which is the Schedule of
Activities. This step scores every one of them and returns **all** tables above a threshold — a
protocol may hold a main schedule plus a sub-study, PK, or long-term-extension schedule, so this is
never "take the top one".

Same discipline as the footnote rules: structure is scored, headings and captions are never matched.
Nothing keys off a section title, a sponsor template, or the word "schedule".

### The rules

| rule | pts | check |
|---|---|---|
| 1 | +1 | **X-value share.** Over non-empty **body** cells (header rows and label columns excluded), the fraction whose full trimmed value matches `^\d*X$` — `X`, `2X`, `3X`, `6X`; the leading digits are a repetition count, the cell is still an X-type marker. `Normal`, `Q2W`, `(if applicable)`, dashes, arrows, free text do not count. Fires above `X_VALUE_MIN_PCT` (0.90). |
| 2 | +0.5 | **Footnote block present.** A block from §1–2 attached to this table (`verdict != discard`), i.e. marker-lines under the table whose markers recur inside it. Fallback: a short line (≤ `FOOTNOTE_HEADER_CHARS`) directly under the table ending in `:` — a legend header, detected by shape, not by its words. |
| 3 | +0.5 | **Density.** `empty/non_empty < 0.80` **and** `non_empty/empty > 2`. |
| 4 | gate | **Timepoint axis.** Some header row, or the row-label column, carries ≥ `MIN_TIMEPOINT_LABELS` (3) ordered timepoint-like labels — either study-design vocabulary (visit, day, week, cycle, screening, baseline, follow-up, …) or a monotonic integer sequence. **Failing this disqualifies the table outright**, whatever it scored. |

Max 2.0. `SOA_SCORE_THRESHOLD = 2.0` — a table is the SoA only when **all three** scored rules fire on
top of the rule 4 gate. Every eligible table at or above it is returned, ranked; everything rejected is
printed with the reason (gated out vs. low score) so misses are visible rather than silent.

### Decisions made building it

**Rule 2 is wired to the footnote detector, not to header strings.** The rule as drafted allowed
matching labels like "Notes on the Schedule of Assessments" / "Footnotes to Flow Chart" /
"Abbreviations:". Those are sponsor-template strings and are banned by the project standard
([`CLAUDE.md`](CLAUDE.md)) — and unnecessary, because §1–2 already finds those blocks structurally on
protocol1 without reading a word of their headers. What survives of the label branch is its *shape*: a
short line ending in a colon directly under the table. This is the only implementation of rule 2 and
it is strictly more general than the string list.

**Docling's `column_header` flag is not trustworthy on stacked headers, and it broke rule 1.** On
protocol1's SoA it flags the `VISIT | 1 | 2 | 3 …` row but *not* the `WEEK | -2 | -.3 | 0 | 2 …` row
beneath it. Those 8 timepoint labels then counted as body cells and dropped the X-value share from 92%
to 82% — below the 0.90 threshold, so the real SoA scored 0.5 and was **not selected**. Fix: after the
flagged rows, keep walking down while a row still reads as a header (all its non-label cells are
timepoint words or integers, and none is an X-value); the first row containing an X-value ends the
header stack. This is an implementation of "exclude header rows", not a change to the rule.
*Side effect:* on a table with no X-values at all the walk can consume every row, leaving an empty body
(seen on protocol1's small 2-column tables). Harmless — such a table cannot pass rule 1 anyway.

**`SOA_SCORE_THRESHOLD = 2.0` — set by decision, all three rules must fire.** This is the full score,
so the threshold is an AND across rules 1–3 on top of the rule 4 gate. It maximises precision and
gives up the recall margin: an SoA whose footnotes were missed (rule 2 = 0) or whose fill pattern
fails rule 3 is not returned, whatever its X-share. The ranked table of every candidate and its
per-rule breakdown is still printed, so a near-miss at 1.5 is visible — it is just not selected.

**⚠ Rule 3 was density, and density is the opposite of an SoA — settled, rule replaced.** An SoA is
sparse by nature (protocol1's fragments score `empty/non_empty` of 2.15 and 2.29 against a rule
requiring < 0.80), so at threshold 2.0 the locator selected **nothing, on every protocol**. Neither
direction of a fill-ratio rule is the real signal. Rule 3 is now **grid shape**: ≥
`MIN_GRID_BODY_ROWS` (5) body rows across ≥ `MIN_GRID_VALUE_COLS` (4) value columns. What separates a
schedule from a small lookup table is that it is a large grid, not how full it is.

**Rule 1 was a pure-`X` test and it was overfitted to protocol1 — replaced by mark share.** `^\d*X$`
over 90% of body cells fired on protocol1 and nowhere else: protocol9's SoA is `1X`/`5X`/`6X`,
protocol12's is `X`/`3X/week`, protocol15's is `b X`/`3 X`/`Weekly x 2 weeks`, protocol5's carries
split superscripts. The brief's "cell values are not booleans" warning describes the corpus exactly,
and the rule was fighting it. `is_mark()` now accepts any X-family mark — count prefixes, frequency
suffixes, parenthesised, split superscripts — capped at `MAX_MARK_CHARS` so a sentence is not a mark,
and **refuses bare integers**, which is what keeps protocol15's adverse-event count table (`0`/`1`/`2`
across 41×12) and protocol12's dose table out. Measured over the corpus: real SoAs 0.75–1.00, every
other table 0.00. `MARK_SHARE_MIN = 0.60` sits in the middle of that gap.

**`SOA_SCORE_THRESHOLD` lowered 2.0 → 1.5.** With rule 1 separating that cleanly, requiring all three
rules bought no precision and cost real recall — protocol9 (no footnote attachment on 2 of 3
fragments) and protocol12 (mis-parsed shape) each fail exactly one rule. Selecting on rule 1 plus
either rule 2 or rule 3 finds all five SoAs with no false positive anywhere in the corpus.

**Flattened superscripts cost the old rule 1 about 4 points.** `Xa` / `Xb` (Docling flattening `X^a`) do not
match `^\d*X$` and count against the ratio: protocol1 p53 is 65 `X` + 4 `P` + `Xa` + `Xb` = 91.5%,
just over the line. Once §3's char-level pass exists, the marker can be stripped before matching and
this recovers to ~94%. Left literal for now, per the finalized rule.

### Verified on protocol1 (from the saved Docling dump, no re-conversion)

| table | page | size | gate | x-share | rule 2 | rule 3 | score | selected @ 2.0 |
|---|---|---|---|---|---|---|---|---|
| table-7 | 53 | 30×9 | ordered numeric `1,2,3,4,5,7…` | 92% of 71 | block, markers `P X Xa Xb` | 2.15 → no | **1.5** | ✗ |
| table-8 | 54 | 30×9 | ordered numeric `9,10,11,12,13…` | 96% of 68 | block, markers `X Xb` | 2.29 → no | **1.5** | ✗ |
| table-5 | 37 | 7×4 | passes | 33% | none | 0.0 → yes | 0.5 | ✗ |
| 16 others | — | — | 16 gated out on rule 4 | — | — | — | 0.0 | ✗ |

The two real SoA fragments are correctly ranked first and both carry their own footnote block, but
neither clears 2.0 — rule 3 is the only rule they fail, and they fail it because they are sparse. See
the ⚠ above. At a 1.0 or 1.5 threshold these two, and only these two, are selected.

The two fragments are reported as two tables. Merging a page-split SoA into one logical table is
extractor work, not locator work, and is not built.

---

## 7. Open questions, to settle after the corpus run

- R5 still reads Docling cell text, which loses most superscripts, and it runs *before* linkage in
  the pipeline. Feeding §3's char-level results back to re-score R5 would upgrade protocol9's legend
  from `review` to `accept`. Deliberately not done: it makes scoring circular and the block is
  already surfaced with its footnotes extracted, so the cost of leaving it is a flag, not a loss.
- Uniform-case letter runs longer than 2 (`CT`, `RT`) earn full R1 credit. On protocol1 that is correct
  (abbreviation legends), but it also lets `SCORING:` and `ACCEPTABILITY:` open a candidate line. Both
  land in `discard` today on R3/R4/R5; check whether that holds on the other four.
- The single-line interrupt tolerance never attaches a *leading* non-candidate line, so a legend header
  ("Abbreviations: CT = …") is excluded from its own block. Harmless for footnote extraction, but the
  abbreviation legend is likely wanted downstream — decide whether it is captured here or separately.
- `MAX_TABLE_GAP_PT = 80` is a guess sized off protocol1's 3pt gap. Tighten or loosen from real spreads.
- **Rule 3's direction** (§6) — *blocking*: with the threshold at 2.0 and rule 3 as written, no table
  can be selected on protocol1. Reward density as specified, or invert to reward sparsity? Decide from
  the `empty_ratio` column printed for every table across the corpus.
- **Rule 4 is the one place vocabulary gates rather than scores** — a landscape/scanned SoA whose
  header row OCRs badly would be disqualified outright, whatever its X-share. Consider demoting it to
  a heavily-weighted signal if the corpus produces a miss.
- Does a page-split SoA need merging before or after §3 linkage? Markers can be defined on one
  fragment's legend and used on the other's cells.
