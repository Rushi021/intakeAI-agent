# Architecture — Intake Study Builder Agent

A Chrome extension that reads an eSource platform through its **accessibility
tree** and a study `.ir.json`, so it can build that study by driving the UI.

**Status: pass 2 — perceive, decide, act, verify, escalate.** The design is
[PASS2.md](PASS2.md), with two annexes: [PASS2-MECHANICS.md](PASS2-MECHANICS.md)
and [PASS2-RERUN.md](PASS2-RERUN.md).

---

> **Running it is documented in the [repo root README](../README.md)** — start
> the mock, build, load unpacked, drive the panel. This file is the architecture.

## Context

The input is an IR describing a four-visit study: 28 form appearances across 17
distinct definitions, 195 fields, 13 skip-logic rules. The job is to build that
into an eSource platform's form designer — and **every eSource platform is
different**: different navigation, different DOM, different widget libraries,
different names for identical concepts. There is no API and no standard.

So the agent cannot be written against a platform. It has to perceive whatever
page it is on, decide, act, and confirm what it actually built.

**The guarantee:** every plan item ends in exactly one of two states — built and
verified, or escalated with full context. Never a third, silent state where the
agent moved on without either. `assertTerminated()` enforces that rather than
claiming it, and the panel prints `unaccounted 0` or reports a bug.

## Build

```bash
npm install
npm run build      # → dist/, loadable unpacked
npm run dev        # rebuild on save
npm test           # 70 checks, no browser
npm run typecheck
```

Chrome shows a **"started debugging this browser"** banner while the agent is
attached. Reading the browser's own computed accessibility tree over CDP
(`Accessibility.getFullAXTree`) is the only way to get it from an extension
outside ChromeOS, and that banner is the price. **Detach** removes it.

---

## Layout

```
intake-agent/
├── public/manifest.json    MV3 manifest — permissions, entry points
├── src/
│   ├── sw.ts               service worker — holds no state, deliberately
│   ├── cdp.ts              debugger session + in-flight request count
│   ├── perceive.ts         two-level perception, diff/classify/errors, settle
│   ├── ir.ts               study IR + the plan
│   ├── act.ts              locate, the four write primitives, navigation
│   ├── resolve.ts          layers 1–3: synonyms, facts, the model
│   ├── run.ts              the loop, the ledger, verify, the gate, status
│   ├── llm.ts              provider access — Mistral wired
│   ├── sidepanel.html/.ts  the panel — Build tab + Trace tab
│   └── panel.css           theme-aware, no CSS framework
├── test/
│   ├── helpers.ts          hand-built AX trees
│   ├── perceive.test.ts    generalization, pruning, comparison, settling
│   ├── ir.test.ts          parser, plan, ordering, form keys
│   ├── act.test.ts         locate's matching and its abstention
│   ├── resolve.test.ts     the acceptance rule and the trust boundary
│   └── run.test.ts         the guarantee, identity, verify, status
└── dist/                   built, loadable unpacked
```

| File | Responsible for | Deliberately not responsible for |
|---|---|---|
| `public/manifest.json` | Declaring the three permissions the agent needs and where Chrome finds the panel. | — |
| `src/sw.ts` | One line: opening the side panel on icon click. | The agent loop — a service worker is killed on idle and would die mid-run. |
| `src/cdp.ts` | Attach/detach lifecycle, `send()` for CDP commands, and raising *stale* when the page moves. | Knowing anything about accessibility, eSource, or the IR. |
| `src/perceive.ts` | Turning a raw AX tree into the compact view, retaining the full detail, and serving the three expand tools. `compactFrom` is pure. | Deciding what to do — it reports what is on screen, nothing more. |
| `src/ir.ts` | Parsing and validating the input file, the counts, and the `skeleton` the model plans against. | The 195 fields at planning time — those are fetched per form at build time. |
| `src/llm.ts` | One `chat()` for the whole agent: provider specs, the `.env`-derived config, timeouts, readable errors. | Prompts and tasks — it carries messages, it does not compose them. Also key *storage*: there is none. |
| `src/act.ts` | `locate()`, the four CDP write primitives, `home`/`ensureContext`, `dismiss`, and per-write read-back. | eSource, the IR, or what is worth building — it is handed a description and an operation. |
| `src/resolve.ts` | The synonym table, the comparative scorer and its acceptance rule, library discovery, the designer vocabulary, and the batched model call. | Acting. It returns a decision; `run.ts` executes it. |
| `src/run.ts` | The loop, the session, the two-phase ledger, `verify()`, the gate queue, and the derived status tree. | CDP. It composes the modules below it. |
| `src/sidepanel.ts` | The two tabs. **Build**: load the IR, one Start button. **Trace**: the IR tree, the perception numbers, and the pruned and full views. Holds the run's state. | Business logic; it delegates to the three modules above. |

