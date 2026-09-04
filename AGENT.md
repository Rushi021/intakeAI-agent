# Agent instructions — Intake Study Builder

Instructions for AI agents working on this codebase. Read this before making changes.

## What we are building

A **Chrome extension** that reads a study specification (`.ir.json`) and builds it into an **eSource form designer** by driving the browser UI — with a human in the loop for anything uncertain.

The agent must **perceive** the page (accessibility tree), **decide** what to do (synonyms → cached facts → model), **act** (locate controls, write values), **verify** read-back, and **escalate** when it cannot proceed confidently. Every plan item ends as either **built and verified** or **escalated** — never silently skipped.

```
intake-agent/          → Part 1 — the extension (deliverable)
intake-soa/            → Part 2 — SoA extraction from protocol PDFs (independent; do not mix with intake-agent/)
intake-takehome-2/     → supplied mock eSource + sample IR files (assignment material only)
takehome-1b/           → supplied protocol PDFs for Part 2 (local only, gitignored)
```

Part 1 assignment: `intake-takehome-2/ASSIGNMENT.md`. Architecture: `intake-agent/ARCHITECTURE.md`.
Part 2 assignment: `Intake AI Take Home 1b.pdf`. Setup: root `README.md`. Architecture: `intake-soa/ARCHITECTURE.md`.

---

## Requirements

| Requirement | Detail |
|---|---|
| Input | A structured study IR: visits → forms → fields with canonical types, labels, coded values, ranges, skip logic. Schema in `intake-takehome-2/data/README.md`. |
| Output | The study built in the eSource platform, matching the input file. |
| Human gate | Escalate ambiguous mappings, missing controls, or failed verification **before** committing. Batch escalations by question, not per-field. The run never blocks — finish everything else, queue decisions for the operator. |
| Generalization | **Same extension, same code, no changes** must work on eSource platforms the agent has never seen — different layout, DOM, widget library, navigation, vocabulary, Save button location. |
| Traceability | For every element created, show which input-file entry it came from and why. |
| Idempotency | Re-runs must not duplicate visits, forms, or fields. Re-verify against what is on screen, not blindly replay the input. |
| Verify read-back | After building, confirm type, label, options (code + label pairs), range/units, skip rules. Presence alone is not success. |
| Deliverables | Loadable extension, README, screen recording of one end-to-end run including the human gate. |

---

## What you must NOT do

These are disqualifying failures, not style preferences.

**Do not hardcode anything from the supplied mock.**

No CSS selectors, element IDs, button labels, element-library entry names, screen order, or DOM structure tied to `intake-takehome-2/esource-mock`. Dumping this mock's DOM and writing deterministic selectors will score perfectly here and fail everywhere else.

**Do not overfit to the sample data.**

`abc-101-study.ir.json` is one example study. Do not bake in its visit names, form names, field counts, or specific skip-logic patterns. The IR schema is the contract; individual studies vary.

**Do not use the mock's debug hooks.**

`__readState()`, `__exportState()`, `__resetState()` exist for human reviewers only. An agent that calls them has not solved the problem — real platforms expose nothing like this.

**Do not silently commit or silently skip.**

A missed form or field is the worst failure. An extra field is bad; a missing one is worse. Escalate rather than guess on type mapping, coded values, skip logic, or save confirmation.

**Do not rely on string matching for type mapping.**

Canonical types (`single_select`, `checkbox`, etc.) map to platform vocabulary by **meaning**, not spelling. Near-identical library entries sit adjacent on real platforms. Abstain on ties; let the human decide.

**Do not assume platform behavior.**

Whether repeating forms are reused or rebuilt, whether bulk paste appends or replaces, whether navigating away discards drafts — discover at runtime, cache as session facts.

---

## How to build it correctly

1. **Perceive via the accessibility tree** (`Accessibility.getFullAXTree` over CDP). Prune to a compact view; expand on demand. Detect settling, modals, and errors through ARIA — not colors or mock-specific styling.
2. **Locate controls by description** — role, name, context — and abstain when ambiguous. `locate()` is the inverse of a ref.
3. **Resolve types in layers**: synonym table → comparative scorer with acceptance threshold → model (once per question, batched). Learn platform facts from human gate answers; reuse within a session.
4. **Build in dependency order** — skip-logic controllers must exist before their rules. Confirm saves explicitly; read back after every write.
5. **Test generalization** by running unchanged against alternate platforms (`TEST-MATRIX.md`) or a modified mock (renamed library, moved Save, reordered screens, different DOM). Report honestly.

---

## Key references

| Doc | Purpose |
|---|---|
| `intake-takehome-2/ASSIGNMENT.md` | Full assignment brief and evaluation criteria |
| `intake-takehome-2/data/README.md` | IR schema and canonical type vocabulary |
| `intake-takehome-2/TEST-MATRIX.md` | Alternate platforms and study fixtures for generalization testing |
| `README.md` | How to run both parts |
| `intake-agent/ARCHITECTURE.md` | Module layout and design decisions |
| `intake-soa/ARCHITECTURE.md` | Part 2 architecture, schema, and known limitations |
| `intake-agent/PASS2.md` | Pipeline design (perceive → decide → act → verify → escalate) |
