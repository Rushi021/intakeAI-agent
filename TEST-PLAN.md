# Test plan

Covers both halves of the assessment:

| | What it is | Where |
|---|---|---|
| **Part 1** | A Chrome extension that reads a study IR and builds it into an eSource form designer by driving the browser | `intake-agent/` |
| **Part 2** | Schedule-of-Activities extraction from protocol PDFs | `intake-soa/` |

The plan is written against the **contracts**, not against the supplied mock or
the supplied protocols. Every check below states the property it is proving, and
would still be a fair check if the mock were replaced tomorrow. Where a check
does depend on a specific artefact, it says so and says why.

---

## 0. The rule that shapes everything else

> The agent must work on an eSource platform it has never seen, and on a study
> it has never seen, **with no code changes**.

So a test that would still pass if the code contained a hardcoded selector,
button name, screen order or library entry for the supplied mock is not evidence
of anything. Concretely, this plan forbids itself:

- asserting on CSS selectors, element ids, or DOM structure;
- asserting that a control is called what the supplied mock calls it;
- reading the mock's debug hooks (`__readState`, `__exportState`, `__resetState`)
  from anywhere inside the agent. They are used **only** by the grader in
  `bench/lane.mjs`, which stands in for the human reviewer;
- fixing a failure by adding the failing platform's exact string to a
  vocabulary. Vocabulary may be widened to words the *category* uses; a fix that
  only works because it names this fixture is a failed test, not a passed one.

Everything the agent decides has to come from one of three generic sources:
the **accessibility tree**, the **IR schema**, or a **human answer** captured at
the gate.

---

## 1. Test layers

Cheapest first. A failure at layer *n* is not investigated at layer *n+1*.

| Layer | What it proves | Cost | Command |
|---|---|---|---|
| **L0 Types** | No unused code, no unsound narrowing | seconds | `cd intake-agent && npm run typecheck` |
| **L1 Unit** | Every pure decision, over hand-built accessibility trees (127 checks) | ~5 s | `cd intake-agent && npm test` |
| **L2 Platform contract** | Each test platform is *winnable* by name alone | ~1 s | `cd intake-takehome-2/esource-mock && npm test` |
| **L3 End-to-end matrix** | The whole agent, in a real browser, on every platform × every study | minutes–hours | `cd intake-agent && node bench/all.mjs` |
| **L4 Repetition** | The same result twice, and a rerun that does not duplicate | hours | `bench/matrix.sh <batch> <reps>` |
| **L5 Escalation quality** | Every stop is legible and actionable by a person | with L3 | `node bench/summarize.mjs` + the panel |
| **L6 Part 2** | Extraction rules, over cached document dumps | ~5 s | `cd intake-soa && python test_soa.py` |

---

## 2. L1 — unit checks, and what each one is really asking

These run with **no browser**: `test/helpers.ts` builds accessibility trees by
hand, so a check describes a *shape of page*, never a page. That is what makes
them generic — the same test covers every platform that renders that shape.

### 2.1 Perception

| Property | Why it matters |
|---|---|
| Pruning keeps every actionable node and drops layout noise | A dropped node is a control the agent cannot use |
| Every parentless node is walked, not just the first | Same-origin iframes hold whole forms; a missed root is a missed form |
| A node kept out of the compact view is still reachable by ref | Pruning must lose tokens, not information |
| Text that merely echoes its control's label is dropped; text in a nameless wrapper is kept | Designer titles live in unnamed spans |
| Settling requires two consecutive stable samples **and** a quiet window | One sample can match because the sampler was starved, not because the page stopped |
| A pinned `timeoutMs` never feeds the adaptive ceiling | Tests and callers stay deterministic |
| The ceiling grows on timeout and never shrinks | Successes are right-censored by the current ceiling, so only failures carry information |
| Errors are detected through ARIA roles and `invalid`, never colour | A red-is-error heuristic is a hardcoded theme |

### 2.2 Locating and writing

| Property | Why it matters |
|---|---|
| `locate` abstains when two nodes match equally well | A wrong ref clicks the wrong control and reports success |
| `nth` is the only way to address a deliberate repeat, and negative `nth` counts from the end | Option rows are addressed from the end because an option column shares vocabulary with the field's own label box |
| Steps carry descriptors, never refs; `apply` re-reads before every step | Every write invalidates the next step's ref |
| Read-back distinguishes "wrong value", "control gone", and "now ambiguous" | Three different causes, three different fixes |
| A click whose purpose is to replace its own control passes on evidence of movement, not on a value | The decoy-save trap is exactly this shape |
| A value read back from `name` when there is no `value` still reports which one it compared | Custom widgets carry their selection as the accessible name |

### 2.3 Deciding

