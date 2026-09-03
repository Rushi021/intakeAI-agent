# Extractor test plan — 5 protocols

**Temporary working doc.** Plans how the extractor gets reviewed across the corpus on two axes:

- **Axis A — SoA table identification**: did it find the right table? *Logic not finalized — this
  section is a placeholder. Paste the finalized detection logic in §3 when it settles, then write the
  concrete cases.*
- **Axis B — footnote detection**: did it find that table's footnotes, and are they attached to the
  right cells? Rules are settled (R1–R5, see [`footnote_detect.md`](footnote_detect.md)).

Nothing has been run against the corpus yet. Both axes are reviewed against the **rendered page**, not
against extracted text — "text was found" is not a pass.

---

## 1. Corpus

`../takehome-1b/` — gitignored, must exist locally.

| doc | pages | tables | SoA page(s) | legend header | notes |
|---|---|---|---|---|---|
| protocol1 | 97 | 21 | 53–54 | `Abbreviations:` | SoA split across a page break, legend repeated on both pages; `X` / `P` / `X^a` / `X^b` markers |
| protocol5 | | | | | |
| protocol9 | | | | | |
| protocol12 | | | | | |
| protocol15 | | | | | |

Fill the blanks on the first run. Across the corpus the legend headers are known to vary:
`Abbreviations:`, `Footnotes to Flow Chart:`, `Notes on the Schedule of Assessments`, and two
documents with no header at all. None of that is matched by the detector — it is recorded here only so
the review knows what it is looking at.

## 2. How to run

```bash
cd intake-soa && source .venv/bin/activate
jupyter notebook notebooks/01-docling-layout-exploration.ipynb
```

Set `PROTOCOL` at the top, run cells 1→6, record the results. Conversion is ~35s/document on
protocol1; the larger protocols will be slower.

To eyeball a page, rasterize it with `pypdfium2` (already a Docling dependency — no new install):

```python
import pypdfium2 as pdfium
page = pdfium.PdfDocument(str(PROTOCOL))[52]          # 0-indexed: p53
page.render(scale=2).to_pil().save(OUTPUT_DIR / "p53.png")
```

---

## 3. Axis A — SoA table identification *(pending)*

> Placeholder. Once the SoA locator logic is finalized, paste it here and expand into cases.

Fields each case will record:

| field | meaning |
|---|---|
| expected page(s) | where the SoA actually is, from the rendered PDF |
| expected table id / bbox | which Docling table is the SoA |
| continues across pages? | is the SoA one table or N page-fragments |
| detected page(s) / table id | what the locator returned |
| verdict | pass / partial / miss |
| failure mode | wrong table (flow chart, TOC, dosing table), partial table, extra table, split table not merged |

Pass = the right table, the whole table, and no extra table. A locator that returns the SoA plus the
dosing table is a fail, not a partial.

---

## 4. Axis B — footnote detection

Per document, from cell 6's printout:

| field | source |
|---|---|
| accepted blocks | `ACCEPT` section |
| flagged blocks | `REVIEW` section |
| discarded blocks | `DISCARD` section |
| markers per block | printed per block |
| linked / unlinked markers | printed per block |
| attached table + attach mode | `same-page` / `page-break` / `none` |

**Assertions that must hold on every document:**

1. Every real footnote block under the SoA table is in `accept`.
2. Nothing in `discard` is a real footnote line (check by eye — this is the expensive direction of
   error, a dropped footnote is invisible downstream).
3. Parenthetical CRF cross-references (`(06)`, `(07)` … `(33)`) never reach `accept`. They should not
   even form a block.
4. A legend split by a page break is one block, not two, and keeps its R4.
5. A legend with no header line is still found (the detector never reads headers, so this should be
   free — confirm it).
6. Rating scales and enumerated lists (`0 = …`, `1 = …`, `1. Female subjects…`) do not reach `accept`.

**Known baseline, protocol1** (from the saved Docling JSON, not a fresh run):

