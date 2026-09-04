# Test report

What was run, what it found, what was changed, and what is still broken.
The plan this executes is [`TEST-PLAN.md`](TEST-PLAN.md).

Everything below is measured. Where a number varies between runs, the report
says so and says why, rather than quoting the best one.

---

## 1. Method

Four layers, run in this order; a failure at one was fixed before the next was
trusted.

| Layer | Command | Scope |
|---|---|---|
| Types | `npm run typecheck` (plus `--noUnusedLocals --noUnusedParameters`) | `intake-agent/src`, `intake-agent/test` |
| Unit | `npm test` | 127 checks over hand-built accessibility trees, no browser, no network |
| Platform contract | `esource-mock && npm test` | each surface built end to end in jsdom, by accessible name only |
| End to end | `bench/matrix.sh 4 2` | every platform × every study, in a real Chromium, twice |
| Part 2 | `python test_soa.py` | extraction rules over cached document dumps |

The end-to-end grader (`bench/lane.mjs`) reads the built study out of the
platform and diffs it against the input file, field by field. It uses the mock's
`__readState()` oracle — **from the checker, never from the agent**, which is
what that hook is for.

Lanes run in batches of four. Sixteen browsers on one machine produce
`settle()` timeouts that read as agent bugs; an early 16-way run showed exactly
that (34/34 became 28/34 under contention) and is the reason `bench/matrix.sh`
exists.

---

## 2. What the agent looked like before this pass

The starting point, measured on the same matrix:

| Platform | smoke (34 fields) | struct (84) | awkward (32) |
|---|---|---|---|
| Mock A (supplied) | 34/34 | 84/84 | 32/32 |
| Veridian | 18/34 | 51/84 | 32/32 |
| TrialForge | **0/34** | **0/84** | **0/32** |
| SourceOne | **0/34** | **0/84** | **0/32** |

Two of the four platforms built nothing at all. Every item on them escalated,
which satisfies the *never silently skip* rule and fails the assignment: the
brief asks the same code to work on a platform it has never seen.

Worse, the ledger and the platform disagreed. On SourceOne the agent reported a
visit **built** while `__readState()` held none — the editor echoes what is being
typed into it as a text node, and the verification counted that echo as evidence
the visit existed. A run that reports work it did not do is the failure mode the
whole design is meant to exclude.

---

## 3. What the runs found, and what changed

Every fix below is stated as the general property it restores, because a fix
that only works on the fixture that found it is not a fix. None of them names a
platform, a control, or a screen.

### 3.1 A draft is not a build

**Found:** SourceOne reported visits and forms built while the platform held
none.
**Cause:** `named()` accepted the text node an editor renders inside the box
you are typing into, so a filled, unsaved form verified exactly like a saved one.
**Change:** a name only counts when it appears outside an editable control
(`insideRole`, walking the accessibility parent chain the compact view flattens
away). Verification for a *filled but unsaved* editor now fails, as it should.

### 3.2 The add control, when no word matches

**Found:** "Define Assessment Point" and "Schedule Event" share no word with
"Add Visit", so both platforms escalated at the first item.
**Change:** three passes, cheapest first — the kind's own vocabulary, then any
add-ish verb, then a structural last resort: *the only action offered inside the
page's content area*, with the page's own ARIA landmarks separating content from
chrome. Two candidates abstain; the model is asked next; a person after that.

### 3.3 …but never the wrong level of the hierarchy

**Found:** the structural pass, asked on a screen listing a visit's forms, chose
"Add Source Record" and built the **next visit as a form inside the previous
one**. Ten extra fields appeared on another run for the same reason.
**Change:** before any fallback fires, if a control matching a *different*
level's vocabulary is on screen, abstain — the screen is the wrong one. And the
fallback is disabled outright for visits and forms while a designer is open,
because a designer holds fields and nothing else.

### 3.4 A card deck names every card, and that is not arrival

