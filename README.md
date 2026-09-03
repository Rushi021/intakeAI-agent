# Intake AI — Take-Home Assignments

This repo contains two independent deliverables:

| Part | Folder | Assignment | What it does |
|------|--------|------------|--------------|
| **1** | [`intake-agent/`](intake-agent/) | Take-Home 1a | Chrome extension — builds a study IR into an eSource platform |
| **2** | [`intake-soa/`](intake-soa/) | Take-Home 1b | Protocol PDF → Schedule of Activities extraction pipeline, with an upload UI |

Part 1 status: pass 2 — the agent perceives, decides, acts, verifies and escalates.
It writes to the platform. No end-to-end run against a live page has been
performed yet; see [What is and is not proven](#what-is-and-is-not-proven).

Part 2 status: the pipeline runs end to end and locates the SoA in all five sample
protocols. Verification is detection-level, not cell-by-cell; the known defects are
listed in [`intake-soa/README.md`](intake-soa/README.md).

```
.
├── intake-agent/       Part 1 — Chrome extension (TypeScript)
│                       architecture in intake-agent/ARCHITECTURE.md
│                       design in intake-agent/PASS2.md
├── intake-soa/         Part 2 — SoA extraction from protocol PDFs (Python)
│                       architecture and schema in intake-soa/README.md
│                       design record in intake-soa/footnote_detect.md
├── intake-takehome-2/  supplied material — the eSource mock and the study IR
├── takehome-1b/        supplied material — five protocol PDFs (local only, gitignored)
└── *.pdf               the assignment briefs
```

---

## Part 2 — Running the pipeline

Extract the **Schedule of Activities** from any clinical trial protocol PDF: find the table without
being told where it is, extract it faithfully (rows, columns, verbatim cell values, hierarchy on both
axes), and bind each footnote to the cells it modifies.

Python 3.10+ (3.12 used here). Full architecture, output schema, tool evaluation and known defects:
[`intake-soa/README.md`](intake-soa/README.md).

### 1 · Install

```bash
cd intake-soa
python3 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

First run downloads Docling's layout and table-structure models (a few hundred MB, cached after).

### 2 · Provide a Mistral API key — optional

```bash
export MISTRAL_API_KEY=...
```

Looked up as `$MISTRAL_API_KEY` → `intake-soa/.env` → `intake-agent/.env`, so **the key you already
set up for Part 1 is picked up automatically**. Without one the pipeline still runs end to end; only
the header-role and row-grouping labels fall back to rules, and it says so in the UI.

The model is deliberately kept away from the data: it receives one table's header rows and row labels
and nothing else — never a cell value, never the protocol prose — and its answer is validated
index-by-index before use. Nothing it returns can drop a row or a visit.

### 3 · Run the UI

```bash
python -m soa.server                 # http://127.0.0.1:8000
```

Drag in one or more protocol PDFs, remove any you did not mean to add, press **Run agent**.
Documents are converted in parallel (4 at a time). Each finished document gets its own tab showing:

- the layout inventory Docling produced for that file — pages, tables, and every element label with
  its count;
- each Schedule of Activities it found, as a grid with sticky headers, category rows drawn as
  structure, and cell values verbatim;
- the footnotes, with **click a marker to light up every cell it modifies**, and click a footnote to
  do the reverse — the check that a linkage is actually right;
- a review queue of everything the tool was unsure about, and the raw JSON to download.

It works on a protocol it has never seen; nothing in the UI is pre-computed.

### 4 · Run headless

```bash
python run_corpus.py                 # every PDF in ../takehome-1b/ -> outputs/<name>-soa.json
python run_corpus.py --no-model      # rules only, no API key needed
python run_corpus.py protocol9       # one document
python test_soa.py                   # smoke check, seconds, no PDF conversion
```

The committed structured output in [`intake-soa/outputs/`](intake-soa/outputs/) is produced by
exactly this script — all five protocols, nothing hand-edited.

Protocol PDFs must exist locally in `takehome-1b/` (from `takehome-1b.zip`; gitignored) for the
headless scripts. The UI needs no such thing — upload anything.

### What it produces

| doc | SoA pages | fragments | rows | cols | footnotes | linkages |
|---|---|---|---|---|---|---|
| protocol1 | 53–54 | 2 → merged | 56 | 16 | 4 | 5 |
| protocol5 | 50 | 1 | 30 | 11 | 10 | 9 |
| protocol9 | 26–28 | 3 → merged | 39 | 33 | 4 | 3 |
| protocol12 | 48 | 1 | 40 | **1** | 12 | 12 |
| protocol15 | 25 | 1 | 34 | 9 | 5 | 47 |

Runtime is 35s–4min per document; Docling conversion dominates. protocol12's column count is a known
defect, not a typo — Docling parses that SoA as 42×2 and the visit columns collapse. That and the
rest of the failure modes are in [`intake-soa/README.md`](intake-soa/README.md).

---

## Part 1 — Running the pipeline

Two terminals. Node 18+ for the mock, Node 22+ to run the agent's tests.

### 1 · Start the eSource platform

```bash
cd intake-takehome-2/esource-mock
npm install
npm run dev
```

Open <http://localhost:5173/>. You should land on **Visit Schedule** with an
empty visits table — that empty state is correct.

`http://localhost:5173/?reset=1` clears the study without a reload.

### 2 · Provide a Mistral API key

The agent calls **Mistral AI**, and you supply your own key. `.env` is the only
way in — there is no key field in the extension.

```bash
cd intake-agent
cp .env.example .env
```

Open `.env` and paste your key (get one at <https://console.mistral.ai> →
**API Keys**):

```dotenv
VITE_MISTRAL_API_KEY=your_key_here

# Optional — defaults to mistral-large-latest
VITE_MISTRAL_MODEL=
```

The key is read at **build time**, so `.env` must exist before step 3.
Editing it later does nothing until you re-run `npm run build` and press
**reload** ↻ on the extension card.

> **Please note.** Vite inlines the key into `dist/sidepanel.js` in plain text,
> so anyone holding the built extension folder can read it. `.env` and `dist/`
> are both in `.gitignore`, so neither is committed — `.env.example` ships blank
> and is the only one of the two in the repo. **Use a key you are willing to
> revoke, and rotate it when you are done reviewing.**

A run costs very little: the model is asked once per *question*, not once per
field, so a full 195-field build is a handful of calls rather than 195.

### 3 · Build and load the extension

```bash
cd intake-agent
npm install
npm run build
```

`chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select `intake-agent/dist/`.

Changed `.env` afterwards? Re-run `npm run build` and hit **reload** ↻ on the
extension card — the key is baked in at build time, so an edit alone does
nothing.

### 4 · Run the agent

On the mock's tab, click the extension icon to open the side panel. Two tabs.

Open **Trace → Model** and click **Test connection** first — a two-token round
trip that proves the key works before a long run spends anything. That section
reports the provider, the model and whether a key was found; it never displays
the key.

#### Build — the operator's view

1. Load `intake-takehome-2/data/abc-101-study.ir.json`.
2. Click **Start build**.

The agent attaches to the tab you are looking at, confirms the study, and works
through the plan. Chrome shows a *"started debugging this browser"* banner while
attached — that is expected, and **Detach** in the Trace tab clears it.

Three things appear while it runs. All are derived from the run ledger on every
render and stored nowhere else, so none of them can drift from what was actually
built:

| | |
|---|---|
| **The tally** | `built · escalated · not reached · unaccounted · plan items`. **Unaccounted must be zero.** If it is not, the agent has a bug and says so rather than showing a green result. |
| **Needs a decision** | One card per *question*, not per field. The first three single-selects that fail to resolve are one card listing all affected items — not three, and not the forty more that would follow. |
| **Progress** | Visits → forms → fields, each `complete` / `in-progress` / `escalated` / `not-reached`. An escalated row is a button that jumps to its gate card. |

**The run never blocks.** It queues what it cannot resolve, finishes everything
else, and stops. Nothing escalated was ever committed — the *must not silently
commit* requirement is met by the item never being built, not by a confirmation
dialog you have to sit and watch.

**Answering a card** means clicking one of the candidates read out of the live
page. There is no free-text box: a typed answer could name a control that is not
there. The answer is cached as a platform fact, which unblocks every affected
item at once, and **Resume** re-runs only those items.

**Stop** finishes the current item and halts.

#### Re-running

| You did | What happens |
|---|---|
| **Start build** again, same panel | Same session. Confirmed history is trusted, the interrupted item is re-verified first, learned platform facts are reused. |
| Closed and reopened the panel | New session. The agent returns to the platform root and re-verifies **every** item against the input file before building anything. Facts are rediscovered. |

Either way a re-run is a diff against what is on screen, not a replay of the
input file — no duplicate visits, forms or fields. Presence alone never counts
as success: an item that looks present still has to pass the same `verify()`
used at build time.

#### Trace — the engineering view

| Section | Shows |
|---|---|
| Input file | Study id and title, the six counts, and a visit → form → field tree with every type, range, coded-value count and skip rule |
| Perception | Accessibility nodes read, nodes kept, percentage dropped, and **whether the page had settled** when it was read |
| Ledger | One row per plan item: which input-file entry it came from, what was decided, where that decision came from, what read back, how many attempts. Filterable to escalated rows |
| Pruned view | Exactly what the model is sent — scoped to the open modal when there is one |
| Full detail | Enter a `ref` and expand around it, pull dialog controls, query nodes near coordinates |
| Model | Provider, model, whether a key was found, and **Test connection** |
| Capture options | Screenshot toggle, off by default |
| Detach debugger | Ends the session and clears the banner |

### 5 · Verify

```bash
cd intake-agent
npm test        # 70 checks — no browser, no network
npm run typecheck
```

Then, by hand — this is the part that actually matters:

1. `__readState()` in the mock's DevTools console, **as the reviewer, never from
   the agent**, and diff the dump against the input file: 4 visits, 28 forms,
   195 fields, every type, every code/label pair, every range and unit, 13 skip
   rules, the right forms marked repeating.
2. Re-run **without** resetting the mock, same panel. Confirm no duplicates and
   that the second pass is mostly verification.
3. Close the panel, reopen, run again. Confirm the full top-down re-verification
   and still no duplicates.
4. **Then change the mock and run again unchanged** — rename the element library
   entries, move Save, reorder the screens, swap a dropdown for a radio group.
   That is the experiment the brief cares about.

---

## What is and is not proven

Stated plainly, because a submission that overclaims is worse than one that is
short.

**Proven — 70 checks, no browser, no network:**
the plan and its dependency ordering, the stable form key behind the 17-of-28
relationship, the type scorer and its acceptance rule against two unrelated
vocabularies, `locate`'s matching *and its abstention*, the page-comparison
primitives, settling, `verify` (including the two traps: an unnamed element, and
an option list with the right count and no codes), the ledger accounting, the
identity tri-state, liveness, and the derived status tree.

**Not proven:**

- **No end-to-end run against a live page has been performed.** Four CDP calls
  cannot be unit-tested — `DOM.getContentQuads` geometry, `Input` dispatch,
  `Network` counting, `DOM.scrollIntoViewIfNeeded`. They are thin wrappers, and
  they are the part most likely to need adjustment on first contact with a real
  designer.
- **Recurring-form reuse is not implemented.** The agent knows which 17
  definitions sit behind the 28 appearances; it builds every occurrence
  independently anyway. Correct, merely slower.
- **The second mock is not written.** Until it exists, "it generalizes" is an
  argument from construction — no CSS selector, element id, button label,
  element-library name or screen order appears anywhere in `src/` — rather than
  a measured result.

Supplied material in `intake-takehome-2/` and the PDFs are for this assignment
only and are not redistributed.
