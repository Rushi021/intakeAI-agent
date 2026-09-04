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
import { send, markAction } from './cdp.ts';
import {
  activeDialog, classify, diff, errorsIn, insideRole, normName,
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
  excludeAny?: readonly string[]; // …but never one that reads as any of these
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
  const not = (d.excludeAny ?? []).map(normName).filter(Boolean);

  const scored: { n: CompactNode; rank: number }[] = [];
  for (const n of snap.compact) {
    if (d.role && n.role !== d.role) continue;
    if (d.inDialog && n.dialog !== dialog) continue;
    const name = normName(n.name);
    // Vocabularies overlap: a bulk-paste box called "Import list (overwrites the
    // code list)" reads as a coded-value column, and counting it as one shifts
    // every row by one — codes land beside the wrong labels, which is worse
    // than not entering them at all.
    if (not.some((w) => name === w || ` ${name} `.includes(` ${w} `))) continue;
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
export async function choose(snap: Snapshot, ref: Ref, label: string, read: Read): Promise<boolean> {
  // A native <select> carries its options in the tree already, and they have no
  // geometry — they can be found and never clicked, which is why the old
  // option-click path reported success here and changed nothing. Arrow keys do
  // not reach it either, open or closed. Type-ahead does, in one change event,
  // and lands on the same entry however the control was left, so a re-run is
  // idempotent.
  const options = optionsOf(snap, ref);
  const want = options.findIndex((o) => normName(o.name) === normName(label));
  if (want >= 0) {
    await send('DOM.focus', { backendNodeId: ref }).catch(() => {});
    for (const ch of distinguishingPrefix(options, want)) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
    return true;
  }

  // Anything else is a custom widget, whose options exist only once it is open.
  if (!(await click(ref))) return false;
  const after = await read();
  for (const role of ['option', 'listitem', 'menuitem', 'menuitemradio', 'treeitem', 'cell']) {
    const hit = locate(after, { role, name: label });
    if (hit !== null && (await click(hit))) return true;
  }

  // A combobox that is really a text input with a menu.
  await send('DOM.focus', { backendNodeId: ref }).catch(() => {});
  await send('Input.insertText', { text: label });
  await press('Enter');
  return true;
}

/**
 * The fewest leading characters that reach this option and no other.
 *
 * Type-ahead selects by prefix, so typing a whole label can overshoot when one
 * option's text extends another's ("Visible" beside "Visible When…"). Typing
 * the shortest distinguishing prefix lands on the intended entry and fires one
 * change event — which matters on a designer that discards what the new type
 * cannot hold every time the value moves.
 */
function distinguishingPrefix(options: CompactNode[], want: number): string {
  const name = options[want].name ?? '';
  for (let n = 1; n <= name.length; n++) {
    const p = normName(name.slice(0, n));
    if (!options.some((o, i) => i !== want && normName(o.name).startsWith(p))) return name.slice(0, n);
  }
  return name;
}

/**
 * The options belonging to one select: the run of `option` nodes that directly
 * follows it. Every other select's options sit in their own run elsewhere, so
 * this never mixes two lists — which matters when a field editor has several.
 */
export function optionsOf(snap: Snapshot, ref: Ref): CompactNode[] {
  const at = snap.compact.findIndex((c) => c.ref === ref);
  if (at < 0) return [];
  const out: CompactNode[] = [];
  for (let i = at + 1; i < snap.compact.length && snap.compact[i].role === 'option'; i++) out.push(snap.compact[i]);
  return out;
}

/**
 * Every way a designer offers out of an editor without committing. Used to
 * close an overlay, and — above, in run.ts — to rule a control out of being the
 * one that saves.
 */
export const CANCEL_WORDS = [
  'cancel', 'close', 'discard', 'dismiss', 'back', 'back out', 'abandon', 'revert',
  'undo', 'abort', 'exit', 'return', 'never mind', 'no',
] as const;

/**
 * Is this control a way back rather than a way forward?
 *
 * The words above, plus the leading arrow every interface puts on one. The
 * glyph is the more portable half — "← Return" and "← Up one level" share no
 * word with each other or with "Cancel" — and normName strips it, so it is
 * tested against the raw name.
 */
/**
 * Words that close an editor as often as they commit one. Owned here because
 * dismiss() needs them; resolve.ts imports them to rank a commit control.
 */
export const CLOSE_WORDS = ['done', 'finish', 'ok', 'close'] as const;

export const isWayOut = (name?: string): boolean =>
  /^\s*[←⟵⇐‹«⬅◀◄]/.test(name ?? '')
  || CANCEL_WORDS.some((w) => normName(name) === w || ` ${normName(name)} `.includes(` ${w} `));

/**
 * Close whatever overlay is in front, so an item that escalates part-way does
 * not leave a modal for the next item to build into.
 */
export async function dismiss(snap: Snapshot, read: Read): Promise<Snapshot> {
  if (activeDialog(snap) === undefined) return snap;
  await press('Escape');
  let after = await read();
  if (activeDialog(after) === undefined) return after;

  // Escape, then a way out by name, then a word that closes an editor. The last
  // group is needed because a property sheet whose only exit is "Finished"
  // stays open otherwise — and an open modal blocks every click aimed behind
  // it, so the run cannot even navigate away from it.
  for (const name of [...CANCEL_WORDS, ...CLOSE_WORDS]) {
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

/**
 * Roles a platform clicks to move somewhere. Ordered by how likely each is.
 *
 * `option` belongs here as much as `listitem` does: a platform that renders
 * its visit/form list as a native listbox pattern (`role="listbox"` over
 * `role="option"` rows, the standard ARIA idiom for a single-select list) is
 * otherwise invisible to name-matched navigation even though the model can
 * already see those nodes — `option` was in perceive.ts's actionable set and
 * resolve.ts's PICKABLE set, just missing here.
 */
export const NAV_ROLES = ['link', 'tab', 'button', 'row', 'gridcell', 'cell', 'listitem', 'treeitem', 'menuitem', 'option'];

/**
 * Is this screen *about* `name`?
 *
 * A heading, a current tab, or a unique title that is not a roster row.
 * A list of four visits names all four — that is not arrival. A designer
 * chrome title with the same words, and no roster copy, is.
 */
const ROSTER = new Set(['cell', 'row', 'listitem', 'treeitem', 'gridcell', 'button', 'link']);

/** Containers whose contents are a list of things, not a statement about the screen. */
const COLLECTION = [
  'list', 'listbox', 'table', 'grid', 'tree', 'row', 'option', 'listitem', 'treeitem',
  'cell', 'gridcell', 'rowgroup', 'menu',
] as const;

/** The shallowest heading level on the page — the one that titles the screen. */
function topHeadingLevel(snap: Snapshot): number {
  let top = Infinity;
  for (const c of snap.compact) {
    if (c.role !== 'heading') continue;
    const lvl = Number((c.state ?? []).find((s) => s.startsWith('level='))?.slice(6));
    top = Math.min(top, Number.isFinite(lvl) ? lvl : 1);
  }
  return top;
}

export function screenNames(snap: Snapshot, name: string): boolean {
  const want = normName(name);
  const top = topHeadingLevel(snap);
  if (snap.compact.some((c) => {
    const has = normName(c.name).includes(want);
    if (!has) return false;
    if (c.role === 'heading') {
      // Not every heading titles the screen. A deck of cards gives each entry
      // its own h4, and an editor that opens in place gives itself an h3; both
      // would otherwise read as "you have arrived", and the agent would then
      // build the visit's contents onto the list of visits. Only the page's
      // own top-level heading counts, and never one inside a collection.
      const lvl = Number((c.state ?? []).find((s) => s.startsWith('level='))?.slice(6));
      if (Number.isFinite(lvl) && lvl !== top) return false;
      return !insideRole(snap, c.ref, COLLECTION);
    }
    return (c.state ?? []).some((s) => s.startsWith('selected') || s.startsWith('current'));
  })) return true;

  // The remaining evidence is a title in the platform's own chrome — a header
  // bar or breadcrumb naming what is open. Content is excluded outright: a card
  // deck gives every entry a title in `main` that is indistinguishable from one,
  // and believing it makes the agent build a visit's contents onto the list of
  // visits. A row's own role is not enough either, because a listbox row renders
  // its title as a plain text node inside the row.
  const isRoster = (c: CompactNode) => ROSTER.has(c.role) || insideRole(snap, c.ref, COLLECTION);
  const exact = snap.compact.filter((c) => normName(c.name) === want);
  const chrome = exact.filter((c) => !isRoster(c) && (c.region === undefined || c.region === 'banner'));
  return chrome.length >= 1 && exact.every((c) => !isRoster(c));
}

/** Same-role, same-depth actionable entries in one run — the shape of a palette. */
const PALETTE_MIN = 8;

/**
 * Are we inside a form designer rather than on a roster?
 *
 * Two tests, because either alone misses a platform. The words catch a designer
 * whose palette is behind a dropdown; the palette shape catches one that calls
 * its library "Question Types" and its save "Store Changes", sharing no word
 * with anything here.
 *
 * ponytail: PALETTE_MIN is a threshold, not a measurement — high enough that a
 * navigation bar of four or five tabs is not a palette. A platform with a
 * seven-entry library needs it lowered, and a roster of eight same-depth
 * buttons would need a container test instead.
 */
function inDesigner(snap: Snapshot): boolean {
  if (snap.compact.some((c) => {
    const n = normName(c.name);
    return n === 'save' || n.startsWith('save ') || n.includes('preview') || n.includes('library') || n.includes('palette');
  })) return true;

  // Distinct names, not a count of controls. A roster of three forms shows
  // "Edit / Activate / Delete" on each row — nine buttons at one depth, three
  // names — and mistaking that for a palette puts the agent in a designer it is
  // not in, so it adds a field to a list of forms. A library's entries all
  // differ, because each one is a different type.
  const runs = new Map<string, Set<string>>();
  for (const c of snap.compact) {
    if (!c.name) continue;
    if (c.role !== 'button' && c.role !== 'listitem' && c.role !== 'option' && c.role !== 'menuitem') continue;
    const key = `${c.role}@${c.depth}`;
    (runs.get(key) ?? runs.set(key, new Set()).get(key)!).add(normName(c.name));
  }
  return [...runs.values()].some((names) => names.size >= PALETTE_MIN);
}

export { inDesigner };

const CHROME_TABS = new Set(['patients', 'calendar', 'study plan', 'reports']);

/**
 * Leave a nested designer via in-page chrome. Never reloads the tab — many
 * platforms (and this class of mock) hold the study only in memory.
 */
export async function stepOut(snap: Snapshot, read: Read, ancestor?: string): Promise<Snapshot> {
  let clicked: string | undefined;
  if (ancestor) {
    const hit = candidates(snap, { role: 'button', name: ancestor })[0]
      ?? candidates(snap, { role: 'link', name: ancestor })[0];
    if (hit) {
      clicked = hit.name;
      await click(hit.ref);
    }
  }
  if (!clicked) {
    // The explicit way out first — "← Return", "← Up one level", "Back". Every
    // designer offers one, and it is the only control guaranteed to leave.
    const out = snap.compact.find((c) =>
      (c.role === 'button' || c.role === 'link') && isWayOut(c.name)
      && !(c.state ?? []).some((s) => s.startsWith('current') || s.startsWith('selected')));
    if (out) {
      clicked = out.name;
      await click(out.ref);
    }
  }
  if (!clicked) {
    for (const w of ['schedule', 'visits', 'close']) {
      const hit = candidates(snap, { role: 'button', nameContains: w }).find((c) =>
        !(c.state ?? []).some((s) => s.startsWith('current') || s.startsWith('selected')),
      );
      if (hit) {
        clicked = hit.name;
        await click(hit.ref);
        break;
      }
    }
  }
  if (!clicked) {
    for (const c of snap.compact) {
      if (c.role !== 'button' && c.role !== 'link') continue;
      const n = normName(c.name);
      if (!n || CHROME_TABS.has(n)) continue;
      if (n === 'save' || n.startsWith('save ') || n === 'activate' || n.includes('preview')) continue;
      clicked = c.name;
      await click(c.ref);
      break;
    }
  }
  return clicked ? await read() : snap;
}

/** Already on this visit/form, including a designer whose back-chrome names it. */
function here(snap: Snapshot, name: string): boolean {
  if (screenNames(snap, name)) return true;
  if (!inDesigner(snap)) return false;
  const want = normName(name);
  return snap.compact.some((c) => {
    const n = normName(c.name);
    return n === want || n.endsWith(` ${want}`);
  });
}

const OPEN_WORDS = ['edit', 'open', 'design', 'designer', 'modify', 'configure'];

function nearOpen(snap: Snapshot, name: string): Ref | null {
  const want = normName(name);
  const i = snap.compact.findIndex((c) => normName(c.name) === want);
  if (i < 0) return null;
  for (const n of snap.compact.slice(i, i + 16)) {
    if (n.role !== 'button' && n.role !== 'link' && n.role !== 'menuitem') continue;
    const nm = normName(n.name);
    if (OPEN_WORDS.some((w) => nm === w || ` ${nm} `.includes(` ${w} `))) return n.ref;
  }
  return null;
}

/** Is there something on this screen that navigation could click for `name`? */
function reachable(snap: Snapshot, name: string): boolean {
  for (const role of NAV_ROLES) {
    if (candidates(snap, { role, name }).length > 0) return true;
    if (candidates(snap, { role, nameContains: name }).length > 0) return true;
  }
  return false;
}

async function clickNamed(snap: Snapshot, name: string): Promise<boolean> {
  // Navigation takes the first exact match. Writes still go through locate(),
  // which abstains on ties; a list of two identical visit rows should still be
  // enterable, otherwise every child of that visit escalates.
  for (const role of NAV_ROLES) {
    const hits = candidates(snap, { role, name });
    if (hits.length > 0) return click(hits[0].ref);
  }
  for (const role of NAV_ROLES) {
    const hits = candidates(snap, { role, nameContains: name });
    if (hits.length > 0) return click(hits[0].ref);
  }
  return false;
}

/**
 * Return to the platform's root screen. In-page only.
 *
 * Never Page.navigate: a reload wipes in-memory studies and discards drafts.
 * If no in-page route exists, stay put — the caller escalates rather than
 * destroying what was built.
 */
const ROOT_WORDS = ['schedule', 'visits', 'home', 'dashboard', 'studies', 'overview', 'build', 'study', 'back'];

/**
 * @param arrived what "home" means to the caller — usually "the screen with the
 *   control that adds a visit on it". Without a goal this stops at the first
 *   chrome entry that changes the page, which on a platform whose navigation
 *   lists four modules is whichever one comes first, and every item after it
 *   escalates for want of a screen. With one, a click that lands somewhere
 *   unhelpful is just a step on the way rather than the answer.
 */
export async function home(
  snap: Snapshot,
  read: Read,
  anchors: string[],
  arrived: (s: Snapshot) => boolean = () => true,
): Promise<Snapshot> {
  // An overlay first: a modal property sheet blocks every click aimed behind it,
  // so climbing out of a designer with one open moves nothing and the caller
  // escalates for want of a screen it could have reached.
  snap = await dismiss(snap, read);
  if (inDesigner(snap)) {
    const left = await stepOut(snap, read, anchors[0]);
    if (classify(snap, left) !== 'none') snap = left;
  }
  if (arrived(snap)) return snap;

  // Climb before walking sideways. On a platform whose chrome is a breadcrumb
  // and whose only route back is "← Return", none of the root words appear
  // anywhere, and the anchors loop below has nothing to click. Bounded: the
  // hierarchy is study → visit → form, so four steps is already past the top.
  for (let i = 0; i < 4; i++) {
    const out = snap.compact.find((c) => (c.role === 'button' || c.role === 'link') && isWayOut(c.name));
    if (!out) break;
    await click(out.ref);
    const after = await read();
    if (classify(snap, after) === 'none') break;
    snap = after;
    if (arrived(snap)) return snap;
  }

  for (const name of [...anchors, ...ROOT_WORDS]) {
    if (!name) continue;
    for (const role of ['link', 'button', 'tab', 'menuitem']) {
      const hit = candidates(snap, { role, nameContains: name }).find((c) =>
        !(c.state ?? []).some((s) => s.startsWith('current') || s.startsWith('selected')),
      );
      if (!hit) continue;
      await click(hit.ref);
      const after = await read();
      if (classify(snap, after) === 'none') continue;
      if (arrived(after)) return after;
      snap = after; // somewhere else, but somewhere: keep looking from here
    }
  }
  return snap;
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
    if (here(cur, seg)) continue;
    const namedHit = await clickNamed(cur, seg);
    if (namedHit) cur = await read();
    if (here(cur, seg)) continue;

    const edit = nearOpen(cur, seg);
    if (edit) {
      await click(edit);
      cur = await read();
      if (here(cur, seg)) continue;
    }

    if (!namedHit) {
      // Nothing on this screen carries the name. Climb out of a designer first
      // — its own contents are all that is visible from inside one.
      if (inDesigner(cur)) {
        cur = await stepOut(cur, read, path.visit);
        if (here(cur, seg)) continue;
        if (await clickNamed(cur, seg)) {
          cur = await read();
          if (here(cur, seg)) continue;
        }
      }

      // Still nothing: go back to the root and come in again. One step out is
      // not enough when the run is three levels deep in a different visit,
      // which is exactly where a Resume after a gate answer starts.
      cur = await home(cur, read, [seg], (s) => here(s, seg) || reachable(s, seg));
      if (here(cur, seg)) continue;
      if (await clickNamed(cur, seg)) {
        cur = await read();
        if (here(cur, seg)) continue;
      }
    }
    return { escalate: `context:${seg}`, snap: cur };
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

/**
 * The control the write landed on, after the write.
 *
 * A write that re-renders its own container destroys the ref it was made
 * against — every backendDOMNodeId in that subtree is new. Looking the old ref
 * up then finds nothing, which is indistinguishable from a control that
 * rejected the write, and the step fails even though it succeeded. So fall back
 * to the descriptor that located it in the first place and read the
 * replacement. locate() still abstains when that is ambiguous, so this widens
 * what can be read, never what can be believed.
 */
function nodeAfter(after: Snapshot, ref: Ref, target: Descriptor): CompactNode | undefined {
  const direct = after.compact.find((c) => c.ref === ref);
  if (direct) return direct;
  const again = locate(after, target);
  return again === null ? undefined : after.compact.find((c) => c.ref === again);
}

export function readBack(after: Snapshot, ref: Ref, step: Step, moved: boolean): { ok: boolean; reason?: string; missing?: boolean } {
  const { expect } = step;
  // A click whose point is to replace the control it clicked has no node left
  // to read; `moved` is the evidence. Answered before the node is looked up.
  if (expect.kind === 'changed') {
    // The trap the brief names: a control that looks like Save and is not.
    return moved ? { ok: true } : { ok: false, reason: 'the click changed nothing on the page' };
  }

  const node = nodeAfter(after, ref, step.target);
  // No node is not an empty value. Reporting it as one reads like a write that
  // was rejected, and sends whoever is holding the gate card looking for a
  // typing bug instead of a control that moved.
  if (!node) {
    // Say which of the two it is. "Gone" and "now ambiguous" have different
    // causes — a panel still rebuilding versus a descriptor that stopped being
    // unique — and a gate card that cannot tell them apart is a guess.
    const n = candidates(after, step.target).length;
    return {
      ok: false, missing: true,
      reason: n > 1
        ? `after the write ${n} controls match this description, so which one holds the value is not decidable`
        : 'the control was gone after the write, so what it holds could not be read',
    };
  }

  switch (expect.kind) {
    case 'value': {
      // A custom widget carries its chosen value as its accessible name, so the
      // fallback is load-bearing — but report whichever one was compared.
      const shown = node.value ?? node.name ?? '';
      const got = normName(shown);
      const want = normName(expect.expect);
      return got === want || got.includes(want)
        ? { ok: true }
        : { ok: false, reason: `read back ${JSON.stringify(shown)}, expected ${JSON.stringify(expect.expect)}` };
    }
    case 'checked': {
      const is = (node.state ?? []).some((s) => s.startsWith('checked') && !s.endsWith('false'));
      return is === expect.expect ? { ok: true } : { ok: false, reason: `checked=${is}, expected ${expect.expect}` };
    }
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
    // Everything open right now is background noise as far as this step is
    // concerned; settle() should wait only on what the dispatch below starts.
    markAction();
    switch (step.op) {
      case 'click': dispatched = await click(ref); break;
      case 'type': dispatched = await typeInto(ref, step.arg ?? ''); break;
      case 'check': dispatched = await setChecked(cur, ref, step.arg !== 'false'); break;
      case 'choose': dispatched = await choose(cur, ref, step.arg ?? '', read); break;
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

    let rb = readBack(cur, ref, step, moved);
    // A panel still rebuilding itself has no control to read yet, and settle()
    // gives up after a fixed budget — under load it hands back a half-drawn
    // page. One more read separates "not there yet" from "not there". Only the
    // missing case retries: a control that is present and holds the wrong value
    // failed for a real reason, and re-reading it would only hide that.
    if (rb.missing) {
      cur = await read();
      rb = readBack(cur, ref, step, moved);
    }
    results.push({ step, ok: rb.ok, reason: rb.reason, errors, transition: classify(before, cur) });
    if (!rb.ok) break;
  }

  return { snap: cur, results, ok: results.length === steps.length && results.every((r) => r.ok) };
}