**Found:** TrialForge lists visits as cards, each with its own heading. The
arrival check believed all of them, so the agent built a visit's contents onto
the list of visits.
**Change:** only the page's **top-level** heading names the screen, and never
one inside a collection; a title in the content area is not evidence at all —
only chrome (a header bar, a breadcrumb) is. Same fix covers a listbox row that
renders its title as a plain text node.

### 3.5 The control that saves

**Found:** three separate defects.

- No commit control found meant the item closed as *built* anyway. Now it
  escalates: a run that types into an editor nobody saved leaves a draft, and a
  draft nobody mentions is the silent skip the brief calls the worst outcome.
- "Store", "Attach", "Add" are all somebody's Save and no word list ends. The
  structural question replaces it: of the actions **the editor itself brought
  with it** (a name-level diff across the click that opened it), the one that is
  not a way back out is the one that commits.
- A modal property sheet covers the toolbar holding Save. A click aimed at the
  toolbar lands on the backdrop and does nothing — while the page still
  "changes", because focus moved, so it read as success. Now an overlay is
  handled first: either it holds the commit, or it is closed and the search
  continues. Then an overflow menu is opened if one exists, and the ranking is
  re-run against what it revealed.

`Done`, `Finished`, `OK` are ranked **below** an unambiguous Save — including
below a Save still inside an unopened menu — because they close an editor as
often as they commit one.

### 3.6 A way back out, by its arrow as well as its word

"← Return" and "← Up one level" share no word with each other or with "Cancel".
The glyph is the portable half, and `normName` strips it, so it is tested against
the raw name. Used for three things: leaving a designer, ruling a control out of
being Save, and climbing to the root on a platform whose chrome is a breadcrumb
and has no navigation bar to walk sideways along.

### 3.7 `home()` given a goal

**Found:** on a platform with a four-module navigation bar, "go home" clicked the
first module that changed the page and stopped there. Every later item escalated
for want of a screen.
**Change:** `home()` takes a predicate — usually "the control that adds a visit
is on this screen" — and a click that lands somewhere unhelpful is a step on the
way rather than the answer.

### 3.8 A library that is a dropdown, not a row of tiles

**Found:** choosing a type from a `<select>` places nothing until Insert is
clicked; the agent chose the type and then found no control that takes a name.
**Change:** if the editor still has no control that takes a name after the type
is chosen, the add control is clicked once and the plan is re-made. A platform
that places on selection is unaffected, because the condition is never true
there.

### 3.9 Coded values through a bulk box

The vocabulary for a bulk paste box existed and nothing used it, so a designer
offering **only** a bulk box could not receive coded values at all. Now: per row
when the editor has rows, bulk otherwise, pairs either way. The separator is a
documented guess (`code=label`, one per line) and read-back is the judge — a
platform that splits on something else escalates as `field.options` rather than
storing labels with no codes.

### 3.10 The required flag, read from the control

**Found:** the check searched the page text for the word "Required", which is
present whether the box is ticked or not.
**Change:** read the control's state. "No such control on this platform" is an
honest third answer and escalates under its own signature, because a field the
study marks required and the platform collects as optional is a data-collection
defect.

### 3.11 The model does not get to overrule a label

**Found:** asked which entry means `radio`, the model answered "Select One" at
0.95 confidence — the platform's single-select, sitting next to "Select One
(Expanded)", which is the radio. Three fields were built with the wrong type.
**Change:** one veto, and only one — an entry whose name **is** another canonical
type's name cannot be that type. "Select One (Expanded)" only *contains* that
name and nothing else reads it, which is exactly the case the model exists to
settle, so it is still accepted. Anything weaker than an exact collision is left
to the model, because vetoing on a partial match would reject every correct
answer of this shape.

### 3.12 A retry must not leave a second element behind

**Found:** an item that placed an element and then failed verification was
retried, and the retry placed another. Five to ten extra fields per run.
**Change:** the second attempt is spent only when the first left nothing behind.
When it did, the item escalates immediately and the card says there is an
unnamed element on that screen to remove or finish.

### 3.13 A roster of rows is not an element library

