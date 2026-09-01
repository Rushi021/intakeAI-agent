/**
 * The write half. Four primitives, navigation, and per-write read-back.
 *
 * Knows nothing about eSource, the IR, or what is being built — it is handed a
 * description of a control and an operation, and reports what actually
 * happened. Everything platform-specific is decided above, in resolve.ts.
 *
 * Two rules hold everywhere in this file:
 *
 *  1. **A ref lives for one write.** Steps carry descriptors, never refs. Every
 *     write re-renders, and a re-render invalidates backendDOMNodeIds, so a
 *     batch of ref-carrying steps is broken by construction. apply() re-reads
 *     and re-locates before each step.
 *  2. **Geometry is read at act time.** A snapshot's bbox is document
 *     coordinates captured before any scrolling; Input.dispatchMouseEvent wants
 *     viewport coordinates now. DOM.getContentQuads gives those, and returns
 *     nothing for an unrendered element — a free visibility check.
 *
 * No Runtime.evaluate anywhere. The pass-1 property holds: the agent reads the
 * page, it does not execute in it.
 */
import { send } from './cdp.ts';
import {
  activeDialog, classify, diff, errorsIn, normName,
  type CompactNode, type Ref, type Snapshot, type Surfaced, type Transition,
} from './perceive.ts';

/** How the caller re-reads the page. Injected so act.ts never touches tabs. */
export type Read = () => Promise<Snapshot>;

// ---------------------------------------------------------------------------
// locate — the inverse of a ref, and the piece everything routes through
// ---------------------------------------------------------------------------

export type Descriptor = {
  role?: string;
  name?: string;          // exact, after normalisation
  nameContains?: string;  // substring, after normalisation
  nameAny?: readonly string[]; // reads as any of these — the vocabulary form
  inDialog?: boolean;     // restrict to the open overlay
  nth?: number;           // disambiguate a deliberate repeat, e.g. the 3rd option row
};

/**
 * Resolve a description to a live ref in this snapshot, or null.
 *
 * Abstains rather than guessing: when two nodes match equally well and no `nth`
 * was given, the answer is null. A wrong ref is a click on the wrong control,
 * and "not found" escalates to a human while "wrong control" silently builds
 * the wrong thing.
 */
export function locate(snap: Snapshot, d: Descriptor): Ref | null {
  const found = candidates(snap, d);
  if (found.length === 0) return null;
  // Negative nth counts from the end — "the row that was just added".
  if (d.nth !== undefined) return (d.nth < 0 ? found.at(d.nth) : found[d.nth])?.ref ?? null;
  if (found.length > 1) return null; // ambiguous — abstain
  return found[0].ref;
}

/** Same matching, but returns every equally-good node. Used by the gate card. */
export function candidates(snap: Snapshot, d: Descriptor): CompactNode[] {
  const dialog = d.inDialog ? activeDialog(snap) : undefined;
  const want = normName(d.name);
  const part = normName(d.nameContains);
  const any = (d.nameAny ?? []).map(normName).filter(Boolean);

  const scored: { n: CompactNode; rank: number }[] = [];
  for (const n of snap.compact) {
    if (d.role && n.role !== d.role) continue;
    if (d.inDialog && n.dialog !== dialog) continue;
    const name = normName(n.name);
    let rank = 0;
    if (d.name !== undefined) rank = name === want ? 2 : 0;
    else if (d.nameContains !== undefined) rank = name === part ? 2 : name.includes(part) ? 1 : 0;
    else if (any.length) {
      if (any.some((w) => name === w)) rank = 2;
      else if (any.some((w) => ` ${name} `.includes(` ${w} `))) rank = 1;
    } else rank = 1; // role-only match
    if (rank > 0) scored.push({ n, rank });
  }
  if (scored.length === 0) return [];
  const best = Math.max(...scored.map((s) => s.rank));
  return scored.filter((s) => s.rank === best).map((s) => s.n);
}

// ---------------------------------------------------------------------------
// Geometry and input
// ---------------------------------------------------------------------------

/** Viewport-space click point, read now. null when the element is not rendered. */
async function point(ref: Ref): Promise<{ x: number; y: number } | null> {
  await send('DOM.scrollIntoViewIfNeeded', { backendNodeId: ref }).catch(() => {});
  const res = await send<{ quads?: number[][] }>('DOM.getContentQuads', { backendNodeId: ref })
    .catch(() => ({ quads: [] as number[][] }));
  const q = res.quads?.find((c: number[]) => c.length === 8);
  if (!q) return null; // not rendered, zero-sized, or clipped away
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

export async function click(ref: Ref): Promise<boolean> {
  const p = await point(ref);
  if (!p) return false;
  const base = { x: p.x, y: p.y, button: 'left' as const, clickCount: 1 };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); // hover-gated menus
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  return true;
}