| verdict | blocks | detail |
|---|---|---|
| accept | 2 | p53 (`X`, `Xa`, `Xb`, `P`) and p54 (`X`, `Xb`), both score 6, all markers linked |
| review | 2 | ADAS-Cog rating scales p58/p59 — clustered marker-lines under no table, score 3 |
| discard | 10 | stray `*` footnote, `SCORING:` / `ACCEPTABILITY:` headers, single-line rating scales |

Old label-based count for the same document: 4 items, of which 2 were not standalone footnotes.

## 5. Manual spot check

2–3 blocks per document, chosen from the `accept` list:

1. Rasterize the page.
2. Confirm the block is the legend under the SoA table and its text is complete (not truncated at a
   line wrap or page break).
3. For each marker, find the cells in the rendered table that carry it, and confirm the linkage record
   names the right row label and column header. **This is the check that matters** — text presence
   proves nothing about attachment.
4. Record verdict + note below.

| doc | page | block | markers | linkage correct? | note |
|---|---|---|---|---|---|
| | | | | | |

Until Step 3 (char-level superscript detection) exists, most markers will report `unlinked` because
Docling drops the superscript. That is expected; the spot check then verifies only block-to-table
attachment, and the unlinked list is the worklist for Step 3.

---

## 6. Result summary — fill per run

**Run 2026-09-02**, after the split-marker fix (§7), from the saved Docling dumps in `outputs/` —
detection only, not yet eyeballed cell-by-cell against the rendered pages.

| doc | accepted | flagged | discarded | markers | linked | unlinked | docling label count | note |
|---|---|---|---|---|---|---|---|---|
| protocol1 | 2 | 2 | 10 | 14 | 6 | 8 | 4 | p53/p54 legends both accepted at 6 |
| protocol5 | 1 | 1 | 2 | 13 | 10 | 3 | 5 | p51 legend, all 10 markers (`*`…`****`, `Xa`–`Xf`), page-break attach to the p50 SoA |
| protocol9 | 0 | 2 | 0 | 5 | 0 | 5 | 0 | legend found on p29 but scores 3 — R4 misses, see `footnote_detect.md` §4 |
| protocol12 | 4 | 1 | 4 | 18 | 6 | 12 | 7 | p49 legend 12 markers (`Xa`–`XJ`); 3 single-marker table legends also accepted |
| protocol15 | 2 | 1 | 2 | 8 | 5 | 3 | 5 | p25 legend `*`, `Xa`–`Xd` |

The `docling label count` column is Docling's `footnote` label, kept only to show the gap: it is 0 on
protocol9 (which has a full legend) and 5 on protocol5 (which has 10 footnote lines). It is not a
score for the detector, and the corpus cell no longer reports it as one.

## 7. Tuning log

Weights and thresholds are named constants at the top of cell 6. One row per change.

| date | constant | from → to | why | effect on corpus |
|---|---|---|---|---|
| 2026-09-02 | `MAX_MARKER_FRAGS` / `MAX_FRAG_LEN` | new (2 / 2) | a superscript is a separate text run, so `X^a` arrives as `X a` or `b X` and never matched the single-token head | protocol5 4 → 10 markers and review → accept; protocol12 3 → 12; protocol15 1 → 5; protocol1 unchanged |

---

## 8. Run 2026-09-02 (b) — full pipeline, all five protocols

Produced by `python run_corpus.py --no-model` from cached Docling dumps. **Detection and linkage
only — not yet eyeballed cell-by-cell against the rendered pages.** That pass is still owed and is
what §5 exists for; nothing below should be read as verified extraction.

| doc | SoA pages | fragments | rows | cols | footnotes | linkages | unlinked footnotes |
|---|---|---|---|---|---|---|---|
| protocol1 | 53–54 | 2 (merged) | 56 | 16 | 4 | 5 | — |
| protocol5 | 50 | 1 | 30 | 11 | 10 | 9 | `*` |
| protocol9 | 26–28 | 3 (merged) | 39 | 33 | 4 | 3 | `SCID` |
| protocol12 | 48 | 1 | 40 | **1** | 12 | 12 | `****`, `Xa`, `Xb`, `Xc`, `Xg` |
| protocol15 | 25 | 1 | 34 | 9 | 5 | 47 | `Xa` |

