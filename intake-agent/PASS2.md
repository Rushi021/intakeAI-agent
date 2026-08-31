# Pass 2 — the complete pipeline

Pass 1 perceives. This is everything from *the operator drops a JSON file* to
*the study is built, verified, and every unresolved question is sitting in a
queue a human can clear in minutes* — on an eSource platform the agent has
never seen.

**Status: planned, not built.** This is the master document. Two annexes hold
detail rather than repeating it here:

| Doc | Covers |
|---|---|
| [PASS2-MECHANICS.md](PASS2-MECHANICS.md) | `settle`, `diff`, `classify`, `errorsIn`, modal scoping, `dismiss` |
| [PASS2-RERUN.md](PASS2-RERUN.md) | session, liveness, two-phase ledger, `formKey`, reuse, `statusTree` |

---

## The guarantee

Every plan item ends in exactly one of two states: **built and verified**, or
**escalated with full context**. Never a third, silent state where the agent
moved on without either.

That is weaker than "it always figures it out" and it is the honest one. A
missed field nobody notices is the most heavily penalized failure in the brief,
and `assertTerminated` enforces this rather than claiming it — `built +
reused + escalated === total`, printed as `unaccounted 0` or reported as a bug
in the agent.

The constraint shaping everything below: **no selector, element id, button
label, element-library name, or screen order may be hardcoded.** What this
platform calls a `single_select`, where its Save lives, whether its bulk paste
appends or replaces — all of it is worked out on the page, at run time.

---

## The pipeline, end to end

```
 1  load JSON        parseIR → planItems            no browser
 2  Start build      attach → settle → snapshot
 3  identify         is this a platform showing our study?      escalate if not
 4  session          liveness → same-session resume  |  new session
 5  home             new session only: return to the root screen
 6  per plan item    ensureContext → verify → resolve → act → verify
 7  escalate         unresolved questions queue by signature; the run never blocks
 8  finish           assertTerminated; status tree is complete
 9  operator         clears gate cards; Resume re-runs only affected items
```

Steps 6 and 7 are the loop. Everything else happens once per run.

### Where the two rerun paths diverge

| | Same session (liveness passes) | New session |
|---|---|---|
| Entry | current screen | `home()` first |
| Per item | read the **ledger** — skip what is confirmed built, re-verify the frontier | run **`verify()`** on every item before deciding it is done |
| Platform facts | reused from the session cache | rediscovered from scratch |

