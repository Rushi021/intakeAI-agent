/**
 * Two-level perception.
 *
 *  Level 1 — the compact view. Actionable controls plus the context that
 *            explains them. This is the only thing the model sees by default.
 *  Level 2 — the full detail. Complete AX tree, DOM box model and screenshot
 *            are kept in the snapshot record and never discarded; the model
 *            pulls from them on demand via the expand tools below.
 *
 * Pruning therefore reduces tokens without losing information: any node left
 * out of the compact view is still retrievable by ref.
 */
import { send, inflight } from './cdp.ts';

export type Ref = number; // CDP backendDOMNodeId — stable, resolves to a live element

export type AXNode = {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  properties?: { name: string; value: { value?: unknown } }[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: Ref;
};

export type CompactNode = {
  ref: Ref;
  role: string;
  name?: string;
  value?: string;
  state?: string[];
  bbox?: [number, number, number, number]; // x, y, w, h
  depth: number;
  dialog?: Ref; // ref of the enclosing dialog, when inside one
  /** The landmark this node sits in — 'banner', 'navigation', 'main', … .
   *  Chrome and content are otherwise indistinguishable by name alone, and
   *  "the one action offered in the content area" is the most portable
   *  description of an add control there is. */
  region?: string;
};

export type Snapshot = {
  url: string;
  title: string;
  compact: CompactNode[];
  /** Whether the page had stopped changing when this was read. Never discarded:
   *  a write made against an unsettled page is a different failure from a bad
   *  decision, and the ledger has to be able to tell them apart. */
  settled: Settled;
  /** Level 2, kept locally. Not serialised to the model. */
  full: {
    byAxId: Map<string, AXNode>;
    byRef: Map<Ref, AXNode>;
    bbox: Map<Ref, [number, number, number, number]>;
    screenshot?: string; // data URL
  };
};

/** Controls a builder can act on. */
const ACTIONABLE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'menu',
  'tab', 'switch', 'slider', 'spinbutton', 'treeitem', 'listitem', 'row',
  'gridcell', 'cell', 'columnheader', 'rowheader', 'textfield',
]);

/** Nodes that explain the controls: what screen this is, what went wrong. */
const CONTEXT = new Set([
  'heading', 'dialog', 'alertdialog', 'alert', 'status', 'tooltip', 'log',
  'labeltext', 'legend', 'caption', 'tablist', 'table', 'grid', 'list',
  'progressbar', 'banner', 'main', 'navigation', 'form', 'region',
]);

/** ARIA landmarks. The page's own division of chrome from content. */
const LANDMARKS = new Set([
  'banner', 'navigation', 'main', 'complementary', 'contentinfo', 'form', 'search', 'region',
]);

/** States worth spending tokens on — the ones that change what an action does. */
const STATE_PROPS = new Set([
  'disabled', 'checked', 'expanded', 'selected', 'required', 'invalid',
  'focused', 'readonly', 'multiselectable', 'level', 'pressed', 'modal',
  'haspopup', // a control that opens a menu — where a designer hides its Save
  'describedby', // reaches the error text a platform associates with a control
]);

const norm = (r?: string) => (r ?? '').toLowerCase();

/**
 * Accessible names, compared the way a human would read them: case, padding,
 * punctuation and runs of whitespace are noise. Shared by locate() and the
 * type scorer, so "Add Field", "add field" and "+ Add  Field" are one name.
 */