/**
 * Focus, select whatever is there, insert. insertText goes through the
 * browser's editing pipeline, so a plain-DOM listener and a framework's
 * synthetic onChange both see a real input event.
 *
 * ponytail: selectAll via the editing command rather than a Cmd/Ctrl+A branch.
 * If a platform's widget swallows it the text appends instead of replacing —
 * read-back catches that, which is the whole reason read-back is per write.
 */
export async function typeInto(ref: Ref, text: string): Promise<boolean> {
  const p = await point(ref);
  if (!p) return false;
  await send('DOM.focus', { backendNodeId: ref }).catch(() => {});
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', commands: ['selectAll'] }).catch(() => {});
  await send('Input.insertText', { text });
  return true;
}

/** Idempotent by construction: reads the current state, clicks only on a mismatch. */
export async function setChecked(snap: Snapshot, ref: Ref, want: boolean): Promise<boolean> {
  const node = snap.compact.find((c) => c.ref === ref);
  const is = (node?.state ?? []).some((s) => s.startsWith('checked') && !s.endsWith('false'));
  if (is === want) return true;
  return click(ref);
}

const key = (type: 'keyDown' | 'keyUp', k: string, code: number) =>
  send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });

export async function press(k: 'Escape' | 'Enter' | 'Tab'): Promise<void> {
  const codes = { Escape: 27, Enter: 13, Tab: 9 } as const;
  await key('keyDown', k, codes[k]);
  await key('keyUp', k, codes[k]);
}

/**
 * Pick a value from a control that may be a custom listbox or a native select.
 * Click and look for an option that appeared; if none did, fall back to
 * focus-and-type-ahead. Read-back settles which one worked.
 */
export async function choose(ref: Ref, label: string, read: Read): Promise<boolean> {
  if (!(await click(ref))) return false;
  const after = await read();
  for (const role of ['option', 'listitem', 'menuitem', 'menuitemradio', 'treeitem', 'cell']) {
    const hit = locate(after, { role, name: label });
    if (hit !== null) return click(hit);
  }
  await send('DOM.focus', { backendNodeId: ref }).catch(() => {});
  await send('Input.insertText', { text: label });
  await press('Enter');
  return true;
}

/**
 * Close whatever overlay is in front, so an item that escalates part-way does
 * not leave a modal for the next item to build into.
 */
export async function dismiss(snap: Snapshot, read: Read): Promise<Snapshot> {
  if (activeDialog(snap) === undefined) return snap;
  await press('Escape');
  let after = await read();
  if (activeDialog(after) === undefined) return after;

  for (const name of ['close', 'cancel', 'discard', 'dismiss', 'no', 'back']) {
    const hit = locate(after, { role: 'button', nameContains: name, inDialog: true });
    if (hit === null) continue;
    await click(hit);
    after = await read();
    if (activeDialog(after) === undefined) break;
  }
  return after;
}

// ---------------------------------------------------------------------------
// Navigation — reaching a screen, and confirming you reached it
// ---------------------------------------------------------------------------

/** Roles a platform clicks to move somewhere. Ordered by how likely each is. */
const NAV_ROLES = ['link', 'tab', 'button', 'row', 'gridcell', 'cell', 'listitem', 'treeitem', 'menuitem'];

/**
 * Is this screen *about* `name`?
 *
 * A heading, or a tab/link the platform marks current. Deliberately not "any
 * node mentioning it" — a list of four visits names all four, so a loose check
 * would report arrival while still on the list.
 */
export function screenNames(snap: Snapshot, name: string): boolean {
  const want = normName(name);
  return snap.compact.some((c) => {
    const has = normName(c.name).includes(want);
    if (!has) return false;
    if (c.role === 'heading') return true;
    return (c.state ?? []).some((s) => s.startsWith('selected') || s.startsWith('current'));
  });
}

async function clickNamed(snap: Snapshot, name: string): Promise<boolean> {
  for (const role of NAV_ROLES) {
    const exact = locate(snap, { role, name });
    if (exact !== null) return click(exact);
  }
  for (const role of NAV_ROLES) {
    const part = locate(snap, { role, nameContains: name });
    if (part !== null) return click(part);
  }
  return false;
}

/**
 * Return to the platform's root screen. New-session runs only, and only before
 * anything is in flight — a route change can discard an uncommitted working
 * copy, so this is never called mid-item.
 *
 * Prefers an in-page route: a control inside a banner or navigation landmark
 * named after the study, or after a root vocabulary. Falls back to the tab's
 * origin only when no in-page route is discoverable.
 */
const ROOT_WORDS = ['home', 'dashboard', 'studies', 'study', 'overview', 'schedule', 'visits', 'build'];