**Found:** the structural "am I in a designer" test counted nine buttons at one
depth — three rows of *Edit / Activate / Delete* — as a palette, put the agent in
a designer it was not in, and cost Mock A 44 of 84 fields on the harder study.
**Change:** count **distinct** names. A library's entries all differ, because
each one is a different type; a roster repeats the same three.

This one is worth stating plainly: it was a regression introduced by an earlier
fix in this same pass, and it was caught only because the full matrix was re-run
rather than the two lanes being worked on. That is the argument for the matrix.

### 3.14 A state nothing could ever match

CDP reports `hasPopup`; every reader tested a lower-cased prefix. Overflow menus
were invisible to the agent for that reason alone. State names are now
lower-cased on the way out as well as on the way in.

### 3.15 A bulk-paste box is not a coded-value column

**Found:** every coded list on Veridian came back with the codes one row below
their labels and the last one missing.
**Cause:** "Import list (overwrites the code list)" reads as a code column, so
the rows were counted with one extra at the end and the end-relative row
addressing shifted by one.
**Change:** a descriptor can now name a vocabulary that *disqualifies* a match
(`excludeAny`). Two overlapping vocabularies is a fact of the domain; silently
picking the wrong control because of it is not.

### 3.16 The tie the scorer could break by itself

**Found:** "Number (Decimal)" and "Number (Whole)" tie for `integer` on the word
"number", so layer 1 abstained and the answer depended on the model — which
declined about half the time, costing 17 fields on the supplied mock alone.
**Change:** break a tie by ambiguity. Among tied candidates, drop any that score
at least as highly for *another* canonical type; if exactly one survives, it
wins. "Number (Decimal)" also reads as a decimal and is dropped; "Number
(Whole)" does not and is taken. The rule only ever converts an abstention into
an answer, and the near-neighbour pair the brief warns about is untouched —
neither "Select One" nor "Select One (Expanded)" reads as a radio at all, so
that one still goes to a person.

Mock A's 84-field study now completes with **zero model calls**.

---

## 4. Escalation: can a person act on it?

The requirement is a human gate, not a log. Two things had to be true and only
one was.

**Batching worked already.** N fields blocked by one question produce one card,
listing every item it blocks.

**Answerability did not.** A card offered candidate buttons only for the type
question. On the alternate platforms that meant *every* card said "nothing here
to pick" — the operator could read what went wrong and had no way to fix it from
the panel. Meanwhile three other decisions the loop *does* read back out of the
session's facts had no way to be answered at all.

Now a card offers buttons exactly when the loop reads that answer back, under the
same key the card writes:

| Signature | The question | Read back by |
|---|---|---|
| `type:<canonical>` | what this platform calls a field type | `ensureType` |
| `add:<kind>` | which control adds a visit / form / field | `ensureAdd` |
| `commit` | which control saves — one card per platform | `commitSteps` |
| `context:<segment>` | which control opens a screen | `ensureContextRobust` |

Everything else is a report: it names what did not read back and says the fix is
on the platform. `run.test.ts` asserts the two lists agree, so a signature that
stops being consulted stops offering buttons on the same commit.

Cards also now carry **what the agent could see** — the actions it found outside
the site chrome, the controls that read as a commit and why each was rejected —
so "it could not find the add control" is a sentence someone can check against
the screen in front of them.

---

## 5. Results

Every platform × every study, twice, in a real Chromium. **24 runs, `unaccounted`
zero in all of them** — every plan item ended built or escalated, never silently
skipped.

### 5.1 Structure

**Every visit and every form asked for was created, on every platform, in every
run.** 12 lanes, 2 repetitions, no exceptions. That is the part that was
0-for-6 on two of the four platforms before this pass.

### 5.2 Field recall

Fields verified on the platform against fields asked for by the input file.
Where the two repetitions differ, both are shown.