export const normName = (s?: string) =>
  (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function stateOf(n: AXNode): string[] | undefined {
  const out: string[] = [];
  for (const p of n.properties ?? []) {
    // Lower-cased on the way out as well as on the way in. CDP reports
    // `hasPopup`, and every reader of this array tests a lower-case prefix, so
    // a camel-cased name here is a state nothing can ever match.
    const key = p.name.toLowerCase();
    if (!STATE_PROPS.has(key)) continue;
    const v = p.value?.value;
    if (v === false || v === 'false' || v === undefined || v === '') continue;
    out.push(v === true || v === 'true' ? key : `${key}=${String(v)}`);
  }
  return out.length ? out : undefined;
}

/**
 * Keep a node when it is actionable, when it is context, or when it is loose
 * text that is not already carried as some control's accessible name.
 */
function keep(n: AXNode, role: string, parentName?: string, parentKept = false): boolean {
  if (n.ignored) return false;
  if (n.backendDOMNodeId === undefined) return false;
  if (ACTIONABLE.has(role) || CONTEXT.has(role)) return true;
  if (role === 'statictext' || role === 'paragraph') {
    const t = n.name?.value?.trim();
    if (!t) return false;
    // Drop label-echo on a control we already kept. Keep the text when the
    // parent was a wrapper we discarded — that is how a designer title lives
    // in a nameless generic span.
    if (t === parentName && parentKept) return false;
    return true;
  }
  return false;
}

/**
 * @param meta url and title, read from the tabs API rather than by evaluating
 *   script in the page — the agent never injects code into the platform.
 * @param opts screenshot is off by default: an eSource screen can carry patient
 *   data, and it is the one artefact here that would capture it wholesale.
 */
export async function snapshot(
  meta: { url: string; title: string },
  opts: { screenshot?: boolean } = {},
): Promise<Snapshot> {
  const settled = await settle();

  const [{ nodes }, boxes, shot] = await Promise.all([
    send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree'),
    boxModel(),
    opts.screenshot
      ? send<{ data: string }>('Page.captureScreenshot', { format: 'png' }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const { byAxId, byRef, compact } = compactFrom(nodes, boxes);

  return {
    url: meta.url,
    title: meta.title,
    compact,
    settled,
    full: { byAxId, byRef, bbox: boxes, screenshot: shot ? `data:image/png;base64,${shot.data}` : undefined },
  };
}

/**
 * The pure half of level 1: AX nodes in, compact view out. No CDP, so the
 * generalization check can run it against hand-built trees.
 */
export function compactFrom(nodes: AXNode[], boxes: Map<Ref, [number, number, number, number]>) {
  const byAxId = new Map<string, AXNode>();
  const byRef = new Map<Ref, AXNode>();
  for (const n of nodes) {
    byAxId.set(n.nodeId, n);
    if (n.backendDOMNodeId !== undefined) byRef.set(n.backendDOMNodeId, n);
  }

  // Every parentless node is a root: the main document plus one per
  // same-origin iframe. Walking only the first silently drops whole forms,
  // and a missing form is the most heavily penalised failure there is.
  const compact: CompactNode[] = [];
  const roots = nodes.filter((n) => !n.parentId);
  for (const root of roots) walk(root, 0, undefined, undefined, false, undefined);

  function walk(n: AXNode | undefined, depth: number, parentName: string | undefined, dialog: Ref | undefined, parentKept: boolean, region: string | undefined) {
    if (!n) return;
    const role = norm(n.role?.value);
    const here = role === 'dialog' || role === 'alertdialog' ? n.backendDOMNodeId ?? dialog : dialog;
    const inRegion = LANDMARKS.has(role) ? role : region;
    const kept = keep(n, role, parentName, parentKept);
    if (kept) {
      const ref = n.backendDOMNodeId!;
      compact.push({
        ref,
        role,
        name: n.name?.value?.trim() || undefined,
        value: n.value?.value?.trim() || undefined,
        state: stateOf(n),
        bbox: boxes.get(ref),
        depth,
        dialog: here,
        region: inRegion,
      });
    }
    const nextName = n.name?.value?.trim() || parentName;
    for (const id of n.childIds ?? []) walk(byAxId.get(id), depth + 1, nextName, here, kept, inRegion);
  }

  return { byAxId, byRef, compact };
}

/** One DOMSnapshot call gets every box, instead of one getBoxModel per node. */
async function boxModel(): Promise<Map<Ref, [number, number, number, number]>> {
  const out = new Map<Ref, [number, number, number, number]>();
  try {
    const snap = await send<any>('DOMSnapshot.captureSnapshot', { computedStyles: [] });
    for (const doc of snap.documents ?? []) {
      const backend: number[] = doc.nodes?.backendNodeId ?? [];
      const idx: number[] = doc.layout?.nodeIndex ?? [];
      const bounds: number[][] = doc.layout?.bounds ?? [];
      for (let i = 0; i < idx.length; i++) {
        const ref = backend[idx[i]];
        const b = bounds[i];
        if (ref !== undefined && b) out.set(ref, [b[0], b[1], b[2], b[3]]);
      }
    }
  } catch {
    // ponytail: no boxes rather than no snapshot — only nodesNear() degrades.
  }
  // ponytail: only the bounds are retained from the DOM snapshot, not the node
  // tree. Retain documents+strings too if a level-2 "show me the DOM here" tool
  // is ever needed; the AX tree answers every tool we have today.
  return out;
}

// ---------------------------------------------------------------------------
// Level 2 — what the model can ask for when the compact view is not enough.
// ---------------------------------------------------------------------------

type Detail = { ref?: Ref; role: string; name?: string; value?: string; state?: string[]; depth: number };

const detail = (n: AXNode, depth = 0): Detail => ({
  ref: n.backendDOMNodeId,
  role: norm(n.role?.value),
  name: n.name?.value?.trim() || undefined,
  value: n.value?.value?.trim() || undefined,
  state: stateOf(n),
  depth,
});

function dump(snap: Snapshot, n: AXNode | undefined, depth: number, out: Detail[], limit: number): void {
  if (!n || out.length >= limit) return;
  out.push(detail(n, depth));
  for (const id of n.childIds ?? []) dump(snap, snap.full.byAxId.get(id), depth + 1, out, limit);
}

/** "Show me the subtree around candidate 17." Unpruned, ancestors included. */
export function expandAround(snap: Snapshot, ref: Ref, up = 2, limit = 200): Detail[] {
  let node = snap.full.byRef.get(ref);
  if (!node) return [];
  for (let i = 0; i < up && node?.parentId; i++) node = snap.full.byAxId.get(node.parentId) ?? node;
  const out: Detail[] = [];
  dump(snap, node, 0, out, limit);
  return out;
}

/**
 * Is `ref` inside a node with one of these roles?
 *
 * The AX parent chain, which the compact view flattens away. Used to tell a
 * value being typed into an editor from the same text standing on its own: a
 * draft echoes its content as a text node inside the box holding it, and that
 * echo is otherwise indistinguishable from the built thing appearing in a list.
 */
export function insideRole(snap: Snapshot, ref: Ref, roles: readonly string[]): boolean {
  let node = snap.full.byRef.get(ref);
  for (let hops = 0; node && hops < 40; hops++) {
    node = node.parentId ? snap.full.byAxId.get(node.parentId) : undefined;
    if (node && roles.includes(norm(node.role?.value))) return true;
  }
  return false;
}

/**
 * The overlay currently in front of the user, if any. A modal is the one
 * blocking them; otherwise the innermost dialog wins.
 */
export function activeDialog(snap: Snapshot): Ref | undefined {
  const dialogs = snap.compact.filter((c) => c.role === 'dialog' || c.role === 'alertdialog');
  const top = dialogs.find((d) => d.state?.some((s) => s.startsWith('modal'))) ?? dialogs.at(-1);
  return top?.ref;
}

/** "Show me every control in the open dialog." */
export function dialogControls(snap: Snapshot, limit = 300): Detail[] {
  const top = activeDialog(snap);
  if (top === undefined) return [];
  const out: Detail[] = [];
  dump(snap, snap.full.byRef.get(top), 0, out, limit);
  return out;
}

/** "Show me what is near these coordinates." */
export function nodesNear(snap: Snapshot, x: number, y: number, radius = 120): Detail[] {
  const hits: { d: number; n: AXNode }[] = [];
  for (const [ref, b] of snap.full.bbox) {
    const dx = b[0] + b[2] / 2 - x;
    const dy = b[1] + b[3] / 2 - y;
    const d = Math.hypot(dx, dy);
    const n = snap.full.byRef.get(ref);
    if (d <= radius && n && !n.ignored) hits.push({ d, n });
  }
  hits.sort((a, b) => a.d - b.d);
  return hits.slice(0, 40).map((h) => detail(h.n));
}

/**
 * What actually goes to the model: no bboxes, no empty keys.
 *
 * Scoped to the open overlay when there is one, so the model cannot name a ref
 * for a control sitting behind the modal that is blocking it. Nothing is lost —
 * expandAround() still reaches every node by ref.
 */
export function toPrompt(snap: Snapshot): string {
  const top = activeDialog(snap);
  const nodes = top === undefined ? snap.compact : snap.compact.filter((c) => c.dialog === top);
  const lines = nodes.map((c) => {
    const parts = [`${'  '.repeat(Math.min(c.depth, 12))}[${c.ref}] ${c.role}`];
    if (c.name) parts.push(JSON.stringify(c.name));
    if (c.value) parts.push(`= ${JSON.stringify(c.value)}`);
    if (c.state) parts.push(`{${c.state.join(',')}}`);
    if (c.dialog) parts.push('(in dialog)');
    return parts.join(' ');
  });
  const scope = top === undefined ? '' : `\nscope: inside the open dialog [${top}]`;
  return `url: ${snap.url}\ntitle: ${snap.title}${scope}\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Comparison — one primitive, four readings of it.
//
// "Has the page settled", "what kind of transition was that", "did an overlay
// open", "did the platform reject my write" and "did that click do anything"
// are all the same question: what is different between two compact views.
// ---------------------------------------------------------------------------

export type Diff = {
  added: CompactNode[];
  removed: CompactNode[];
  changed: { ref: Ref; was: CompactNode; now: CompactNode }[];
};

/** Everything that identifies a node's current meaning. Not its position. */
const sig = (n: CompactNode) =>
  `${n.role}|${n.name ?? ''}|${n.value ?? ''}|${(n.state ?? []).join(',')}`;

export function diff(before: CompactNode[], after: CompactNode[]): Diff {
  const b = new Map(before.map((n) => [n.ref, n]));
  const a = new Map(after.map((n) => [n.ref, n]));
  const changed: Diff['changed'] = [];
  for (const [ref, was] of b) {
    const now = a.get(ref);
    if (now && sig(was) !== sig(now)) changed.push({ ref, was, now });
  }
  return {
    added: after.filter((n) => !b.has(n.ref)),
    removed: before.filter((n) => !a.has(n.ref)),
    changed,
  };
}

const isDialog = (n: CompactNode) => n.role === 'dialog' || n.role === 'alertdialog';

export type Transition = 'none' | 'navigated' | 'in-page' | 'overlay-opened' | 'overlay-closed';

export function classify(before: Snapshot, after: Snapshot): Transition {
  if (before.url !== after.url) return 'navigated';
  const d = diff(before.compact, after.compact);
  if (d.added.some(isDialog)) return 'overlay-opened';
  if (d.removed.some(isDialog)) return 'overlay-closed';
  if (d.added.length || d.removed.length || d.changed.length) return 'in-page';
  return 'none';
}

export type Surfaced = { ref: Ref; text: string; kind: 'alert' | 'invalid' };

/**
 * Did the platform say no? Distinct from read-back, which asks whether a value
 * stuck. A range the designer refuses, a required field left blank, a duplicate
 * name — all surface here and none of them show up as a wrong value.
 *
 * ARIA only. Detecting red-styled text would need computed styles and would
 * fail on the first platform whose error palette is not red — the same
 * hardcoded-to-one-mock failure the assignment forbids, wearing a heuristic's
 * clothes. Roles and states are the layer platforms agree on.
 */
export function errorsIn(d: Diff, after: Snapshot, near?: Ref): Surfaced[] {
  const out: Surfaced[] = [];

  for (const n of d.added) {
    if ((n.role === 'alert' || n.role === 'alertdialog' || n.role === 'status') && n.name) {
      out.push({ ref: n.ref, text: n.name, kind: 'alert' });
    }
  }
  for (const c of d.changed) {
    const before = (c.was.state ?? []).some((s) => s.startsWith('invalid'));
    const now = (c.now.state ?? []).some((s) => s.startsWith('invalid'));
    if (!before && now) {
      const detail = (c.now.state ?? []).find((s) => s.startsWith('describedby')) ?? '';
      out.push({ ref: c.ref, text: [c.now.name, detail].filter(Boolean).join(' — '), kind: 'invalid' });
    }
  }

  if (near === undefined) return out;
  const anchor = after.full.bbox.get(near);
  if (!anchor) return out;
  const dist = (r: Ref) => {
    const b = after.full.bbox.get(r);
    if (!b) return Number.MAX_SAFE_INTEGER;
    return Math.hypot(b[0] + b[2] / 2 - (anchor[0] + anchor[2] / 2), b[1] + b[3] / 2 - (anchor[1] + anchor[3] / 2));
  };
  return out.sort((x, y) => dist(x.ref) - dist(y.ref));
}

// ---------------------------------------------------------------------------
// Settling — never read a page that is still moving.
// ---------------------------------------------------------------------------

export type Settled = {
  quiet: boolean; polls: number; ms: number; inflight: number;
  /** Longest gap between two polls. Large means the sampler itself was starved. */
  maxGapMs: number;
  /** The ceiling actually in force, after any backoff. */
  ceilingMs: number;
};

const QUIET_MS = 250;
const TIMEOUT_MS = 2500;
const POLL_MS = 120;
/** Two stable samples, never one: see the false-quiet note on settle(). */
const STABLE_POLLS = 2;
const CEILING_MAX_MS = 15_000;
const CEILING_GROWTH = 1.5;

/**
 * The working ceiling, grown when this platform proves it needs longer.
 *
 * Only ever grows, and only on a real timeout. That is safe because the ceiling
 * bounds the *worst* case, not the wait: settle() returns the moment the page
 * is quiet, so a high ceiling costs a fast platform nothing. Growing on failure
 * rather than fitting a percentile to successes matters — successes are
 * right-censored by the current ceiling, so a too-low ceiling would never
 * observe the evidence that it is too low, and could never correct itself.
 */
let ceiling = TIMEOUT_MS;
export const settleCeiling = (): number => ceiling;
export const resetSettleCeiling = (): void => { ceiling = TIMEOUT_MS; };

/** The hash is over the compact view, which is what downstream actually reads. */
async function axPoll(): Promise<{ hash: string; inflight: number }> {
  const { nodes } = await send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree');
  const { compact } = compactFrom(nodes, new Map());
  return { hash: compact.map((c) => `${c.ref}${sig(c)}`).join('\n'), inflight: inflight() };
}

/**
 * Wait until the page stops changing, then let the caller read it.
 *
 * Two signals, both generic: the accessibility tree unchanged across a quiet
 * window, and no requests in flight. A fixed sleep is the ceiling, not the
 * mechanism — `timeoutMs` bounds the wait and returns `quiet: false` rather
 * than throwing, because "acted on a page that never went quiet" is a fact the
 * ledger should carry, not an error that aborts a run.
 *
 * `poll` is injectable so the loop is testable in Node with a scripted sequence.
 *
 * Chosen over a page-injected MutationObserver: injection needs
 * Runtime.evaluate, and the agent reads the page — it does not execute in it.
 */
export async function settle(
  opts: { quietMs?: number; timeoutMs?: number } = {},
  poll: () => Promise<{ hash: string; inflight: number }> = axPoll,
): Promise<Settled> {
  const quietMs = opts.quietMs ?? QUIET_MS;
  // An explicit budget is honoured as given and never feeds the backoff, so a
  // caller (and every test) stays deterministic.
  const pinned = opts.timeoutMs !== undefined;
  const timeoutMs = opts.timeoutMs ?? ceiling;
  const t0 = Date.now();
  let prev: string | null = null;
  let stableSince = 0;
  let stableCount = 0;
  let polls = 0;
  let inflightNow = 0;
  let last = t0;
  let maxGapMs = 0;

  for (;;) {
    const r = await poll();
    polls++;
    inflightNow = r.inflight;
    const now = Date.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;

    if (r.hash === prev && r.inflight === 0) {
      if (stableSince === 0) stableSince = now;
      stableCount++;
      // Two conditions, not one. Wall-clock alone is not enough: fetching the
      // full AX tree slows under memory pressure, so two samples can match
      // simply because we sampled too coarsely to see the churn between them.
      // Requiring consecutive stable samples makes a starved sampler report
      // "not quiet" rather than a confident false positive.
      if (stableCount >= STABLE_POLLS && now - stableSince >= quietMs) {
        return { quiet: true, polls, ms: now - t0, inflight: 0, maxGapMs, ceilingMs: timeoutMs };
      }
    } else {
      stableSince = 0;
      stableCount = 0;
      prev = r.hash;
    }

    if (now - t0 >= timeoutMs) {
      // Grow the ceiling on the evidence that it was too small. Never shrink:
      // the cost of a high ceiling on a fast page is zero.
      if (!pinned) ceiling = Math.min(Math.round(ceiling * CEILING_GROWTH), CEILING_MAX_MS);
      return { quiet: false, polls, ms: now - t0, inflight: inflightNow, maxGapMs, ceilingMs: timeoutMs };
    }
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
}
