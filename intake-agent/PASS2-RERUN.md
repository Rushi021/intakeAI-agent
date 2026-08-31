# Pass 2, step 3 — rerun and resume semantics

What a second **Start build** means. Sits on top of the pass-2 loop
(`resolve.ts` / `act.ts` / `run.ts`), extends `ir.ts` and `run.ts`, and adds no
new module.

**Status: planned, not built.** Reads against
[PASS2-MECHANICS.md](PASS2-MECHANICS.md) (step 0) and the act/resolve/run design.

---

## Flags — read before implementing

The brief asked for structural inconsistencies to be surfaced rather than
quietly resolved. Six, in descending order of how much they change the design.

### 1 · The service worker holds no state, and cannot

The brief defines a session as *"the background/service-worker process holding
the in-memory Layer 2 cache and ledger."* That process does not exist here.
`src/sw.ts` is four lines that open the side panel, and
[intake-agent/README.md](README.md) states the reason explicitly: *"the agent
loop — a service worker is killed on idle and would die mid-run."* All run state
(`ir`, `snap`, `tab`) lives in the **side panel document**.

**Resolution:** a session is the **side panel document's lifetime**. This is
strictly better than the premise. A panel is not evicted on idle the way an MV3
worker is — it dies when the operator closes it, which is an event we already
hook (`detachOnUnload()` in `src/cdp.ts:52`).

**Consequence:** MV3 worker eviction is a non-problem, and the "silently
destroyed state" case in decision 3 collapses to "the panel was closed," which
is observable. The liveness check is still built — a panel can be reloaded, and
the tab can move under it — but it is checking page identity, not process
survival.

### 2 · Decisions 1 and 5 contradict each other as written

Decision 1: *"On any pass over `planItems(ir)` … the agent must never treat
existence-by-name as success."*
Decision 5: *"same-session rerun … complete → skip re-verification entirely."*

Both cannot hold. The reconciliation intended by decision 4 is real, but the
phrasing of decision 1 is too absolute. Implemented as one rule:

> **Presence never justifies skipping. A ledger entry from a live session does.**
>
> *Presence* is what the page shows — a node whose name matches a field label.
> That is evidence of nothing; it can be a partially built field, a
> similarly-named field, or a leftover from a failed run.
> *A ledger entry* is the agent's own record that it built this item and
> `verify()` passed. That is trustworthy exactly as long as the session that
> wrote it is still live and still looking at the same page.

Decision 1 therefore governs every pass where the ledger is not authoritative —
which is every new session, and every item past the frontier.

### 3 · The ledger as sketched cannot represent a frontier

The pass-2 design records `ledger.built(item, provenance)` — completions only.
Decision 4 requires knowing which item was *in flight* when a stop landed, and a
completions-only ledger has no way to express that: an item that was half-built
looks identical to one never attempted.

**Resolution:** the ledger becomes two-phase. `begin(item)` before the first
write, a terminal call after. The frontier is the item with a `begin` and no
terminal record. Detailed below.

### 4 · Reuse discovery cannot run before the first occurrence exists

Decision 2 says to run reuse discovery *"before building the first occurrence of
a recurring form."* On most designers a "copy from" / "save as template"
affordance is contextual — it appears once there is something to copy. Running
discovery against an empty study will find nothing on exactly the platforms that
support reuse, and the fact will be cached as absent.

**Resolution:** discovery runs **after the first occurrence is built and
verified, before the second occurrence is attempted.** Same deterministic
mechanism, same one-time cost, same `discoverLibrary` pattern — only the moment
moves. Decision 2's other clause is preserved unchanged: *"build the first
occurrence normally regardless."*

### 5 · An answered escalation must re-run, not re-surface

Decision 5 says *"escalated → skip re-resolution, just re-surface in the gate
queue."* Applied literally, an item whose gate card the operator has already
answered goes straight back into the queue on Resume, and can never be built.

**Resolution:** branch on the signature, not the item.

| State | Rerun behaviour |
|---|---|
| escalated, signature still unanswered | re-surface in the queue, no work |
| escalated, signature now has a fact (`source: 'human'`) | full `resolve → act → verify`, using that fact |

### 6 · A module-level cache in `resolve.ts` cannot be session-scoped

The pass-2 design has *"`resolve.ts` holds a `Map<string, Fact>` for the run."*
Module-level mutable state lives as long as the document does, so it would leak
across a panel reload and could not be cleared on a session boundary without an
exported reset — the kind of thing that is remembered once and forgotten twice.

**Resolution:** the cache is owned by the session and passed in.
`resolve(item, snap, facts)`. `resolve.ts` keeps no module state, stays pure at
the top, and is testable by handing it a fresh `Map`.

### Not a conflict — the manifest