export async function home(snap: Snapshot, read: Read, anchors: string[]): Promise<Snapshot> {
  for (const name of [...anchors, ...ROOT_WORDS]) {
    if (!name) continue;
    for (const role of ['link', 'button', 'tab', 'menuitem']) {
      const ref = locate(snap, { role, nameContains: name });
      if (ref === null) continue;
      await click(ref);
      const after = await read();
      if (classify(snap, after) !== 'none') return after;
    }
  }
  try {
    await send('Page.navigate', { url: new URL(snap.url).origin });
    return await read();
  } catch {
    return snap; // no route found and no navigable origin — the walk starts here
  }
}

/**
 * Get to the visit/form an item needs, and confirm arrival.
 *
 * Reaching a screen is not the same as believing you reached it: every click is
 * followed by a re-read and a screenNames() check. A platform whose navigation
 * is a tree, a tab strip or a table of rows is all the same shape here — a node
 * carrying the name, clicked.
 */
export async function ensureContext(
  snap: Snapshot,
  read: Read,
  path: { visit?: string; form?: string },
): Promise<{ snap: Snapshot } | { escalate: string; snap: Snapshot }> {
  let cur = snap;
  for (const seg of [path.visit, path.form]) {
    if (!seg) continue;
    if (screenNames(cur, seg)) continue;
    if (!(await clickNamed(cur, seg))) return { escalate: `context:${seg}`, snap: cur };
    cur = await read();
    if (!screenNames(cur, seg)) return { escalate: `context:${seg}`, snap: cur };
  }
  return { snap: cur };
}

// ---------------------------------------------------------------------------
// Steps — descriptor in, what actually happened out
// ---------------------------------------------------------------------------

export type ReadBack =
  | { kind: 'value'; expect: string }
  | { kind: 'checked'; expect: boolean }
  | { kind: 'changed' }; // no specific value; the write must at least do something

export type Step = {
  target: Descriptor;
  op: 'click' | 'type' | 'check' | 'choose';
  arg?: string;
  expect: ReadBack;
  /** Which IR entry and which decision put this step here. Goes to the ledger. */
  why?: string;
};

export type StepResult = {
  step: Step;
  ok: boolean;
  reason?: string;
  errors: Surfaced[];
  transition: Transition;
};

function readBack(after: Snapshot, ref: Ref, expect: ReadBack, moved: boolean): { ok: boolean; reason?: string } {
  const node = after.compact.find((c) => c.ref === ref);
  switch (expect.kind) {
    case 'value': {
      const got = normName(node?.value ?? node?.name);
      const want = normName(expect.expect);
      return got === want || got.includes(want)
        ? { ok: true }
        : { ok: false, reason: `read back ${JSON.stringify(node?.value ?? '')}, expected ${JSON.stringify(expect.expect)}` };
    }
    case 'checked': {
      const is = (node?.state ?? []).some((s) => s.startsWith('checked') && !s.endsWith('false'));
      return is === expect.expect ? { ok: true } : { ok: false, reason: `checked=${is}, expected ${expect.expect}` };
    }
    case 'changed':
      // The trap the brief names: a control that looks like Save and is not.
      return moved ? { ok: true } : { ok: false, reason: 'the click changed nothing on the page' };
  }
}

/**
 * Run steps one at a time, re-reading and re-locating before each.
 *
 * Never a batch: the previous step's write invalidates the next step's ref, and
 * a page that moved under a stale plan is how an agent clicks the wrong thing
 * while reporting success.
 */
export async function apply(
  snap: Snapshot,
  read: Read,
  steps: Step[],
): Promise<{ snap: Snapshot; results: StepResult[]; ok: boolean }> {
  let cur = snap;
  const results: StepResult[] = [];

  for (const step of steps) {
    const ref = locate(cur, step.target);
    if (ref === null) {
      results.push({ step, ok: false, reason: 'target not found or ambiguous', errors: [], transition: 'none' });
      break;
    }

    const before = cur;
    let dispatched = true;
    switch (step.op) {
      case 'click': dispatched = await click(ref); break;
      case 'type': dispatched = await typeInto(ref, step.arg ?? ''); break;
      case 'check': dispatched = await setChecked(cur, ref, step.arg !== 'false'); break;
      case 'choose': dispatched = await choose(ref, step.arg ?? '', read); break;
    }

    cur = await read();
    const d = diff(before.compact, cur.compact);
    const errors = errorsIn(d, cur, ref);
    const moved = d.added.length + d.removed.length + d.changed.length > 0;

    if (!dispatched) {
      results.push({ step, ok: false, reason: 'element not rendered', errors, transition: classify(before, cur) });
      break;
    }
    if (errors.length) {
      results.push({ step, ok: false, reason: `platform rejected it: ${errors[0].text}`, errors, transition: classify(before, cur) });
      break;
    }

    const rb = readBack(cur, ref, step.expect, moved);
    results.push({ step, ok: rb.ok, reason: rb.reason, errors, transition: classify(before, cur) });
    if (!rb.ok) break;
  }

  return { snap: cur, results, ok: results.length === steps.length && results.every((r) => r.ok) };
}