| Platform | smoke — 34 fields | struct — 84 fields | awkward — 32 fields |
|---|---|---|---|
| Mock A *(supplied)* | 34/34 · 100% | 84/84 · 100% | 32/32 · 100% |
| Veridian EDC | 27/34 · 79% | 84/84 · 100% | 32/32 · 100% |
| TrialForge | 19/34 · 56% | 46/84 · 55% | 10/32 · 31% / 44% |
| SourceOne | 25/34 · 74% | 79/84 · 94% / 87% | 26/32 · 81% |

Overall: **994 of 1200 fields** across the 24 runs.

### 5.3 Determinism

Ten of the twelve lanes produced **byte-identical** built/escalated splits across
the two repetitions. Two did not — `sourceone-struct` (94% / 87%) and
`trialforge-awkward` (31% / 44%) — and in both cases the difference is one
model answer landing either side of the 0.7 confidence threshold. The
deterministic layers did not vary at all: after the tie-break added in §3 below,
Mock A's full study now completes with **zero model calls**.

### 5.4 What the remaining gaps are

Every missing field is on the gate queue with a reason. By category, across the
final runs:

| Category | What it is | Where |
|---|---|---|
| `field.range` | `Floor`/`Ceiling`, `Least plausible value` — a min/max control the designer vocabulary does not reach | TrialForge, SourceOne |
| `field.options` | coded values through a bulk box whose separator is not `code=label` | TrialForge |
| `type:<canonical>` | the library has no entry that reads as this type, and the model would not commit | all but Mock A |
| `editor:*` / `unbuilt:field` | a control the editor does not offer under any word in the vocabulary | TrialForge, SourceOne |

None of these is silent, none of them built the wrong thing, and none of them is
a platform-specific patch away from working — each is a vocabulary gap that the
operator can settle at the gate, or a structural rule that has not been found
yet.

### 5.5 The human gate, end to end

`bench/gate.mjs` runs a lane, answers the cards a person can answer — the
answers live in the script, because the operator's knowledge of their own
platform is exactly what the agent does not have — presses Resume, and reports
what that unblocked.

| Lane | Answered | Result |
|---|---|---|
| `trialforge-smoke` | `type:radio` → *Choice Buttons*, `type:decimal` → *Measured Value* | 6 cards → 4, **19 → 23 fields**, both `context:` cards cleared |
| `sourceone-smoke` | `type:radio` → *Select One (Expanded)* | 6 cards → 5, **30 → 33 fields** |

Both of these failed the first time they were tried, and the failures were real:

- the resumed run started three levels deep inside a *different* visit and could
  not navigate back, so answering the card changed nothing. `ensureContext` now
  goes back to the root and comes in again when it cannot reach a segment from
  where it stands;
- on a designer whose property sheet is a modal closed only by "Finished",
  `dismiss()` could not close it, and an open modal blocks every click aimed
  behind it — so *going* back to the root did not work either. `dismiss()` now
  tries the close vocabulary after Escape and the cancel words.

An answered card that changes nothing is worse than no card, so both are fixed
rather than noted.


---

## 6. Part 2 — SoA extraction

`python test_soa.py` passes: mark classification, marker normalisation, the
header-row walk, superscript detection requiring both size and baseline raise,
and the corpus check — every protocol locates exactly one schedule, on the
expected pages, with page-split tables merged rather than fragmented.

Nothing in the extraction pipeline was changed in this pass; what was added is
the run log below.

**Added after this pass:** a model fallback for the locator
(`intake-soa/soa/fallback.py`). The rules gate hard on an ordered timepoint
axis, so an unseen template can score zero and return no schedule at all. When —
and only when — the rules select nothing, the model is shown a menu of every
table (caption, header rows, first-column labels, shape; **no body cell values**)
and asked which is the schedule; the pick is validated against the real table
ids and re-enters the deterministic pipeline unchanged. It is strictly additive:
with no key it is a no-op and the committed `outputs/*-soa.json` are unchanged.
With every heuristic selection wiped, it recovers the same table the rules pick
on all five protocols. A sibling check flags a schedule whose column axis comes
back narrower than rule 3 requires — protocol12's collapse is no longer silent.
Details in [`intake-soa/ARCHITECTURE.md`](intake-soa/ARCHITECTURE.md).

