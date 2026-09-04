# CLAUDE.md — intake-soa (Take-Home 1b, Part 2)

Read this first, every session. It exists so the direction and expectations of this assignment never
have to be re-explained. Repo-level instructions are in [`../AGENT.md`](../AGENT.md); this file governs
`intake-soa/` only, which is independent of `intake-agent/` (Part 1) — nothing here imports from or
modifies the extension.

Assignment brief: `../Intake AI Take Home 1b.pdf`.

---

## What we are building

An **SoA extraction tool**. Given any clinical trial protocol PDF (80–250 pages, any sponsor, any
template, any vintage), find the Schedule of Activities and produce a faithful structured
representation of it, including footnotes bound to what they modify.

Three parts, all graded:

| # | Part | Requirement |
|---|---|---|
| 1 | **Locator** | Find the SoA in a full protocol. No hardcoded page numbers, no being told where it is. The heading is not always "Schedule of Activities"; the table is not always in the same part of the document; a protocol may contain **more than one** SoA (main + sub-study, PK sub-schedule, LTE schedule). |
| 2 | **Extractor** | Faithful, machine-readable output. Must preserve row × column × cell structure, the grouping hierarchy **on both axes**, visit windows, and footnotes bound to the things they modify. We define the schema and defend it in ARCHITECTURE.md. |
| 3 | **UI** | Upload any protocol PDF, see the extracted SoA rendered. Must work on a protocol the tool has never seen — **not** a static page replaying pre-computed results for the five samples. Simple is fine; visual design is not graded. |

## Deliverables (submission checklist)

- **Code** — runnable, with setup instructions good enough to install and run, including the UI,
  against a protocol PDF we have never seen.
- **Output** — the structured output for all five protocols, committed to the repo.
- **ARCHITECTURE.md** covering: architecture and how the locator and extractor each work; the output schema and
  why; which tools/APIs/models were evaluated, chosen, and rejected **and why**; per-protocol manual
  verification results (what was right, what was wrong, how it was wrong); where the tool breaks and
  what it does when it breaks; what we would build next with two more weeks; which AI tools were used
  and where they helped or got in the way.

A working pipeline whose limits are described accurately beats a claimed near-perfect result. Document
assumptions; write down the question you would ask a clinical SME rather than guessing silently.

---

## Implementation standard

### 1. Generalization is the whole assignment

**The implementation must not be personalized to the five sample PDFs, or to any one of them.** The
same code, unchanged, has to work on a protocol it has never seen. The five samples are a test corpus,
never a specification.

Disqualifying, not style preferences:

- **No hardcoded page numbers, table indices, or document names.** Nothing may key off `protocol1`.
- **No sponsor or template strings.** Not "Eli Lilly", not "Protocol Attachment LZZT.1", not
  "H2Q-MC-LZZT", not a specific footnote header like "Abbreviations:" or "Footnotes to Flow Chart:".
- **No string that was discovered by reading one of the five PDFs.** If a literal came from inspecting
  a sample rather than from the domain, it does not go in the code.
- **Domain vocabulary is allowed only as one signal among many, never as a gate.** The brief itself
  lists the SoA's aliases (Schedule of Assessments, Study Flow Chart, Time and Events Schedule, Table
  of Events) — using those as a *scored hint* is legitimate; requiring one to match before a table can
  be considered is not. Structure decides; text nudges.
- **Detect structurally, then score.** Prefer geometry, font metrics, grid shape, and repetition over
  classifier labels and keyword matching. Where a signal is soft, accumulate points and threshold —
  never an AND-chain of hard gates. This is the pattern already used for footnotes.
- **Every threshold is a named constant** at the top of its module, with a comment saying what it is
  sized against. Tuning is expected; magic numbers buried in expressions are not.

Before writing any literal, ask: *would this still be correct on a 2011 landscape-scanned protocol from
a different sponsor?* If not, it is a signal to score, not a rule to enforce.

### 2. Be faithful, not clever

- **Cell values are not booleans.** `3X`, `3X/2 weeks`, `2X/day`, `Q2W`, `(X)`, `X (if applicable)`,
  `X` with a superscript marker, arrows spanning a range, dashes, dots, numerics, doses, volumes —
  captured **verbatim**. Normalizing to true/false destroys the information the table exists to convey.
- **Do not infer, repair, or resolve** what the document says. Genuinely ambiguous cell → represent the
  ambiguity, do not quietly pick a reading.
- **Hierarchy is data.** Study period / visit name / visit number / day-week / window stack across
  multiple header rows; category rows like "Safety Assessments" are structure, not assessments. Keep
  both axes' hierarchy; flattening loses it.

### 3. Recall over precision, and never silently

