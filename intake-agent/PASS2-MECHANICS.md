# Pass 2, step 0 — interaction mechanics

The layer between **perceive** and the future **act / resolve / run** loop.
Pass 1 reads a page. Pass 2 writes to it. This step is what makes a read
trustworthy enough to write against, and a write legible enough to verify.

**Status: planned, not built.** It changes no behaviour on its own — every
function here exists to be called by the act/resolve/run loop that follows.

---

## The observation this rests on

Five separate-sounding concerns — has the page settled, what kind of transition
just happened, did an overlay open, did the platform reject the write, did a
click do anything at all — are all one question asked five ways:

> **What is different between the compact view before and the compact view after?**

So this step is one primitive, `diff()`, plus four thin readings of it, plus one
write helper. Not five subsystems.

Two further concerns are deliberately *not* built here:

| Concern | Disposition |
|---|---|
| Virtualized / paginated content | Deferred behind a seam. Only ever needed where `locate()` returns null; build it there once the run shows it firing, not before. |
| Cross-origin iframes | Documented limit. `compactFrom` already walks every parentless root and a test asserts it; viewport-coordinate clicking and `backendNodeId` targeting are frame-agnostic for same-origin frames. OOPIFs would need CDP target/session management and are out of scope. |

---

## Module boundary

No new modules. The rule that decides placement:

> **`perceive` reads and compares. `act` writes and dismisses.**

`diff`, `classify`, `errorsIn` and `activeDialog` are pure functions over
`CompactNode[]`, which is `perceive`'s own type — so they live in `perceive.ts`.
`settle()` needs exactly `send` and `compactFrom`, both already there, and is an
internal of `snapshot()`. `dismiss()` dispatches an Escape key, so it belongs to
`act.ts` when that file is written.

Dependency direction is unchanged: `perceive → cdp`, and nothing lower reaches
back up. The pure half stays runnable in plain Node with no browser, which is
what keeps it testable.

```
sidepanel → run → { resolve, act, perceive, ir, llm }
                    act     → cdp        (writes, dismisses)
                    perceive → cdp       (reads, compares)
```

---

## Interfaces

```ts
// ── perceive.ts — pure ──────────────────────────────────────────────────────

export type Diff = {
  added: CompactNode[];
  removed: CompactNode[];
  changed: { ref: Ref; was: CompactNode; now: CompactNode }[];
};
export function diff(before: CompactNode[], after: CompactNode[]): Diff;

export type Transition =
  | 'none' | 'navigated' | 'in-page' | 'overlay-opened' | 'overlay-closed';
export function classify(before: Snapshot, after: Snapshot): Transition;

export type Surfaced = { ref: Ref; text: string; kind: 'alert' | 'invalid' };
export function errorsIn(d: Diff, after: Snapshot, near?: Ref): Surfaced[];

/** Modal first, innermost otherwise. Extracted from dialogControls(). */
export function activeDialog(snap: Snapshot): Ref | undefined;

// ── perceive.ts — CDP ───────────────────────────────────────────────────────

export type Settled = { quiet: boolean; polls: number; ms: number; inflight: number };

/** `poll` is injectable so the loop is testable with a scripted sequence. */
export function settle(
  opts?: { quietMs?: number; timeoutMs?: number },
  poll?: () => Promise<{ hash: string; inflight: number }>,
): Promise<Settled>;

// ── cdp.ts ──────────────────────────────────────────────────────────────────

/** Requests started and not yet finished or failed. */
export function inflight(): number;
```

`Snapshot` gains one field: `settled: Settled`. Carrying it means the ledger can
record *"acted on a page that never went quiet"* rather than the run pretending
it did — a timeout ceiling is a fact to report, not an error to throw.

---

## Mechanisms

Each is deterministic and structural. None of this calls the LLM.

### `settle()`

Poll at ~150 ms: `Accessibility.getFullAXTree` → `compactFrom` → hash the
compact view as `ref|role|name|value|state` joined. **Quiet** when the hash is
unchanged across two consecutive polls *and* `inflight() === 0`.

- `quietMs` (default 250) is the window; `timeoutMs` (default 2000) is the
  ceiling. Hitting the ceiling returns `quiet: false` and does not throw.
- Only the AX tree is read per poll. The box model and the optional screenshot
  happen once, in the final `snapshot()` read.
- Worst case is ~8 extra `getFullAXTree` calls per snapshot. Measured in the
  Trace tab before retry timing is chosen anywhere else.

Chosen over a page-injected `MutationObserver` because injection would require
`Runtime.evaluate`, which breaks the property the README states and the security
section rests on: *the agent reads, it does not execute in the page.* Hashing
the compact view also measures the thing downstream actually consumes, rather
than a proxy for it.

### `inflight()` — in cdp.ts

`Network.enable` alongside the three existing domains in `attach()`. A counter
incremented on `Network.requestWillBeSent`, decremented on
`Network.loadingFinished` and `Network.loadingFailed`, reset on detach. The
`debugger` permission already covers the Network domain, so the manifest keeps
its three permissions and one host.

### `diff()`

Index both views by `ref`. Present only in `after` → `added`; only in `before` →
`removed`; in both with any of `role` / `name` / `value` / `state` differing →
`changed`. Pure, no CDP, no ordering assumptions.

### `classify()`

| Condition | Result |
|---|---|
| `before.url !== after.url` | `navigated` |
| a `dialog` / `alertdialog` in `diff.added` | `overlay-opened` |
| a `dialog` / `alertdialog` in `diff.removed` | `overlay-closed` |
| any other non-empty diff | `in-page` |
| empty diff | `none` |