| Property | Why it matters |
|---|---|
| The type scorer abstains on a tie, on a thin margin, or when the winner reads more like another canonical type | Two adjacent library entries differing by one word is the standard trap |
| A model answer naming a ref that is not on the page is rejected | Model output is untrusted input |
| A model answer below the confidence threshold escalates | A cheap question beats a wrong build |
| Each question is asked at most once per session | Bounds the bill and the wall time |
| The library is discovered, never assumed: a cluster of same-depth entries where half the canonical vocabulary resolves | The agent is not told a library exists |
| A field-add question never sees the visit vocabulary | Mis-scoped vocabulary finds a real control — the wrong one |

### 2.4 Verifying and escalating

| Property | Why it matters |
|---|---|
| Coded values compare as **code+label pairs**, never by count | A bulk paste that dropped the codes has the right length |
| Option codes match as whole tokens | Code `M` is a substring of `Male` |
| Ranges match as whole tokens | `30` is a substring of `300` |
| A skip rule is read from the **controls that hold it**, never from page text | A value like `No` is a substring of half the words on any screen |
| The required flag is read from the control's **state**; "no such control" is a third answer that escalates | The word "Required" is in the editor whether it is ticked or not |
| A name that only appears **inside a box being typed into** does not count as built | A filled, unsaved editor otherwise verifies exactly like a saved one |
| `assertTerminated` proves every plan item ended built or escalated | A silently skipped field is the worst failure in the brief |
| N fields blocked by one question produce **one** card | Escalations batch by question, not by field |
| A card offers buttons **iff** the loop reads that answer back under the same key | A dead button looks answered and changes nothing on Resume |
| Every signature the loop can raise has an explanation | "Signature: xyz" is not an action a person can take |

---

## 3. L2 — is each platform winnable at all?

Before blaming the agent for a 0 % run, prove the platform can be built by name
alone. `esource-mock/test/surfaces.test.ts` builds a small study end to end on
each surface **in jsdom**, finding every control only by its visible or
accessible name — never by id, class or position — and asserts the read-back
matches (types, required flags, range and units, coded value pairs, one skip
rule), and that an element added and then navigated away from leaves no trace.

If a surface fails this, the surface is unfair and the fixture is the bug.

---

## 4. L3 — the end-to-end matrix

Two independent axes, so a failure attributes to one of them.

```
platforms × studies = every combination, no code change to either side
```

| Axis | Varies | Answers |
|---|---|---|
| **Platform** | chrome, layout, save location, list markup, caption↔control wiring, coded-value entry, element library, vocabulary — all different | "does it work on a platform it has never seen?" |
| **Study** | visit/form/field counts, all 13 canonical types, recurrence, bottom-up skip logic, name collisions, long code lists, non-ASCII, negative and fractional ranges | "does it work on a study it has never seen?" |

Each lane is one browser, one profile, one platform tab, one panel; lanes share
nothing but the dev server, so they cannot contaminate each other.

**Run it**

```bash
cd intake-takehome-2/esource-mock && npm run dev    # the platforms
cd intake-agent && npm run build                   # the extension under test
node bench/all.mjs                                  # every lane
node bench/all.mjs sourceone                        # every study on one platform
node bench/all.mjs smoke                            # every platform on one study
node bench/summarize.mjs                            # one table over the results
```

Batch rather than run all at once — sixteen browsers on one machine show up as
`settle()` timeouts and read as an agent bug:

```bash
bench/matrix.sh 4 1        # batches of four, one repetition
```

### 4.1 Grading

The grader (`bench/lane.mjs`) compares the **built study** against the **input
file**, field by field, and reports every difference as a finding with a
severity:

| Severity | Meaning |
|---|---|
| `missing` | in the input file, not on the platform — the most heavily penalised |
| `wrong` | present with the wrong type, flag, range, units, options or rule |
| `extra` | on the platform, not in the input file |

Ground truth is read through the mock's own oracle, used the way it is meant to
be used: **by the checker, never by the agent**.

### 4.2 Pass criteria

A lane passes when **all** hold:

1. `unaccounted == 0` — every plan item ended built or escalated. Anything else
   is an agent bug, not a result.
2. `missing` findings are covered by an open gate card. A missing field with no
   card is a silent skip.
3. No `extra` findings — nothing was built twice.
4. No `wrong` findings on type, coded values, range, units or skip logic. These
   are the checks the brief calls out; a wrong one is worse than a missing one
   only because nobody is told.
5. The run completed rather than timed out.

Recall (`fields built / fields asked for`) is **reported, not asserted**. A
platform where the agent honestly escalates 100 % of items has passed this plan
and failed the assignment; the two facts are recorded separately on purpose.

---

## 5. L4 — repetition, reruns and load