---

## 7. The run log

Every extraction and every graded build is recorded in one local SQLite file and
rendered as a second page in the Part 2 app.

- **Store:** `intake-soa/outputs/runs.db`, one `runs` table, `sqlite3` from the
  standard library. Both halves share a row shape — *produced*, *expected*,
  *flagged* — because both answer the same three questions: how much came out,
  how much was asked for, and how much still needs a person. Anything else a run
  wants to keep goes in a JSON `detail` column, so a run that learns to record
  something new needs no migration.
- **Writers:** `soa/server.py` logs each document as it finishes (including
  failures, with the traceback); `python -m soa.runs ingest <lane>.json` loads
  the agent's bench output. Agent counts come from the **grader**, not from the
  agent's own tally, so a run that miscounts itself shows up as a discrepancy
  rather than being hidden by it.
- **Reader:** `GET /api/runs`, rendered at `/runs.html` — the same app, the same
  stylesheet, a nav link either way. Read-only: a record of what happened, never
  a way to change it. Each agent run expands to its gate cards, so the escalated
  path is legible from the dashboard without opening the panel.

```bash
cd intake-soa
python -m uvicorn soa.server:app --port 8000
python -m soa.runs ingest ../intake-agent/bench/out/matrix/*.json
open http://localhost:8000/runs.html
```

**Deviation from the request, stated plainly:** this was asked for as a Streamlit
page. The Part 2 app is not Streamlit — it is FastAPI serving a static page — so
a Streamlit dashboard would have meant a second server and a new dependency
beside the app rather than inside it. The binding half of the request was *the
same app as Part 2*, so the page was built there. If Streamlit specifically is
wanted, it is a small addition over the same `runs.py`, which has no web
framework in it at all.

---

## 8. Code review — what was deleted

A pass for over-engineering, applied rather than filed:

| Where | Cut |
|---|---|
| `cdp.ts` | `inflightTotal` — an export with no callers |
| `llm.ts` | an unread local, and a `catch` block whose only reachable path was `throw err` — including an empty `if` body |
| `act.ts` | five locals in `stepOut`/`home` tracking a decision nothing read |
| `run.ts` | an unused import, an unread local |
| `sidepanel.ts` | three flags `jumpTo` set and never read |
| `resolve.ts` | two vocabularies for a reuse-by-copy path that does not exist |
| `ir.ts` | `skeleton()` — "the model plans against this", and nothing did; only a test asserting its own size |

**Left in, deliberately:** `Ledger.reused()` and the `'reused'` state have no
caller — recurring-form reuse is not implemented — so the state can never be
entered. Removing it touches six files for no behaviour change, and the counts
that read it are correct at zero. It is listed here rather than quietly kept.