**Dependency direction is one-way** — `sidepanel → run → { resolve, act,
perceive, ir, llm }`, with `act → cdp`, `perceive → cdp` and `resolve → llm`. Nothing lower reaches back up, which is why `compactFrom`,
`parseIR` and every expand tool are testable in plain Node with no browser.

---

## The panel

Two tabs, because they serve two different people.

**Build** is the operator's view: load the input file, **Start build**, and then
three things that all read from the run ledger on every render and are stored
nowhere else — so none of them can drift from what was actually built.

| | |
|---|---|
| **Tally** | `built · escalated · not reached · unaccounted`. Unaccounted is `assertTerminated()`'s output. Non-zero means the agent has a bug, and it says so instead of showing a green result. |
| **Needs a decision** | One card per unresolved *question*, not per item. |
| **Progress** | Visits → forms → fields, rolled up. An escalated row is a button that scrolls to its card, keyed off the item id already shared by the IR, the ledger and the queue. |

There is no attach button and no snapshot button. The agent finds the active
tab, attaches, reads, decides and reports on its own; a study builder should not
have to understand the agent's internals to run it.

**Trace** is the engineering view, and it exists because the assignment asks for
traceability: for every element the agent creates you must be able to say which
entry in the input file it came from and why. It holds the parsed IR tree, the
perception numbers (including whether the page had *settled* when it was read),
the run ledger, the pruned view exactly as the model receives it, and the
level-2 tools for pulling anything pruning left out. Detach and the screenshot
toggle live here — controls an operator has no reason to touch.

Expandable sections are native `<details>`; 28 forms and 195 fields render with
no toggle state to manage. Every label from the input file is rendered with
`textContent`, never `innerHTML` — the IR is untrusted, and a field label
rendered into a tree is exactly where injected markup would ride in.

---

## How perception works

### Why the accessibility tree

Every eSource platform has different DOM, different widget libraries and
different names for the same concept. Roles and accessible names are the layer
where they agree. **No CSS selector, element id or button label is hardcoded**,
and the model never emits a selector — it returns a `ref`, which is a CDP
`backendDOMNodeId` that resolves to a live element. The failure mode of
"LLM writes a selector" is closed structurally, not by discipline.

### Level 1 — the compact view

The only thing sent to the model. Keeps:

- **actionable controls** — buttons, links, textboxes, checkboxes, radios,
  comboboxes, listboxes, menus, tabs, list items, table cells
- **context that explains them** — headings, dialog titles, alerts and errors,
  labels, legends, landmarks, and loose visible text that is not already some
  control's accessible name

Each kept node carries `ref`, `role`, `name`, `value`, key `state`
(disabled / checked / expanded / selected / required / invalid / modal …),
bounding box, tree depth, and its enclosing dialog. Layout wrappers are dropped.

### Level 2 — full detail, on demand

Retained locally, never sent by default: the complete AX tree, the box model
for every node, an optional screenshot, and the ref→node map.

| The model asks | Call |
|---|---|
| "Show the subtree around candidate 17" | `expandAround(snap, 17)` |
| "Show all controls in the open dialog" | `dialogControls(snap)` |
| "Show nodes near these coordinates" | `nodesNear(snap, x, y)` |

So pruning cuts tokens without losing anything: a node left out of the compact
view is still retrievable by ref.

### Staleness

`Page.frameNavigated`, `DOM.documentUpdated` and `Page.loadEventFired` mark the
snapshot stale in the panel. **These do not catch an in-place React re-render**,
so the rule is to re-snapshot before every decision — after navigating, saving,
opening a modal, or any action that changed the page.

---

## How deciding works

Three layers, cheapest first, so most questions never reach the model and far
fewer reach a human.

### Layer 1 — synonyms, and an acceptance rule that abstains

`resolve.ts` holds the vocabulary the *category* uses for each of the 13
canonical types — the pool designers pick from, not any mock's labels.
`score()` ranks exact match 3, whole word 2, substring 1.