### `errorsIn()`

Nodes in `diff.added` with role `alert` or `status`, plus `diff.changed` entries
that gained `invalid`. With `near`, ranked by bounding-box distance using the
arithmetic already in `nodesNear`.

Deliberately **not** colour-based. Detecting red-styled text needs computed
styles and fails on the first platform whose error palette is not red — the
same hardcoded-to-one-mock failure the assignment forbids, wearing a
heuristic's clothes. ARIA is the layer platforms agree on, which is the entire
premise of reading the accessibility tree in the first place.

### Modal scoping in `toPrompt()`

When `activeDialog(snap)` is set, emit only nodes whose `dialog` matches it.
Three lines. Closes the hole where the model can name a `ref` for a control
sitting behind the modal that is blocking it. Nothing is lost — `expandAround`
still reaches every node by ref.

### `dismiss()` — lands with act.ts

`Input.dispatchKeyEvent` Escape, re-snapshot, confirm via `classify` that the
overlay closed; otherwise locate a close control in the dialog and click it.
Needed because an item that escalates mid-way otherwise leaves a modal open and
the next item builds into it.

---

## Changes to existing files

| File | Change |
|---|---|
| `src/perceive.ts:69` | add `describedby` to `STATE_PROPS`, to reach error text associated with a control |
| `src/perceive.ts:108` | `snapshot()` awaits `settle()` first; result carried on `Snapshot.settled` |
| `src/perceive.ts:229` | extract `activeDialog()` out of `dialogControls()`; the latter calls it |
| `src/perceive.ts:254` | `toPrompt()` scopes to `activeDialog()` when one is open |
| `src/perceive.ts` (new) | `diff`, `classify`, `errorsIn`, `settle` |
| `src/cdp.ts:30` | `Network.enable` in `attach()`; in-flight counter on the existing `onEvent` listener at `:16`; export `inflight()` |
| `src/sidepanel.ts:77` | Trace → Perception shows `settled / polls / ms` alongside the existing node counts |
| `test/perceive.test.ts` | the assertions below |

No manifest change. No new dependency. No new permission.

---

## Tests

Extending `test/perceive.test.ts`, same hand-built-AX-tree convention as the
existing generalization check. `node --test`, no browser, no network.

| Assertion |
|---|
| `diff` on identical views is empty |
| an added node lands in `added` and nowhere else |
| a value change lands in `changed`, not in `added` + `removed` |
| `classify` returns `overlay-opened` when a modal dialog appears |
| `classify` returns `navigated` on a URL change with an unchanged tree |
| `classify` returns `in-page` when the tree moves and the URL does not |
| `errorsIn` finds a newly-appeared `role=alert` node |
| `errorsIn` finds a control that gained `invalid` |
| `errorsIn` returns empty on a clean write |
| `toPrompt` scoped to an open modal omits background controls |
| a control omitted by modal scoping is still reachable via `expandAround` |
| `settle` returns `quiet` after two matching hashes with zero in-flight |
| `settle` returns `quiet: false` at the ceiling when the hash never repeats |
| `settle` does not report quiet while `inflight > 0`, even on a stable hash |

### Untestable without a live page

Stated explicitly, because pretending otherwise is worse than the gap:

- **`Network` event counting** — real CDP events; the counter logic is trivial
  and the failure mode is a stuck count, which the `settle` ceiling bounds.
- **`Input.dispatchKeyEvent` for Escape** — the real input pipeline.
- **`DOM.getContentQuads` geometry** — real layout.

These are thin `send()` wrappers. The check on them is the click spike and the
run against the second mock, the same standing rule as for the pass-1 CDP calls.

---

## Order of work

Each step ends somewhere you can stop.

1. **The pure family + tests.** `diff`, `classify`, `errorsIn`, `activeDialog`,
   scoped `toPrompt`. No browser, no CDP. Every later step reads through these.
   *Done when:* `npm test` is green with the fourteen assertions above and
   `npm run typecheck` passes.
2. **`settle()` + `inflight()`,** wired into `snapshot()` and surfaced in Trace.
   *Done when:* the Perception panel reports a real settle time on the mock —
   which is also how the retry timing in the run loop gets chosen rather than
   guessed.
3. **`dismiss()`** rides along with `act.ts`; it is not worth a pass of its own.

---

## Constraints this places on the layer above

Flagged now, because the act/resolve/run design will meet them.

- **`diff` keys on `ref`.** A re-render that replaces nodes yields fresh
  `backendDOMNodeId`s, so everything reads as `added` + `removed`. Correct for
  *"did anything change"*, wrong for *"did this value change"*. Once `locate()`
  exists, `changed` should key on descriptor identity — role plus accessible
  name — not on ref. This is the decision here most likely to need revisiting.
- **`settle`'s quiet window is a constant.** A platform with an autosave
  heartbeat never reaches `inflight === 0`, and would need the AX hash alone.
  Leave the fallback possible; do not build the configuration until a platform
  demands it.
- **Modal scoping narrows the default view.** Right while working inside a
  modal, wrong if the modal's action depends on background context.
  `expandAround` is the escape hatch. If `resolve` needs it routinely, scoping
  should become a flag on `toPrompt` rather than automatic behaviour.
- **`Snapshot` gains `settled`.** The run ledger should record it per item; a
  write made against a page that never went quiet is a different kind of
  read-back failure than a bad type mapping, and conflating them will send the
  wrong thing to the human gate.