Everything here is in-memory and per-document. **No `storage` permission is
needed**, and the manifest keeps its three permissions and one host. The cost is
stated plainly: a new session rediscovers roughly fifteen platform facts. That
is a handful of LLM calls, and the alternative is a persistence layer with an
invalidation story nobody asked for.

```ts
// ponytail: session-scoped Map. chrome.storage + a platform-identity key and an
// invalidation story only if starting a cold run with zero LLM calls ever matters.
```

---

## Session

```ts
// run.ts
export type Session = {
  id: string;              // crypto.randomUUID(), minted when the panel loads
  tabId: number;
  url: string;             // the page the ledger's contents describe
  study: string;           // ir.study.protocol_id, confirmed on the page
  facts: Map<string, Fact>;   // Layer 2, session-scoped
  ledger: Ledger;
  queue: Map<string, GateItem>;  // keyed by signature
};

export function newSession(tab: chrome.tabs.Tab, ir: IR): Session;
export function endSession(s: Session): void;   // called from the existing pagehide hook
```

One session per panel document. `sidepanel.ts` mints it on load and drops it on
`pagehide`, alongside the `detach()` that already happens there.

### Liveness

```ts
export type Liveness =
  | { live: true }
  | { live: false; reason: 'no-ledger' | 'tab-changed' | 'page-changed' | 'frontier-lost' };

export async function liveness(s: Session, snap: Snapshot): Promise<Liveness>;
```

Four deterministic checks, cheapest first:

| Check | Fails when | Skippable |
|---|---|---|
| ledger has at least one terminal record | first run, or a panel reload wiped state | no |
| `s.tabId` matches the active tab and the debugger is still attached | operator moved to another tab | no |
| study identity on the current page still matches `s.study` | the platform is showing a **different** study | **yes** — see below |
| the frontier item's containing context is locatable in `snap` | the page moved somewhere the ledger can't describe | no |