| Check | How | Passes when |
|---|---|---|
| **Determinism** | Same lane, 3 repetitions | Same built/escalated split, ±0 fields. Divergence is either a model answer or a timing bug; the ledger's `settled` column says which |
| **Idempotency** | Run a lane to completion, then run the same lane again into the same tab without resetting | No duplicated visits, forms or fields; already-built items are re-verified (`verified-existing`) rather than rebuilt |
| **Resume** | Answer a gate card, press Resume | Only the items that card blocked are retried; confirmed history is not re-verified |
| **Interruption** | Press Stop mid-run | The in-flight item is the only one left `in-flight`, and the next run re-verifies it before trusting anything after it |
| **Load** | Run batches while the machine is loaded | `settled: false` appears in the ledger rather than a wrong read; `settleGapMs` names a starved sampler |
| **Model unavailable** | Build with no API key | Every question that would have gone to the model reaches the gate instead, with the reason on the card. No crash, no silent guess |

---

## 6. L5 — is the escalation actually actionable?

The brief asks for a human gate, not a log. For **every** open card, a person
with the platform in front of them must be able to answer these four questions
from the card alone:

1. **What is being asked?** — one sentence, in the platform's own terms.
2. **Why did the agent stop?** — which layer abstained, and what it saw.
3. **What did it already try?** — the controls it clicked and what read back.
4. **What is blocked?** — how many plan items, and which.

And the card must be **answerable where an answer exists**: a card offers
candidate controls from the live page exactly when the loop reads that answer
back under the same key the card writes. Today that is four signatures:

| Signature | The question | Read back by |
|---|---|---|
| `type:<canonical>` | what this platform calls a field type | `ensureType` |
| `add:<kind>` | which control adds a visit / form / field | `ensureAdd` |
| `commit` | which control saves | `commitStep` |
| `context:<segment>` | which control opens a screen | `ensureContextRobust` |

Every other signature is a **report**: it says plainly that the fix is on the
platform, and offers no button, because a button nothing reads would look
answered and change nothing.

**Check, per run:** for each open card, `explain(signature).kind` is `choice` iff
that signature appears in the table above; every `choice` card either offers at
least one candidate or says why the screen offers none; every card names at
least one blocked plan item; and no plan item is escalated without a card.

---

## 7. L6 — Part 2, SoA extraction

Same principle: assert the **rules**, not the protocols.

| Check | Property |
|---|---|
| `test_marks` | A mark cell is `X`, `3X`, `(X)`, `X a`, `3X/week` — and never a bare number, a measurement, or prose |
| `test_markers` | A superscript arrives as its own text run on either side of its base glyph, and normalises to the same key from both the legend and the character reader |
| `test_header_stack` | The header walk catches a second header row the parser did not flag; missing it leaks timepoint labels into the body and wrecks the mark share |
| `test_superscript_needs_size_and_raise` | Size alone flags small-caps column headers; both size **and** baseline raise are required |
| `test_corpus` | Every protocol in the corpus locates exactly one schedule, on the expected pages, with page-split tables merged rather than fragmented |

The corpus check is the one artefact-specific test here, and deliberately so: it
is a regression net over cached document dumps, and skips cleanly when a dump is
absent.

**Not covered:** the layout of the review UI has been exercised structurally but
not looked at in a browser on every path; open it before recording anything.

---

## 8. The run log

Every extraction and every graded build lands in one local SQLite file
(`intake-soa/outputs/runs.db`) and is rendered at `/runs.html` in the Part 2 app.
Both halves share a row shape — *produced*, *expected*, *flagged* — so the same
page answers the same three questions for either: how much came out, how much
was asked for, and how much still needs a person.

```bash
cd intake-soa
python -m uvicorn soa.server:app --port 8000     # extraction runs are logged as they finish
python -m soa.runs ingest ../intake-agent/bench/out/matrix/*.json
python -m soa.runs list                           # or open http://localhost:8000/runs.html
```

Counts for agent runs come from the **grader**, not from the agent's own tally,
so a run that miscounts itself shows up here as a discrepancy instead of being
hidden by it.

---

## 9. Adding a platform or a study — no code change

| To add | Do this | Then |
|---|---|---|
| A platform | Drop a JSON in `esource-mock/public/surfaces/`; `layout` is eight enums | Add one line to `PLATFORMS` in `bench/all.mjs` |
| A study | Drop an `.ir.json` in `intake-takehome-2/data/` matching the schema | Add one line to `INPUTS` in `bench/all.mjs` |

Nothing in `intake-agent/src/` changes for either. If it has to, that is the
finding.

---

## 10. Known limits

- **The mock is not in the repository.** `intake-takehome-2/` is gitignored as
  supplied material, so the alternate surfaces and the study fixtures live only
  on this machine. The harness that drives them (`intake-agent/bench/`) is
  tracked; the platforms it drives are not.
- **Visual rendering is unverified.** Both UIs were exercised through jsdom and
  through the accessibility tree, never looked at on every path.
- **Model answers vary between runs.** Two runs of the same lane can differ by a
  card when a confidence lands either side of the threshold. The determinism
  check in §5 is over the built/escalated split, not over which layer answered.
- **`normName` strips signs.** `-14` and `14` normalise alike, so a window or a
  range check cannot tell a negative from its positive. No fixture has ever hit
  it; a study with `-2` and `2` on the same field would.