**The scorer is not what makes this safe. The acceptance rule is.** A type
resolves deterministically only when all three hold:

1. the winning label's own best canonical is the one being asked for;
2. no other label ties it;
3. the margin over the runner-up is ≥ 1.

`Dropdown` beside `Picklist` ties for `single_select` — both read exactly as one
— so the rule refuses and the item falls through. `Select` beside `Multi Select`
does *not* tie: the first is a whole-name hit, the second only a word hit, so
both resolve correctly. Abstaining there would send a resolvable question to a
human, which is its own failure. **Abstention is the feature**, and refusing
too often is as much a bug as refusing too rarely.

The agent is not told an element library exists. `discoverLibrary()` looks for a
cluster of same-depth actionable nodes whose names are *not* IR labels, and
keeps the cluster in which most of the canonical vocabulary resolves.
Deterministic, no model call — and a page of study content cannot masquerade as
a library, because its names are the ones the input file already used.

### Layer 2 — facts, cached per session

195 fields ask about 13 types. The cache turns 195 mapping problems into ~13.

| Key | Learned once |
|---|---|
| `type:<canonical>` | which library entry means this canonical type |
| `library` | which node cluster is the element library |
| `commit` | which control actually persists |
| `study.anchor` | whether this platform names the study at all |

**Facts store descriptors, never refs.** A `backendDOMNodeId` is valid only for
the snapshot that produced it; every re-render invalidates it. A fact stores
`{ role, name }` and is re-located on each use. Getting this wrong is the single
likeliest source of "it worked once" behaviour.

The cache is owned by the session and passed in — not module state, which would
outlive a session and could only be cleared through a reset someone remembers
once and forgets twice. In memory only, so the manifest keeps its three
permissions.

### Layer 3 — the model, once per question

Asked once per unresolved *type*, not once per field, because the answer caches
as a platform fact: the forty single-selects in the study share one question.
That bounds a full run at 13 type calls plus a handful of control questions.

Model output is untrusted input, exactly like the IR file. Two checks before
anything becomes a click: **the ref must exist in the snapshot the question was
asked about** — a hallucinated ref escalates rather than becoming a click at
coordinates nobody verified — and **confidence below 0.7 escalates**.

---

## How acting works

### `locate()` — the inverse of a ref

Facts store descriptors, and so do steps. `apply()` is **never a batch**: it
re-reads the page and re-locates before every single write, because the previous
write's re-render has already invalidated the next step's ref.

`locate()` abstains the same way the type scorer does. Two controls matching
equally well and no `nth` given returns `null`. A wrong ref is a click on the
wrong control, which builds the wrong thing silently; "not found" escalates to a
human, which is cheap.

### The four primitives

Each scrolls into view, then reads geometry **at act time** — `getContentQuads`
in viewport coordinates, not the snapshot's stored bbox, which is document
coordinates captured before any scrolling. `getContentQuads` also returns
nothing for an unrendered element, which is a free visibility check.

| Primitive | How |
|---|---|
| `click` | `Input.dispatchMouseEvent`, preceded by a `mouseMoved` for hover-gated menus |
| `typeInto` | focus, `selectAll` as an editing command, `Input.insertText` — a real input event, so plain-DOM and framework listeners both see it |
| `setChecked` | reads the state, clicks only on a mismatch — idempotent by construction |
| `choose` | click, re-read, click the option that appeared; else focus and type-ahead |

**No `Runtime.evaluate` anywhere.** The pass-1 property holds: the agent reads
the page, it does not execute in it.

### Navigation

`home()` returns to the platform root on a new session — an in-page route scored
from a landmark vocabulary, falling back to the tab's origin. Never called
mid-item, because a route change can discard an uncommitted working copy.

`ensureContext()` descends into the visit and form an item needs and **confirms
arrival**: a heading, or a tab the platform marks current. Deliberately not "any
node mentioning it" — a list of four visits names all four, so a loose check
would report arrival while still on the list.

### Build order inside a field

Type first, then everything the type governs. Platforms silently discard what
the current type cannot hold when the type changes, so a range set before the
type is a range that quietly vanishes:

```
add element → TYPE → label → required → options → range/units → formula → skip logic
```

Coded values are entered per row, which appends; bulk paste tends to *replace*.
Both the code and the label go in, and both are read back.

### Which button is Save