**The identity check is inconclusive, not failing, when the platform has no
study anchor.** `identify()` returns `unconfirmed` on a platform that never
names the study in its accessible tree. Treating that as a liveness failure
would make the same-session fast path silently unreachable on every such
platform — the optimization disabling itself for a structural reason while
reporting it as a session boundary. So: when the session fact
`study.anchor: 'absent'` is set (the operator confirmed it once at run start,
per [PASS2.md](PASS2.md#study-identity-on-every-run)), this check is **skipped**
and liveness rests on the other three, which are the ones that actually detect a
session boundary. A positively *different* study still fails, always.

Any failure **downgrades to the full top-down walk of decision 1**. It never
throws and never reports an error to the operator — a downgrade is a correct
outcome, and the status line says which one happened.

Note that ref invalidation is *not* one of the checks. Facts and steps store
descriptors and re-locate on every use, so a re-render invalidating
`backendDOMNodeId` is already structurally handled and is not a session concern.

---

## Ledger

Two-phase, so a frontier exists.

```ts
export type Record = {
  item: string;                 // the plan-item id — IR entry, idempotency key, ledger key
  began: number;                // ms; written before the first act
  state: 'in-flight' | 'built' | 'escalated' | 'reused';
  attempts: number;
  provenance?: { decision: string; source: 'synonym' | 'llm' | 'human'; confidence?: number };
  readback?: string;            // what verify() saw
  settled?: Settled;            // from PASS2-MECHANICS — a write made on an unquiet page
  signature?: string;           // when escalated
};

export type Ledger = {
  begin(item: PlanItem): void;
  built(item: PlanItem, p: Record['provenance'], readback: string): void;
  reused(item: PlanItem, from: string): void;
  escalated(item: PlanItem, signature: string): void;
  get(id: string): Record | undefined;
  frontier(): Record | undefined;      // the one 'in-flight' record, if any
  counts(): { built: number; escalated: number; inFlight: number };
};
```

`frontier()` returns the single record left `in-flight` — an item whose writes
started and whose `verify()` never completed, because a stop landed between
them. There is at most one, because the loop is sequential.

**The frontier is identified by its state, never by its position.** An item is
the frontier because its record says `in-flight`, not because of where it sits
in `planItems` order. Nothing in the loop compares indices, and nothing infers
an item's state from a neighbour's — which is what makes the non-contiguous
case below work rather than being a special case to handle. An implementer who
reaches for "items before the frontier" has introduced a bug: escalation leaves
holes, so a `built` record at index 40 is exactly as trustworthy as one at
index 2, and an untouched item at index 2 is exactly as untrusted as one at
index 40.

`settled` is carried per record deliberately: a write made against a page that
never went quiet is a different failure from a bad type mapping, and conflating
the two sends the wrong thing to the gate.

---

## Rerun decision table

Evaluated per plan item, in loop order. This is the whole of decisions 1, 4 and 5.

| Session | Ledger state | Behaviour |
|---|---|---|
| not live | anything | **full path** — `resolve → act → verify`, presence never skips (decision 1) |
| live | `built` / `reused` | **skip** — trust the ledger, wherever the item sits |
| live | `in-flight` — this *is* the frontier | **re-verify first.** Passes → mark `built`, move on. Fails → full path |
| live | `escalated`, signature unanswered | **re-surface** in the queue, no work |
| live | `escalated`, signature now answered | **full path**, using the cached `source: 'human'` fact |
| live | no record (not reached) | **full path** |

Two properties fall out, and both are asserted in tests:

- **Completion is non-contiguous.** Escalation leaves holes. The loop evaluates
  every item independently and never infers an item's state from its neighbour's.
- **`assertTerminated` still holds after a rerun.** `built + reused + escalated
  === total`, `unaccounted 0`, across however many Stop/Rerun cycles a session
  saw.

---

## Recurring forms

### A stable form key — required change to `ir.ts`

`stats()` currently counts distinct forms with `JSON.stringify(f)`
(`src/ir.ts:57`), which is key-order sensitive. That is harmless for a count and
not harmless for a reuse decision, which now depends on two forms being provably
identical.

```ts
// ir.ts
export function formKey(f: Form): string;   // name + ordered (label,type,required,options,min,max,units) tuples
export function recurring(ir: IR): Map<string, PlanItem[]>;   // formKey → its occurrences, in plan order
```

Deterministic, pure, testable. `stats().distinctForms` moves onto it too, and
the existing assertion of 17 distinct definitions across 28 appearances becomes
the test that it is right.

### The reuse fact

Two pieces of state, because they answer different questions:

| Key | Scope | Meaning |
|---|---|---|
| `form.reuse` | platform | the discovered affordance — `{ shape, descriptor }` — or `absent` |
| `form.reuse.src:<formKey>` | per form | the item id of the **first verified** occurrence — the copy source |
| `form.reuse.fail:<formKey>` | per form | consecutive reuse failures for this definition |

### Which occurrence is copied

The affordance decides, so the fact records its **shape** as well as its
descriptor:

| `shape` | Vocabulary that discovers it | What the copy source is |
|---|---|---|
| `template` | *save as template, save as, publish as template* | occurrence 1 is saved as a template **once**, after it verifies; later occurrences instantiate that template and never reference an occurrence |
| `copy-from` | *copy from, duplicate, clone, add existing, import* | a prior occurrence, chosen by the picker the affordance opens |

For `copy-from` the source is always **the first occurrence that passed
`verify()` in full** — recorded as `form.reuse.src:<formKey>` — never the most
recently built one. Two reasons: the first verified occurrence is the only one
known to be complete, and fixing the source makes a re-run behave identically
to the original run rather than depending on how far the previous one got.

If the picker does not offer that occurrence (some designers only permit
copying from a designated template), the reuse attempt fails, the fail counter
increments, and the occurrence builds from scratch — the existing fallback, no
special case.

`form.reuse` is discovered **once**, after the first occurrence of the first
recurring form is built and verified (flag 4). Same deterministic pattern as
`discoverLibrary`: scan the compact view for controls whose accessible names
score against a reuse vocabulary — *save as template, copy from, duplicate,
clone, reuse, add existing, import*. No LLM. If nothing scores, the fact is set
to `absent` and every occurrence builds independently, forever.

### Reuse attempt, per occurrence

```
occurrence 2..n of a recurring form:
  form.reuse absent            → build from scratch
  form.reuse.fail:<key> >= 2   → build from scratch, no further reuse attempts for this form
  reuse disabled globally      → build from scratch
  otherwise                    → attempt reuse → verify() → built as 'reused'
                                 verify fails → increment fail counter, build from scratch
```

Reuse is **never trusted on its own**. A reused form runs the same `verify()` as
a built one, field by field against the IR — which is the only thing that
catches a platform whose "copy from" copies the structure and drops the coded
values.

**Global disable:** if the reuse affordance fails on **two distinct form
definitions**, the affordance was misidentified rather than the form being
awkward. Set `form.reuse` to `absent` and stop attempting it — the same
correlated-failure reasoning Layer 3 already applies to repeated unresolved
signatures, applied to a control instead of a mapping.

---

## Status view

```ts
// run.ts — pure
export type Status = 'complete' | 'in-progress' | 'escalated' | 'not-reached';
export type StatusNode = { id: string; label: string; status: Status; children: StatusNode[] };
export function statusTree(ir: IR, ledger: Ledger, queue: Map<string, GateItem>): StatusNode[];
```

Derived on every render from the ledger and the queue. **No status is ever
stored**, so it cannot drift from the source of truth — the same reason the
ledger, not a counter, backs `assertTerminated`.

Roll-up: a form is `complete` when every field under it is; `escalated` if any
descendant is; `in-progress` if it contains the frontier; `not-reached`
otherwise. Visits roll up from forms the same way.

Rendered in the Build tab as nested `<details>`, matching the IR tree already
built in `sidepanel.ts:renderTrace` — same `textContent`-only construction,
since IR labels remain untrusted input. An escalated node is a `<button>`
carrying the item id; clicking it scrolls its gate card into view, keyed off the
id that is already shared by the IR, the ledger and the queue.

---

## Tests

`node --test`, no browser, no network. Everything below is pure — the ledger,
the decision table, `formKey`, `statusTree` and the liveness *logic* are all
data-in / data-out.

| File | Asserts |
|---|---|
| `test/ir.test.ts` | `formKey` is key-order independent; two IR forms differing only in key order share a key; differing in one option code do not; `recurring()` finds Vital Signs at 4 visits and yields 17 keys over 28 appearances |
| `test/run.test.ts` | ledger `begin` without a terminal call yields exactly one frontier; the frontier clears on `built`; `assertTerminated` holds across a scripted Stop/Rerun; a stop landing between `begin` and `built` leaves the item re-verified, not skipped |
| `test/run.test.ts` | the rerun decision table, all six rows, with a stubbed `verify` |
| `test/run.test.ts` | non-contiguity: a run with an escalated item in the middle still evaluates every later item independently |
| `test/run.test.ts` | `statusTree` roll-up — one escalated field escalates its form and its visit; status recomputed after a ledger change reflects it with no stored state |
| `test/resolve.test.ts` | reuse: attempt on occurrence 2, `verify` fails, falls back to scratch and increments the counter; two failures stop further attempts for that form; failures on two distinct forms set `form.reuse` to `absent`; the `copy-from` source stays the first verified occurrence after later occurrences are built |
| `test/run.test.ts` | liveness passes on a platform with no study anchor once `study.anchor: 'absent'` is set, and fails when a *different* study is named |
| `test/run.test.ts` | a `built` record is trusted regardless of its index — a run with an escalated hole at index 2 still skips a built item at index 40 |
| `test/resolve.test.ts` | a fresh `Map` passed to `resolve` shares nothing with a previous one — the session-scoping property, enforced |

**Untestable without a live page:** the liveness check's tab and
debugger-attachment probes, and reuse-affordance discovery against a real
designer. The logic on both sides of those calls is pure and covered; the calls
themselves are thin `send()` wrappers, checked by the run against the second
mock — the same standing rule as the rest of the CDP surface.

---

## Order of work

1. **`formKey` + `recurring`** in `ir.ts`, and move `stats().distinctForms` onto
   `formKey`. Pure, ~30 lines, and the existing 17/28 assertion becomes its test.
2. **The two-phase ledger** and `assertTerminated`. Pure. This is what makes a
   frontier expressible, so nothing after it can be built first.
3. **`Session` + `liveness`,** with the cache moved out of `resolve.ts` module
   scope and passed in.
4. **The rerun decision table** in the `run.ts` loop.
5. **`statusTree`** and the Build-tab view, wired to the gate queue by item id.
6. **Reuse** — discovery after the first verified occurrence, attempt, verify,
   fall back, the two counters.

Steps 1, 2 and 5 need no browser at all. Step 6 is last because it is the only
one that can be dropped without breaking the guarantee: with no reuse, every
occurrence builds independently, which is correct and merely slower.

---

## To revisit once the loop is running

- **Frontier granularity is per plan item, not per write.** A stop landing
  mid-field leaves the whole field re-verified, which re-does a few writes. That
  is cheap and safe. Per-write resumption would need the ledger to record steps,
  and is not worth it unless a single field turns out to take a long time.
- **`liveness` checks study identity by name match.** Adequate while one study
  is open. Two studies with the same protocol id on one platform would need a
  stronger key, which is a question for a clinical SME rather than a code change.
- **A new session rediscovers every fact.** Accepted, and the reason the manifest
  stays at three permissions. If a cold rerun with zero LLM calls ever matters,
  the ponytail comment above names the upgrade path.
- **Drift in already-built items is not detected within a session.** The
  frontier is re-verified on every rerun; everything with a terminal `built`
  record is trusted because the ledger says so. If a human edits an
  already-verified field on the live platform between a Stop and a same-session
  Rerun, nothing catches it — the ledger has no way to know the page diverged
  from what it last confirmed. This is the deliberate price of the fast path:
  the alternative is re-verifying 195 items on every rerun, which is the full
  top-down walk and defeats the point of having a fast path at all.
  **The remedy already exists and should be documented for the operator:
  closing and reopening the panel starts a new session, which re-verifies every
  item against the IR from the root.** If concurrent human editing ever turns
  out to be routine rather than exceptional, the cheap middle ground is
  re-verifying one sampled built item per visit on resume, rather than all of
  them.