`recurring()` is called only by tests, and stays: it is the vocabulary the
fixture assertion is written in ("test2's two Hematology forms must not collapse
into one reuse group"), which is a property worth keeping a name for.

---

## 9. Honest limits

- **Four platforms is not many**, and three of them were written for this test.
  The argument that the agent generalises is that nothing in `src/` names any of
  them, that the fixes above are all stated as general properties, and that the
  gaps left are on the gate queue rather than in the database. A fifth platform
  will find something.
- **Model answers vary between runs.** Two runs of the same lane can differ by a
  card when a confidence lands either side of 0.7. Recall figures are given per
  repetition rather than averaged.
- **Vocabulary was widened**, and that is a judgement call: `store` as a commit
  verb, `whole`/`fractional` for the numeric types, `compulsory` for a required
  flag, `return` as a way back. Each is a word the category uses, not a label
  copied off a fixture, and each was added only where a *structural* rule could
  not do the work. The structural rules — landmarks, the diff across an editor
  opening, distinct-name palettes, heading level, the collection test — carry the
  weight.
- **`normName` strips signs**, so `-14` and `14` normalise alike and a window or
  range check cannot tell a negative from its positive. No fixture has hit it.
- **Recurring-form reuse is still not implemented.** Every appearance is built
  independently: correct, and slower.

---

## 10. How to reproduce this

```bash
# platforms
cd intake-takehome-2/esource-mock && npm install && npm run dev

# the extension under test
cd intake-agent && npm install && cp .env.example .env   # paste a Mistral key
npm run typecheck && npm test && npm run build

# the matrix: every platform × every study, twice, in batches of four
bench/matrix.sh 4 2
node bench/summarize.mjs

# the human gate, end to end
node bench/gate.mjs trialforge-smoke
node bench/gate.mjs sourceone-smoke

# part 2
cd ../intake-soa && python test_soa.py
python -m uvicorn soa.server:app --port 8000
python -m soa.runs ingest ../intake-agent/bench/out/matrix/*.json
open http://localhost:8000/runs.html
```

The run without an API key is worth doing once: every question that would have
gone to the model reaches the gate instead, with the reason on the card. That is
the escalation path under its worst conditions, and it is the one a reviewer with
no key will see.

---

## 11. GenAI use — in the product, and in building it

Two different things, deliberately kept apart.

### In the product, at runtime: Mistral, and nothing else

`https://api.mistral.ai/v1/chat/completions` is the **only** GenAI endpoint
either half of this submission calls — `intake-agent/src/llm.ts` for Part 1,
`intake-soa/soa/llm.py` for Part 2. No Anthropic SDK, no OpenAI SDK, no
LangChain: `grep -ri anthropic` across `src/`, `soa/`, `package.json` and
`requirements.txt` returns nothing. Model `mistral-large-latest`, walking
`medium → small` when a key's tier answers 403. One key covers both parts.
Setup is in the [root README](README.md); what each call is allowed to decide
is defended in the two `ARCHITECTURE.md` files. Both parts run without a key —
Part 1 sends every model question to the human gate, Part 2 falls back to its
rule-based labels and loses the locator's recovery path.

### In building it: Claude Code (Anthropic), as a development tool

It is not a dependency, is never invoked by the deliverable, and needs no key to
run anything in this repo. How the work was structured around it:

| Phase | How it was used |
|---|---|
| Architecting | A written standard first — `AGENT.md` repo-wide, a `CLAUDE.md` per part — so the direction and the disqualifying failures never had to be re-explained. Each part's `ARCHITECTURE.md` is the project's memory: any session that settles a design decision records it and its rationale in the same session, so it does not get re-litigated in the next one. |
| Planning | Non-trivial changes were planned before any code: read the existing code, write the plan to a file, settle the open questions, then build. The Part 2 fallback loop went this way — scope, the no-cell-values data boundary, and the column-collapse approach were all decided in review before a line was written. |
| Implementation | Mechanical lifting, and reading measured data rather than reasoning about what things "should" look like — the locator's rule 1 and rule 3 thresholds both came from dumping every table's statistics across the corpus and reading where the separation actually fell. |
| Testing | `TEST-PLAN.md` → this report; the bench harness (`probe`/`lane`/`matrix`/`gate`); and for the fallback, fault-injection (wipe every heuristic selection and check it recovers the same table) plus an adversarial suite of malformed model replies. |
| Review | A standing pass for over-engineering, applied rather than filed — §8 is its output, and the fallback loop got the same treatment (an unused parameter and two accumulator loops cut). |

**Where it got in the way**, stated because it is the useful half: its first
instinct on almost every rule was to pattern-match strings it had just read in
one sample — sponsor names, legend headers, the literal phrase "Schedule of
Activities", a fixture's button label — which is precisely the overfit both
briefs disqualify. It stays out only through an explicit written standard and
repeated correction. The most recent instance is worth naming: asked to flag
Part 2's collapsed column axis, it proposed testing `value_cols <= 1`, a
threshold that matched the one corpus document exhibiting the bug and would have
silently missed a parse that merged twenty visit columns into three. The review
pass caught it and re-derived the test from the locator's own definition of a
schedule's grid. A generated rule that passes on the corpus is not the same as a
correct one, and the corpus cannot tell you which you have.
