# Intake Study Builder Agent

A Chrome extension that reads an eSource platform through its **accessibility
tree** and a study `.ir.json`, so it can build that study by driving the UI.

**Status: pass 1 — perception only. Nothing on the page is modified.**

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
page it is on, decide, act, and confirm what it actually built. This pass builds
the perceive half.

## Build

```bash
npm install
npm run build      # → dist/, loadable unpacked
npm run dev        # rebuild on save
npm test           # 16 checks, no browser
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
│   ├── sw.ts               service worker
│   ├── cdp.ts              debugger session
│   ├── perceive.ts         two-level perception
│   ├── ir.ts               study IR
│   ├── llm.ts              provider access — Mistral wired
│   ├── sidepanel.html/.ts  the panel — Build tab + Trace tab, agent loop
│   └── panel.css           theme-aware, no CSS framework
├── test/
│   ├── perceive.test.ts    generalization + pruning checks
│   └── ir.test.ts          parser + trust-boundary checks
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
| `src/sidepanel.ts` | The two tabs. **Build**: load the IR, one Start button. **Trace**: the IR tree, the perception numbers, and the pruned and full views. Holds the run's state. | Business logic; it delegates to the three modules above. |

**Dependency direction is one-way** — `sidepanel → perceive → cdp`, and
`sidepanel → ir`, `sidepanel → llm`. Nothing lower reaches back up, which is why `compactFrom`,
`parseIR` and every expand tool are testable in plain Node with no browser.

---

## The panel

Two tabs, because they serve two different people.

**Build** is the operator's view and holds exactly two controls: load the input
file, then **Start build**. No attach button, no snapshot button — the agent
finds the active tab, attaches, reads and reports on its own. A study builder
should not have to understand the agent's internals to run it.

**Trace** is the engineering view, and it exists because the assignment asks for
traceability: for every element the agent creates you must be able to say which
entry in the input file it came from and why. It shows the parsed IR as a
visit → form → field tree, what "perceive" means and the live numbers behind it
(nodes read, nodes kept, percentage dropped), the pruned view exactly as the
model will receive it, and the level-2 tools for pulling anything pruning left
out. Detach and the screenshot toggle live here too — controls an operator has
no reason to touch.

Expandable sections are native `<details>`; 28 forms and 195 fields render with
no toggle state to manage. The IR tree is built with `textContent`, never
`innerHTML` — see below.

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
- **`__readState()` and the other debug hooks are never called.**

---

## Checks

`npm test` — 16 assertions, no browser, no network.

The one that matters: two hand-built AX trees describe the **same** Visit
Schedule screen with different DOM — one table-based, one div soup with a list
and deeper nesting — and must produce the same actionable surface. If it fails,
the agent is reading a platform rather than a page.

The rest: pruning drops wrappers but keeps study identity; a pruned node is
still reachable via `expandAround`; `dialogControls` does not leak controls
outside the dialog; a modal wins over a stale non-modal dialog; iframe roots are
not dropped. `ir.test.ts` parses the real study and asserts the counts
`data/README.md` documents — 4 visits, 28 form appearances, 17 distinct, 195
fields, 13 skip rules — plus that the planning skeleton contains no field
labels, and that malformed input throws.

`llm.test.ts` covers the trust boundary: no key-shaped literal exists anywhere
in `src/`, the shipped default carries none, `.env` and `dist/` are gitignored
and `.env.example` is blank, the key rides in a header and never
in the URL or body, requests are deterministic, a missing key fails before any
network call, and a 401 produces a readable message that does not contain the
key.

---

## Not built yet

Element-library discovery and canonical→platform type mapping; build ordering
for skip logic; reuse-vs-rebuild for repeated forms; the human gate queue; the
act and read-back loop; the run ledger for traceability.

## Assumptions

- A re-run must be idempotent against a **persisted** study, so the plan is
  computed as a diff against what is already on screen, not a replay of the IR.
  The provided mock wipes on reload; real platforms do not.
- Study identity is confirmed before building: an exact match proceeds, a
  mismatch or a screen with no identifiable study is escalated to the human
  rather than guessed past.