**Presence never justifies skipping. A ledger entry from a live session does.**
That single rule reconciles "never skip verification" with "a same-session
rerun should be fast" — the full table is in
[PASS2-RERUN.md](PASS2-RERUN.md#rerun-decision-table).

---

## Modules

Three new files. Dependency direction stays one-way, as in [README.md](README.md):

```
sidepanel → run → { resolve, act, perceive, ir, llm }
                    resolve → llm
                    act     → cdp
                    perceive → cdp
```

| File | Holds | Not responsible for |
|---|---|---|
| `src/act.ts` | `locate`, the four write primitives, navigation (`home`, `ensureContext`), `dismiss`, per-write read-back | eSource, the IR, what to build |
| `src/resolve.ts` | Layers 1–3: synonyms, the comparative scorer, library discovery, the batched LLM call | acting; it returns steps, it does not execute them |
| `src/run.ts` | the loop, the session, the ledger, the gate queue, `verify`, `statusTree` | CDP; it composes the modules below it |

Extended: `src/ir.ts` gains `planItems`, `formKey`, `recurring`.
`src/perceive.ts` gains the mechanics annex. `src/sidepanel.ts` / `.html` gain
the status tree and gate queue in **Build**, the ledger in **Trace**.

---

## Stage A — the plan, from the JSON

```ts
export type PlanItem =
  | { id: string; kind: 'visit'; visit: Visit }
  | { id: string; kind: 'form';  visit: string; form: Form }
  | { id: string; kind: 'field'; visit: string; form: string; field: Field };
```

`id` is the path — `Screening/Demographics/Date of Birth`. It is the
traceability key (points at one entry in the input file), the idempotency key,
and the ledger key. One identifier, three jobs.

`planItems(ir)` emits visits, then forms under each, then fields under each
form — **fields dependency-ordered inside the form**: a field carrying
`skip_logic.when_field_label` is emitted after its controller. Kahn's algorithm
over the form's fields, ~10 lines, IR order as tiebreak so ordering is stable
and mostly unchanged. A cycle (none expected in the 13 rules) emits the
remainder in IR order and lets the skip-logic sub-step escalate rather than
deadlock.

`formKey(f)` and `recurring(ir)` — a stable structural key per form definition,
so the 17-distinct-over-28-appearances relationship is computed rather than
assumed. Specified in [PASS2-RERUN.md](PASS2-RERUN.md#recurring-forms).

Nothing in this stage touches a browser. It is pure and fully tested.

---

## Stage B — entry: identify, then decide the session

### Study identity, on every run

Before anything is written, the current snapshot must be shown to describe
**this** study on **a** platform:

```ts
export type Identity =
  | { ok: true;  matched: 'protocol_id' | 'title' | 'human' }
  | { ok: false; reason: 'different-study'; saw: string }      // hard stop
  | { ok: 'unconfirmed'; reason: 'no-anchor' };                // one gate card, then proceed

export function identify(snap: Snapshot, ir: IR): Identity;   // pure
```

Deterministic: normalize accessible names on `heading`, `banner` and `main`
landmark nodes and look for `ir.study.protocol_id` or `ir.study.title`.

**Three outcomes, and the difference between the last two is the whole point:**

| Outcome | Meaning | Behaviour |
|---|---|---|
| `ok` | the study is named on the page | proceed |
| `different-study` | a study identifier is on the page and it is **not** ours | **hard stop.** Building into the wrong study is unrecoverable |
| `unconfirmed` | **no** study identifier is discoverable anywhere | one gate card, then proceed |

Not every platform badges the study name in its accessible tree. Treating
"absent" the same as "wrong" would refuse to run at all on those platforms —
a structural failure dressed up as a safety check. So an unconfirmed identity
raises **one** gate card (*"I cannot tell which study this platform is showing.
Is this the right place to build ABC-101?"*), and the operator's answer is
cached as the fact `study.anchor: 'absent'` with `source: 'human'`. The run
proceeds and is never asked again this session.

`different-study` still refuses, and is the only identity outcome that does.

> **Study creation is out of scope and escalates.** The reference mock starts
> with the study already present and nothing under it. A platform that requires
> the study to be created first surfaces one gate card saying so. Guessing at a
> study-creation flow is exactly the kind of speculative build the brief warns
> against.

### Session

A session is the **side panel document's lifetime**, not a service worker's —
`sw.ts` holds no state and deliberately never will. `liveness(session, snap)`
returns live or a reason, and any failure downgrades gracefully to the
new-session path. Full definition in
[PASS2-RERUN.md](PASS2-RERUN.md#session).

---

## Stage C — navigation: `home` and `ensureContext`

An item cannot be built from wherever the browser happens to be. To build
`Screening/Demographics/Sex` the agent must be inside Screening, inside
Demographics, in the field designer. On the reference mock you land on Visit
Schedule; on an unseen platform you may land anywhere, and forms may be
reachable before visits.

```ts
// act.ts
export async function home(snap: Snapshot): Promise<Snapshot>;
export async function ensureContext(
  s: Session, path: { visit?: string; form?: string },
): Promise<Snapshot | { escalate: string }>;
```

**`home()`** — new-session runs only, before anything is in flight. Prefers an
in-page route: a link or button inside a `banner` or `navigation` landmark
whose accessible name matches the study title, the protocol id, or a root
vocabulary — *home, dashboard, studies, study, overview, schedule*. Click,
`classify()` the transition, confirm arrival with `identify()`. Falls back to
`Page.navigate` at the tab's origin only if no in-page route scores. Never
called mid-item, because a route change can discard an uncommitted working copy.

**`ensureContext()`** — descends toward the target. If the current snapshot
already names the visit and form in a heading or breadcrumb, it is a no-op.
Otherwise: locate a node whose normalized name matches the next path segment,
click it, `classify()`, and **confirm arrival** — a heading, breadcrumb, or
landmark now carrying that name. Reaching a screen is not the same as believing
you reached it. Bounded depth; failure escalates under `context:<path>` rather
than letting the loop build into the wrong screen.

Both use `locate()`, both re-snapshot, neither knows a platform's navigation
model. They are the piece that makes "works on any eSource" a claim about
movement as well as about widgets.

---

## Stage D — resolve: three layers before a human

Unchanged from the pass-2 design, with one structural correction noted at the
end of this document (the cache is session-owned and passed in, not module state).

### Layer 1 — synonyms, before any LLM call

A table in `resolve.ts` mapping each of the 13 canonical types to the
vocabulary the *category* uses — not this mock's labels:

```ts
const SYNONYMS: Record<FieldType, string[]> = {
  single_select: ['dropdown', 'drop down', 'picklist', 'pick list', 'combo', 'combo box',
                  'select', 'select one', 'choice list', 'single select', 'listbox'],
  multi_select:  ['check list', 'checklist', 'multi select', 'multiselect', 'multi picklist',
                  'tag select', 'select many', 'multiple choice'],
  checkbox:      ['checkbox', 'check box', 'tick box', 'single checkbox', 'flag'],
  boolean:       ['yes/no', 'yes no', 'boolean', 'true/false', 'toggle', 'switch'],
  // … the remaining nine
};
```

`score(label, canonical)`: normalize, then exact = 3, whole word = 2,
substring = 1; best synonym wins.

**The scorer is not what makes this safe — the acceptance rule is.** A type
resolves deterministically only when all three hold:

1. the winning library label's own best canonical is the one being asked for;
2. no other library label scores as high for that canonical;
3. the margin over the runner-up label is ≥ 1.

That is what stops the near-neighbour failure the brief calls the most common
way a build looks finished and is not. `checkbox` scores 3 on "Checkbox" and 0
on "Check List"; `multi_select` scores 3 on "Check List" and 0 on "Checkbox".
A platform shipping "Select" and "Multi Select" side by side ties for
`single_select`, the rule refuses, and the item falls to Layer 3.
**Abstention is the feature.**

**`discoverLibrary(snap)`** — the agent is not told an element library exists.
Look for a cluster of ≥ 5 actionable nodes at similar tree depth whose names
are not IR labels; if ≥ half the 13 canonicals resolve within it under the rule
above, that cluster is the library. Deterministic. If no cluster qualifies, one
LLM call answers it and is cached like any other fact.

### Layer 2 — facts, cached per session

| Key | Learned once |
|---|---|
| `type:<canonical>` | which library entry means this canonical type |
| `library` | which node cluster is the element library |
| `commit` | which control actually persists a form |
| `options.entry` | per-row or bulk paste, and whether bulk appends or replaces |
| `form.lifecycle` | whether a saved form needs a further activation step |
| `form.reuse` | the reuse affordance, or `absent` |

195 fields use 13 canonical types. This turns 195 mapping problems into ~13.

**Facts store descriptors, never refs.** A `backendDOMNodeId` is valid only for
the snapshot that produced it; every re-render invalidates it. A fact stores
`{ role, name }` and is re-located in the current snapshot on each use. Getting
this wrong is the single likeliest source of "it worked once" behaviour.

Entries carry `source: 'synonym' | 'llm' | 'human'`, which is the provenance
the Trace ledger shows.

### Layer 3 — one batched LLM call per form

Anything Layers 1–2 leave unresolved is collected **per form** and sent in one
call: the compact view, the unresolved list, and the facts already known. A
7-field form with 3 unresolved fields is one call, not three.

`json: true`, `temperature: 0`:

```json
{ "decisions": [ { "item": "…", "ref": 123, "label": "…", "confidence": 0.0, "why": "…" } ] }
```

Two trust-boundary checks before any decision is acted on — model output is
untrusted input, exactly like the IR file:

- **`ref` must exist in the current snapshot.** A hallucinated ref escalates; it
  never becomes a click at coordinates nobody verified.
- **`confidence < 0.7` escalates.** Named constant.

Expected for a full 195-field run: **5–25 calls**, falling toward zero as the
cache fills during the first visit.

---

## Stage E — act

### `locate()` — the piece everything routes through

```ts
export type Descriptor = { role: string; name?: string; nameContains?: string; inDialog?: boolean; nth?: number };
export function locate(snap: Snapshot, d: Descriptor): Ref | null;   // pure
```

Facts store descriptors, and **so do steps**. Between resolving an item and
finishing it, every write re-renders and invalidates refs, so a batch of
ref-carrying steps is broken by construction:

```ts
type Step = { target: Descriptor; op: 'click' | 'type' | 'check' | 'choose'; arg?: string; expect: ReadBack };
```

`apply()` is **not atomic**: per step it re-snapshots (which `settle()`s
first), re-locates, acts, and reads back. A ref lives for one write.

### The four primitives

Each scrolls into view first (`DOM.scrollIntoViewIfNeeded`), then reads fresh
geometry.

| Primitive | How |
|---|---|
| `click(ref)` | `DOM.getContentQuads` → centre of the first quad → `Input.dispatchMouseEvent` |
| `typeInto(ref, text)` | `DOM.focus`, `Input.dispatchKeyEvent` with `commands: ['selectAll']`, then `Input.insertText` — a real input event, so plain-DOM and framework listeners both see it |
| `setChecked(ref, want)` | reads the node's checked state, clicks only if it differs — idempotent by construction |
| `choose(ref, label)` | click, re-snapshot, click the matching `option`/`listitem` if one appeared (custom widgets); otherwise focus and type-ahead via `Input.dispatchKeyEvent` (native `<select>`). Read back either way |

**Geometry comes from `getContentQuads` at act time, not from the snapshot's
stored bbox.** Snapshot bboxes are document coordinates captured before any
scrolling; `Input.dispatchMouseEvent` wants viewport coordinates now.
`getContentQuads` also returns nothing for an unrendered element, which is a
free visibility check.

**No `Runtime.evaluate` anywhere.** The pass-1 property — *the agent reads, it
does not execute in the page* — survives intact.

### Read-back is per write, not per screen

After every write, re-read the control just written and compare: a textbox's
value against the text sent, a combobox's against the type chosen, a
checkbox's `checked` against the flag intended. Then `errorsIn()` — a newly
appeared `role=alert`/`status`, or the control gaining `invalid`, means the
platform rejected the write, which is a different failure from a bad mapping
and escalates with the platform's own message attached.

### Build order inside a field

Type first, then everything the type governs — platforms discard silently what
the current type cannot hold when the type changes:

```
add element → set TYPE → label → required → options → range/units → formula → skip logic
```

**Options are pairs.** Per-row entry is preferred because it appends. Bulk
paste is used only when no per-row affordance is discoverable, and the
resulting value count is always read back, because bulk entry tends to
*replace*. Codes and labels are both entered and both read back — a list
carrying only labels stores the wrong thing.

### Which button is Save

Never decided by name alone; "Save" and "Save As Template" sit next to each
other and look alike, which is the point. Candidates rank by a save vocabulary,
the top one is tried, and the `commit` fact is cached **only once read-back
confirms persistence** — the unsaved marker cleared, or the saved form re-reads
with its elements. If not, the next candidate is tried. The bounded retry loop
performs the discovery; nothing about "Save" is asserted in code.

### Dismissal

An item that escalates mid-way must not leave a modal open for the next item to
build into. `dismiss()` — Escape, `classify()` to confirm the overlay closed,
else a close control inside the dialog. Detail in
[PASS2-MECHANICS.md](PASS2-MECHANICS.md).

---

## Stage F — verify

Referenced everywhere, so specified here once. `verify()` compares what is on
screen against the IR entry, by item kind:

| Kind | Passes when |
|---|---|
| **visit** | a node names the visit, and its day window matches `window_start_day`/`window_end_day` where the platform exposes one |
| **form** | a node names the form, it sits under the right visit, its repeating flag matches, and its element count equals the IR's field count |
| **field** | label matches; type matches the resolved library entry; required flag matches; **every option pair** present, code and label; min/max/units match where the type carries them; the skip-logic controller and value are wired to the right field |

Three rules that make it worth running:

- **An element that exists but was never named is a failure.** Adding a control
  and labelling it are separate acts, and an unnamed field is structurally
  present and semantically worthless.
- **Count equality is not enough.** Option lists are compared pairwise, not by
  length, because bulk paste that dropped the codes produces the right count.
- **A reused form verifies exactly like a built one.** Field by field. This is
  the only thing that catches a platform whose "copy from" copies structure and
  drops coded values.

On a **new-session** run, `verify()` runs on every item *before* any build is
attempted — this is the top-down walk. Passing means the item is recorded as
built with `source: 'verified-existing'` and the loop moves on; failing drops
into the normal build path.

---

## Stage G — escalate

### Signatures, not items

The gate queue is keyed by **signature** — the unresolved question
(`type:single_select`), not the item. The first three single-select fields that
fail produce **one** card listing all affected items, not three, and not the
forty more that would follow across the study. This is what keeps escalation
under a fifth of the run and the queue a handful of representative decisions.

On the **third** distinct failure against one signature, `run.ts` spends one
deliberate wider call before queueing: full library enumeration,
`expandAround()` on the library cluster, and the canonical vocabulary. Resolve
the question once, expensively, rather than let it surface forty times.

### The card

One per signature, in the Build tab under the status tree:

- the question in one line — *"What does this platform call a single-select?"*
- the affected items — *23 fields across 6 forms*, first few ids listed
- what the agent tried and what came back, including any platform error text
- **the answer, chosen from the live page** — candidate nodes read out of the
  current snapshot, not a free-text box. Clicking one is the whole interaction.

Answering caches the fact under `source: 'human'`, unblocking every affected
item at once. **Resume** re-runs only those items.

The run never blocks on the gate. Nothing escalated was ever committed — the
*must not silently commit* requirement is met by the item never being built,
not by a confirmation dialog.

---

## Stage H — ledger, status, rerun

The ledger is two-phase — `begin(item)` before the first write, a terminal
record after — so an item interrupted mid-write is distinguishable from one
never attempted. That interrupted item is the **frontier**, and it is always
re-verified before anything past it is trusted.

`statusTree(ir, ledger, queue)` is **derived on every render, never stored**,
so it cannot drift from the source of truth. Visits → forms → fields, each
`complete` / `in-progress` / `escalated` / `not-reached`, rolled up. An
escalated node is clickable and jumps to its gate card, keyed off the item id
already shared by the IR, the ledger and the queue.

Full interfaces, the rerun decision table, and recurring-form reuse:
[PASS2-RERUN.md](PASS2-RERUN.md).

---

## The loop

```ts
const s = newSession(tab, ir);
let snap = await snapshot(meta);                       // settle() inside

const id = identify(snap, ir);
if (id.ok === false) return queue('identity', id);     // a *different* study: refuse outright
if (id.ok === 'unconfirmed') queue('study.anchor', id);// no anchor: one card, run continues

const live = await liveness(s, snap);
if (!live.live) snap = await home(snap);               // new session: top-down from the root

for (const item of planItems(ir)) {
  if (skipPerLedger(s, item, live)) continue;          // same-session: trust confirmed history

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const ctx = await ensureContext(s, contextOf(item));
    if ('escalate' in ctx) { queue(ctx.escalate, item); break; }

    if (await verify(s, item)) { ledger.built(item, EXISTING); break; }   // presence is not enough

    const plan = await resolveSteps(item, ctx, s.facts);
    if (plan.escalate) { queue(plan.signature, item, history); break; }

    ledger.begin(item);
    await apply(plan.steps);                           // re-snapshot + re-locate per step
    if (await verify(s, item)) { ledger.built(item, plan.provenance); break; }
    await dismiss();                                   // leave no modal for the next item
  }
  if (!ledger.get(item.id)) queue(`unverified:${item.id}`, item, history);
}

assertTerminated(s.ledger, planItems(ir));   // built + reused + escalated === total
```

`MAX_ATTEMPTS = 2`. A high-confidence decision whose read-back disagrees is not
necessarily a bad mapping — it can be a timing gap, an intermediate modal, or a
save that silently failed. So: re-read, try once more, then escalate with the
full attempt history attached, so the human starts from something rather than
zero.

---

## Corrections to the pass-2 draft

Superseded, so the draft is not implemented as written:

| Draft said | Now |
|---|---|
| `click(ref)` at the snapshot bbox centre | `getContentQuads` at act time — document vs viewport coordinates |
| `await apply(plan.steps)` as one batch | per-step re-snapshot and re-locate; steps carry descriptors |
| `resolve.ts` holds a module-level cache | the session owns it; `resolve(item, snap, facts)` |
| cache scoped per `run()` call | scoped per session, across Stop/Rerun cycles |
| ledger records completions | two-phase, so a frontier exists |
| flat loop over `planItems` | same loop, plus `ensureContext` per item |
| `stats().distinctForms` via `JSON.stringify` | `formKey` — key-order independent |
| session = service worker | session = side panel document; `sw.ts` holds no state |

**Not a conflict:** the manifest. Everything is in-memory and per-document, so
the three permissions and one host are unchanged. A new session rediscovers
~15 facts; the `ponytail:` comment names the `chrome.storage` upgrade path if a
cold run with zero LLM calls ever matters.

---

## Checks

`node --test`, no browser, no network — the property that makes `compactFrom`
and `parseIR` testable applies to everything pure added here.

| File | Asserts |
|---|---|
| `test/ir.test.ts` | `planItems` emits every visit, form and field; a skip-logic controller always precedes its dependent; ids are unique and round-trip to their IR entry; `formKey` is key-order independent; `recurring` yields 17 keys over 28 appearances |
| `test/perceive.test.ts` | the mechanics annex — `diff`, `classify`, `errorsIn`, modal scoping, `settle`'s loop |
| `test/resolve.test.ts` | the scorer picks Dropdown for `single_select` and Check List for `multi_select` from a library holding both "Check List" and "Checkbox"; abstains on a tie; a hallucinated ref and a sub-threshold confidence both escalate; N identical questions cost one resolution; a fresh facts `Map` shares nothing with a previous one |
| `test/act.test.ts` | `locate` picks the right node from two similar ones and returns null on a tie; `setChecked` no-ops on matching state; read-back rejects a value that came back different |
| `test/run.test.ts` | `identify` matches on protocol id and on title; returns `different-study` when another study is named; returns `unconfirmed` — never a hard fail — when no anchor exists anywhere |
| `test/run.test.ts` | `verify` rejects an unnamed element, a right-length option list with dropped codes, and a missing skip-logic wiring; ledger accounting over a scripted mix of successes, retries and escalations; the rerun decision table; non-contiguity; `statusTree` roll-up; `assertTerminated` across Stop/Rerun |

**Untestable without a live page, and why:** the CDP wire calls —
`getContentQuads` geometry, `Input` dispatch, `Network` event counting, and
reuse-affordance discovery. All are thin `send()` wrappers with pure logic on
both sides; the check on them is the run against mock B.

---

## Order of work

Each step ends somewhere you can stop, and the risky unknown is hit first.

| # | Step | Browser? |
|---|---|---|
| 0 | **Click spike** — one ref in, click, re-snapshot, print the diff. Settles coordinates, scrolling, whether React sees it, and how long the page takes to settle | yes, throwaway |
| 1 | **Mechanics** — `diff`, `classify`, `errorsIn`, `activeDialog`, modal scoping; then `settle` + `inflight` | half pure |
| 2 | **`ir.ts`** — `planItems`, `formKey`, `recurring` | no |
| 3 | **`act.ts`** — `locate`, the four primitives, `home`, `ensureContext`, `dismiss` | yes |
| 4 | **`run.ts` skeleton** — two-phase ledger, `verify`, the loop, `assertTerminated`, with `resolve` stubbed to always escalate | yes |
| 5 | **Mock B** — before tuning any synonym, so the vocabulary is not fitted to a sample of one | yes |
| 6 | **Layer 1** — synonyms, acceptance rule, `discoverLibrary` | mostly pure |
| 7 | **Layers 2–3** — session cache, batched LLM call, correlated-failure handling | yes |
| 8 | **Gate + status tree + Resume** | yes |
| 9 | **Reuse** — discovery after the first verified occurrence, attempt, verify, fall back | yes |

**Step 4 is shippable.** A run that escalates 100% of items is a *correct* run
under the guarantee: every item terminates, the ledger balances, the status tree
fills, `unaccounted 0` prints. That is the end-to-end demo and the screen
recording, and every step after it only moves items from the escalated column
to the built column. If the week runs out, this ships and is reported honestly.

**Step 5 before step 6** is the one ordering that matters most. Mock B is a
development instrument, not a report section — writing the synonym table with
both mocks on screen is what makes "abstains on a tie" something observed
rather than something asserted in a test you also wrote.

**Step 9 is droppable.** Without reuse every occurrence builds independently,
which is correct and merely slower.

---

## Generalization evidence — mock B

`intake-takehome-2/esource-mock` is the baseline. A second mock under `mock-b/`
(own Vite project, same IR, different shape):

- element library renamed to a plausible different vocabulary — Picklist /
  Multi Picklist / Tick Box / Y-N Switch — **including a near-neighbour pair the
  margin rule has to abstain on**;
- Save moved out of the top bar into a footer, next to a look-alike;
- screens reordered — forms reached before visits, which is what exercises
  `home()` and `ensureContext()`;
- restructured DOM — div soup with ARIA roles instead of tables and native
  `<select>`.

Reported honestly in the README: built, escalated, and what broke. **A lower
number on a mock the agent has never seen is the result that matters.**

---

## End-to-end verification protocol

1. `npm test && npm run typecheck` — the pass-1 16 checks plus the new ones.
2. Start `esource-mock`, load the extension, load `data/abc-101-study.ir.json`,
   **Start build**.
3. Watch the status tree fill. Confirm the LLM call count is single-to-low-double
   digits, not near 195.
4. Clear the gate queue, hit **Resume**, confirm the affected items build.
5. `__readState()` in the mock's DevTools console — **as the reviewer, by hand,
   never from the agent** — and diff against the IR: 4 visits, 28 forms, 195
   fields, every type, every code/label pair, every range and unit, 13 skip
   rules, the right forms repeating.
6. Re-run without resetting the mock, **same session**. Confirm no duplicates
   and that it is mostly a status read.
7. Close the panel, reopen, re-run — **new session**. Confirm `home()`, the
   full top-down `verify()` walk, fact rediscovery, and still no duplicates.
8. Repeat 2–7 against mock B, unchanged. Record what happened, including what
   broke.

---

## Questions for a clinical SME

Written down rather than guessed, per the brief.

- When a platform offers both a form-level *repeating* flag and a repeating
  section within a form, which does `repeating: true` in the IR mean?
- If a platform's range check accepts a min/max but not the unit, is a field
  built without its unit acceptable, or must it escalate?
- Two studies sharing a protocol id on one platform — does that happen, and if
  so what is the stronger identity key?
- Is a reused form definition regulatorily equivalent to an independently built
  one, or must each visit's copy be independently attested?