Never decided by name alone — "Save" and "Save As Template" sit next to each
other and look alike, which is the point. Candidates rank by a save vocabulary
with decoys last, and the `commit` fact is cached **only once read-back confirms
the page actually moved**. The bounded retry loop performs the discovery;
nothing about "Save" is asserted in code.

---

## How verifying works

Read-back is **per write, not per screen**: after each write the control is
re-read and compared with what was sent. Then `errorsIn()` asks a different
question — did the platform *say no*? A new `role=alert`, or a control that
gained `invalid`, is a rejection, which is a different failure from a value that
did not stick and escalates with the platform's own message attached.

`verify()` then compares the item against its IR entry:

| Kind | Passes when |
|---|---|
| visit | named, and its day window is shown |
| form | named, under the right visit, and its repeating flag is visible when the IR says repeating |
| field | label, type, required flag, **every option pair**, min/max/units, and the skip-logic controller and value |

Three rules make it worth running:

- **An element that exists but was never named is a failure.** Adding a control
  and labelling it are separate acts.
- **Option lists compare pairwise, never by count.** A bulk paste that dropped
  the codes still has the right length. Matching is whole-token for the same
  reason — `M` sits inside `Male`, and 30 inside 300.
- **The same `verify()` runs before a build as after it.** That is what makes
  "already exists" mean something.

---

## How escalating works

The gate queue is keyed by **signature** — the unresolved question
(`type:single_select`) — not by the item. The first three single-selects that
fail produce one card listing all affected items, not three, and not the forty
more that would follow. This is what keeps the human's queue a handful of
representative decisions rather than a long list of near-duplicates.

A card carries the question in one line, the affected items, what the agent
tried and what came back, and **candidates read out of the live page**. Clicking
one is the whole interaction; there is no free-text box, because a typed answer
could name a control that is not there. The answer caches under
`source: 'human'` and unblocks every affected item at once.

**The run never blocks**, and nothing escalated was ever committed — the *must
not silently commit* requirement is met by the item never being built, not by a
confirmation dialog.

`MAX_ATTEMPTS = 2`: a read-back that disagrees can be a timing gap, an
intermediate modal, or a save that silently failed, so the tree is re-read and
one more attempt is spent before escalating with the full history attached.

---

## How re-running works

**Presence never justifies skipping. A ledger entry from a live session does.**

The ledger is two-phase — `begin()` before the first write, a terminal record
after — so an item interrupted mid-write is distinguishable from one never
attempted. That interrupted item is the **frontier**, and it is always
re-verified before anything else is trusted. The frontier is identified by its
*state*, never by its position: escalation leaves holes, so a built record at
index 40 is exactly as trustworthy as one at index 2.

| Session | Behaviour |
|---|---|
| Live (same panel) | Skip confirmed history, re-verify the frontier, reuse learned facts, re-surface unanswered cards |
| New (panel reopened) | `home()`, then the same `verify()` on **every** item before building, and every fact rediscovered |

`assertTerminated()` is the guarantee, enforced rather than claimed:
`built + reused + escalated === total`, surfaced as `unaccounted 0`.

**Known limitation:** drift in already-built items is not detected within a
session. If a human edits an already-verified field between a Stop and a Rerun,
nothing catches it — the ledger has no way to know the page diverged. The
alternative is re-verifying 195 items on every rerun, which is the full walk and
defeats the fast path. The remedy is documented for the operator: close and
reopen the panel.

---

## The model

**Mistral AI**, with the reviewer supplying their own key. Gemini and a local
Ollama are further entries in `PROVIDERS`; everything above `chat()` is
provider-agnostic, so adding one is a spec object, not a refactor.