- **Missing rows and columns are the most heavily penalized failure.** An extra spurious row is a
  problem; a dropped assessment or a dropped visit is a much bigger one. Design for recall and check
  for drops specifically.
- **Nothing is silently dropped or silently accepted.** Uncertain output is surfaced to a review queue
  with its score and the signals it hit. Three buckets everywhere: accept / flag for review / discard,
  all three printed.
- **Tables span pages** (2–4 pages typical). Headers may repeat, not repeat, or repeat abbreviated;
  a continuation page may be rotated or landscape. Two disconnected fragments, or a silently dropped
  continuation, is a failure.
- **Footnotes are load-bearing** and so is their linkage — see below.

### 4. Verification is by eye, against the page

"Text was found" is not a pass. Rasterize the page, open the source PDF, and compare cell by cell:
every row present, every column present, every special cell value verbatim, every footnote captured
including page-break overflow, and correctly linked to the cell it belongs to. Record results in
[`ARCHITECTURE.md`](ARCHITECTURE.md)'s Limitations section — including what was wrong and how.

### 5. Tool choices get benchmarked and written down

The brief grades *"which tools you evaluated, what you chose, what you rejected and why"*. Currently:
Docling for layout + table structure. Any second reader (pdfplumber / PyMuPDF for char-level font and
position detail) is added only where Docling provably cannot answer the question, and the reason goes
in the doc that owns that decision.

---

## Documents — what lives where, and the rule about keeping them current

| File | Owns |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Architecture, how the locator/extractor/linkage/interpretation work, output schema, tools evaluated, per-protocol results, and limitations. Setup/run steps live in the root `README.md`. |
| `notebooks/` | Experimentation only. Anything that survives moves into the pipeline. |

**The rule: `ARCHITECTURE.md` is the memory of this project.** Every session that finalizes an
implementation or makes a design decision must update it in the same session — not later:

- **State what was decided and why**, and what was rejected. A decision without its rationale gets
  re-litigated next session, which is the cost this file exists to avoid.
- **Move settled questions out of "open questions"** and into the design body with the answer.
- **Record tuning changes** (constant, old → new, why, effect on the corpus) directly in the module
  docstring or in `ARCHITECTURE.md`, whichever a future session would look at first.

(`footnote_detect.md` and `extractor_test.md` used to live here — fragmented, in-progress design and
test-tuning notes from before the pipeline was built. The architecture is built now, and everything
those two docs worked out is folded into `ARCHITECTURE.md` in one place, so they were deleted rather
than left as duplicate, stale copies of it.)

---

## Current status — pipeline BUILT end to end

The notebook is now the exploration record only; everything runs from the `soa/` package.

- **Locator** — BUILT (`soa/locator.py`). Rules 1–4 + page-split fragment merge. Selects the SoA on
  all 5 protocols with no false positive. Rule 1 (pure-`X`) and rule 3 (density) were both wrong and
  were replaced from measured data — see `ARCHITECTURE.md`'s locator section.
- **Model fallback** — BUILT (`soa/fallback.py`). Runs only when the rules score nothing: the model
  picks the SoA from a menu of every table (no cell values), the pick re-enters the deterministic
  pipeline. Also flags protocol12's silent column-axis collapse (`review.column_axis_warning`).
  Strict no-op with no key. See `ARCHITECTURE.md`'s "Model fallback" section.
- **Extractor** — BUILT (`soa/extract.py`). Schema defined and defended in `ARCHITECTURE.md`; cell values
  verbatim, hierarchy on both axes, provenance and review queues in the file.
- **Footnotes** — detection BUILT (`soa/footnotes.py`), marker→cell linkage BUILT (`soa/linkage.py`,
  char-level via pdfplumber + a cell-text pass), page-break attach and continuation merge BUILT.
- **Interpretation layer** — BUILT (`soa/llm.py`). Mistral, narrow scope (header roles + row
  grouping only), validated index-by-index, degrades to rules with no key.
- **UI** — BUILT (`soa/server.py`, `web/`). Multi-upload, delete before run, parallel extraction,
  per-document tabs, marker↔footnote highlighting, JSON download.
- **Corpus run** — DONE. `outputs/*-soa.json` committed for all five, produced by `run_corpus.py`.
- **Smoke check** — `python test_soa.py`.

**Still owed:** the cell-by-cell eyeball pass against rendered pages for protocols 5, 9, 12, 15.
Current confidence is detection-level, not extraction-level, and `ARCHITECTURE.md` says so.
protocol12's 42×2 column-axis collapse is now **detected and flagged** (`review.column_axis_warning`),
but not repaired — the parser still under-counts the columns; the fix is the pdfplumber re-grid in
`ARCHITECTURE.md`'s "What's next".