**Known wrong, in order of severity:**

1. **protocol12 — Docling parses the SoA as 42×2.** The visit columns collapse into a single column,
   so 1 column is extracted where the source has roughly a dozen. Rows and footnotes survive; the
   column axis does not. This is a Docling table-structure failure upstream of everything here, and
   it is the one case where the tool loses data it does not flag as missing — the extraction looks
   internally consistent. Locator still finds the right table (score 1.5, rule 3 fails on shape).
2. **protocol9 `SCID` is a false-positive marker.** `SCID : The Structured Clinical Interview…` is an
   abbreviation definition, not a footnote; it opens a candidate line because a uniform-case letter
   run passes R1 (`footnote_detect.md` §7 predicted exactly this). It reaches `review`, never
   `accept`, and links to nothing — visible, not silent.
3. **protocol5 `*` and protocol15 `Xa` have no target in the table.** Either the marker is genuinely
   absent from the grid or Docling dropped it and neither the char-level nor the text-level pass
   recovered it. Both are reported in `review.footnotes_never_used_in_table`.
4. **protocol9 has no accepted footnote block** — its p29 legend scores 4 (R1+R2+R3+R4, no R5),
   because its markers are symbols that do not recur inside Docling's cell text. It lands in
   `review` and its footnotes are still extracted and carried into the output.

## 9. Tuning log (continued)

| date | constant | from → to | why | effect on corpus |
|---|---|---|---|---|
| 2026-09-02 | locator rule 1 | `x_pct > 0.90` on `^\d*X$` → `mark_share ≥ 0.60` | The pure-`X` test fired on protocol1 only. Real SoA cells are `1X`, `3X/week`, `b X`, `Weekly x 2 weeks` — exactly the non-boolean values the brief warns about — so the rule rejected 4 of 5 real SoAs. `is_mark()` accepts any X-family mark and still refuses bare integers, which is what keeps count and dose tables out. | measured separation: real SoAs 0.75–1.00, every other table in the corpus 0.00 |
| 2026-09-02 | locator rule 3 | `empty/non_empty < 0.80` (density) → body rows ≥ 5 and value cols ≥ 4 (grid shape) | Density rewarded the opposite of an SoA, which is sparse by nature; at threshold 2.0 it selected **nothing**, the blocking issue in `footnote_detect.md` §6. Grid shape is what actually distinguishes a schedule from a small lookup table. | resolves the blocker; fires on every real SoA except protocol12's mis-parsed 42×2 |
| 2026-09-02 | `SOA_SCORE_THRESHOLD` | 2.0 → 1.5 | With rule 1 now separating cleanly, requiring all three rules cost recall for no precision: protocol9 and protocol12 have real SoAs that fail one rule each. Recall over precision, per the brief. | 5/5 protocols select their SoA; no false positive anywhere in the corpus |
| 2026-09-02 | R4 page-break gate | `block.top ≥ 0.75 × page_height` → first-content-on-page **or** markers recur in the table above | The fractional gate failed whenever a continuation page repeats a title (protocol9) or the legend's own first line sits above the block (protocol12). Evidence of marker reuse is a better test than geometry. | protocol9 legend review→attached; protocol12 0→12 markers attached, its SoA becomes selectable |
| 2026-09-02 | linkage | new: char-level superscripts (pdfplumber) + cell-text markers | `footnote_detect.md` §3, previously NOT BUILT. Size *and* raised baseline both required — size alone flags small header text. The text pass is needed because symbol markers are routinely set full-size inline (`* Morphine`, `Vital signs**`). | protocol1 5, protocol5 9, protocol9 3, protocol12 12, protocol15 47 linkages |