Configured entirely through `.env` — see the
[root README](../README.md#2--provide-a-mistral-api-key). **Trace → Model**
shows what the build picked up and offers **Test connection**, a two-token round
trip that proves the key works before a long run spends anything.

`temperature: 0` by default. The same screen should produce the same decision
twice; a study build is not a place for creativity.

### Where the key lives

**`.env`, and nowhere else.** `VITE_MISTRAL_API_KEY` is read by Vite at build
time and inlined into `dist/`; `VITE_MISTRAL_MODEL` optionally overrides the
model. There is no key field in the UI, no browser storage, and no runtime
config — the built extension is self-contained, and a reviewer's whole setup is
`cp .env.example .env`, paste, `npm run build`.

Because nothing is persisted, the extension no longer requests the `storage`
permission at all.

**No key is hardcoded, and a test enforces it.** `llm.test.ts` scans every file
in `src/` for key-shaped literals, asserts `CONFIG.apiKey` is empty outside a
`.env`-backed build — which also proves `.env` is the only possible source —
and asserts `.gitignore` covers `.env` and `dist/` while `.env.example` ships
blank.

The key goes out in an `Authorization` header to Mistral's endpoint and nowhere
else. It is never rendered, never logged, and never included in an error
message; the panel reports only *whether* a key was found.
`host_permissions` is one entry, `https://api.mistral.ai/*`.

**The cost, stated plainly:** a build-time key is plaintext inside the
distributed artefact. `.gitignore` keeps it out of the repo, but not away from
whoever receives `dist/`. Use a revocable key. For production the answer is a
backend proxy holding the credential so it never reaches the client at all.

---

## Security

This is a clinical system, so the privileges and the data paths are deliberate.

- **Three permissions and one host.** `debugger`, `sidePanel`, `tabs`, plus
  `https://api.mistral.ai/*` for the model. `storage` was dropped once `.env`
  became the only config source. `chrome.debugger` needs no host
  permission, so `<all_urls>` is not requested — the extension has no standing
  access to any site it is not attached to.
- **Attach is explicit and reversible.** Only on **Start build**, only to the
  tab the user is looking at, one tab at a time. **Detach** is a button in the
  Trace tab, and the session is torn down on `pagehide` so no tab is ever left
  under a debugger. A failed `attach` rolls itself back rather than leaving a
  half-enabled session.
- **No script is injected into the platform.** URL and title come from the tabs
  API, not `Runtime.evaluate`. The agent reads; it does not execute in the page.
- **Screenshots are opt-in and off by default.** An eSource screen can carry
  patient data and a screenshot captures it wholesale. Level 2 works without it.
- **Only the compact view leaves the machine.** The full AX tree, box model and
  screenshot stay in the panel's memory and are dropped on detach.
- **The uploaded IR is rendered with `textContent`, never `innerHTML`.** The
  input file is untrusted, and a field label rendered into the Trace tree is
  exactly where injected markup would ride in.
- **The IR file is validated before use** — structure, required keys, and every
  field type checked against the canonical vocabulary. Malformed input fails
  loudly with the offending label, rather than being half-accepted.
- **The API key comes only from `.env`, is sent only to Mistral, and is never
  rendered or logged** — see [The model](#the-model).
- **`__readState()` and the other debug hooks are never called.** They are not
  part of the platform, they will not exist on the systems that matter, and an
  agent reading them is answering a different question than the one asked.
- **The model's output is a trust boundary too.** A returned `ref` must exist in
  the snapshot the question was asked about, and confidence below a named
  threshold escalates. A hallucinated ref never becomes a click at coordinates
  nobody verified.
- **Writes go through the browser's own input pipeline, not injected script.**
  `Input.dispatchMouseEvent` and `Input.insertText` produce real events; there is
  still no `Runtime.evaluate` anywhere in `src/`, so the read-only property from
  pass 1 survives the pass that writes.
- **Nothing escalated is ever committed.** An item the agent could not resolve is
  not built and later corrected — it is not built at all.

---

## Checks

`npm test` — **70 assertions, no browser, no network.** Everything pure is
covered; the four CDP calls that touch a real page are not, and are named below.

**The one that matters** is still the generalization check: two hand-built AX
trees describe the *same* Visit Schedule screen with different DOM — one
table-based, one div soup with a list and deeper nesting — and must produce the
same actionable surface. If it fails, the agent is reading a platform rather
than a page.

| File | Covers |
|---|---|
| `perceive.test.ts` | The generalization check; pruning keeps study identity; a pruned node stays reachable by ref; dialog scoping; a modal beats a stale non-modal; iframe roots survive. Then the comparison layer: an identical view diffs empty, a value change is a *change* rather than an add plus a remove, `classify` separates navigation from an overlay from an in-page re-render, `errorsIn` finds a new `role=alert` and a control that gained `invalid`, the model cannot see past an open modal, and `settle` waits for both signals and reports a timeout as a fact rather than throwing. |
| `ir.test.ts` | The real study parses to the counts `data/README.md` documents; the plan covers every visit, form and field with unique ids; an item id round-trips to its IR entry; a skip-logic controller always precedes its dependent; a cycle emits everything rather than deadlocking; `formKey` is key-order independent but sensitive to a changed code; `recurring` finds 17 definitions behind 28 appearances with Vital Signs at all four visits. |
| `act.test.ts` | `locate` matches regardless of case and punctuation, **abstains when two controls match equally well**, honours `nth` (with `-1` as "the row just added"), scopes to the blocking overlay, and `screenNames` requires a heading or a current marker — being *listed* is not being *inside*. |
| `resolve.test.ts` | The near-neighbour pair resolves correctly in two unrelated vocabularies; a genuine tie abstains; a label reading as another type is refused; scoring ranks exact over word over substring; the element library is discovered rather than told, and study content is not mistaken for one; a hallucinated ref never becomes a click; sub-threshold confidence escalates; non-JSON is a rejection rather than a crash; a control that looks like Save and is not ranks below the real one. |
| `run.test.ts` | The guarantee — `built + escalated == total`, nothing unaccounted, over a scripted mix; an interrupted item is distinguishable from an untouched one; **a built record is trusted by its state, never its position**; identity matches, hard-stops on a different study, and returns *unconfirmed* rather than failing when no anchor exists; a platform with no anchor never disables the fast path; `verify` rejects an unnamed element, an option list with the right count and no codes, a range that vanished, and a repeating form nothing calls repeating; status rolls up and recomputes with no stored state; N fields failing one question produce one card. |
| `llm.test.ts` | The key trust boundary: no key-shaped literal anywhere in `src/`, the shipped default carries none, `.env` and `dist/` gitignored and `.env.example` blank, the key rides in a header and never in the URL or body, requests are deterministic, a missing key fails before any network call, and a 401 produces a readable message that does not contain the key. |

**Deliberately untested, and why:** `DOM.getContentQuads`,
`Input.dispatchMouseEvent` / `insertText` / `dispatchKeyEvent`,
`DOM.scrollIntoViewIfNeeded`, and the `Network` event counting. They are thin
`send()` wrappers around real layout and a real input pipeline; no unit test can
exercise them, and the check on them is a run against a second mock.

---

## Not built yet

- **Recurring-form reuse.** `formKey` and `recurring` find the 17 definitions
  behind the 28 appearances, but every occurrence is built independently.
  Correct, merely slower — the one step in the plan marked droppable.
- **The second mock.** Until it exists, generalization is an argument from
  construction, not a measurement.
- **A live end-to-end run.** The pure logic is covered; the CDP write calls are
  not, and cannot be without a browser.

## Assumptions

- **A re-run is a diff against what is on screen, not a replay of the IR.** The
  provided mock wipes on reload; real platforms do not.
- **Presence is never sufficient.** An item that appears to exist still runs the
  same `verify()` used at build time. What licenses a skip is a ledger entry
  from a live session, never a name on the page.
- **Study identity: absent is not the same as wrong.** A page naming a
  *different* study is a hard stop. A page naming *no* study is unconfirmed —
  one gate card, the operator confirms once, and the run proceeds. Treating
  those the same would refuse to run on every platform that does not badge the
  study name, which is a structural failure wearing a safety check's clothes.
- **A session is this panel document's lifetime.** `sw.ts` holds no state and
  deliberately never will, so MV3 worker eviction cannot silently destroy a
  ledger. Closing the panel is also the operator's way to force a full
  re-verification from the platform root.
- **`verify` reads the accessible neighbourhood of a named element.** Platforms
  differ wildly in structure but keep a field's label, type and settings
  adjacent in the tree. Matching is whole-token, never substring — a coded value
  of `M` sits inside `Male`, and 30 sits inside 300.
- **Cross-origin iframes are out of scope.** Same-origin frames work: every
  parentless AX root is walked, and viewport-coordinate clicking and
  `backendNodeId` targeting are frame-agnostic. OOPIFs would need CDP target and
  session management.

## Questions for a clinical SME

Written down rather than guessed past, per the brief.

- When a platform offers both a form-level *repeating* flag and a repeating
  section within a form, which does `repeating: true` mean?
- If a platform accepts a min/max but not the unit, is a field built without its
  unit acceptable, or must it escalate?
- Can two studies share a protocol id on one platform? If so, what is the
  stronger identity key?
- Is a reused form definition regulatorily equivalent to an independently built
  one, or must each visit's copy be independently attested?
