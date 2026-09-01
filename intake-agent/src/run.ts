/**
 * The loop, the ledger, and the guarantee.
 *
 * Every plan item ends in exactly one of two states — built and verified, or
 * escalated with full context. Never a third, silent state where the agent
 * moved on without either. assertTerminated() enforces that rather than
 * claiming it: a missed field nobody notices is the most heavily penalised
 * failure in the brief.
 */
import {
  apply, dismiss, ensureContext, home, locate, candidates, screenNames,
  type Descriptor, type Read, type Step, type StepResult,
} from './act.ts';
import { normName, type Snapshot } from './perceive.ts';
import {
  askModel, commitCandidates, discoverLibrary, newFacts, resolveType, V,
  type Facts, type Source,
} from './resolve.ts';
import {
  contextOf, planItems, stats, type Field, type IR, type PlanItem,
} from './ir.ts';

export const MAX_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Ledger — two-phase, so an interrupted item is distinguishable from an
// untouched one. That distinction is the frontier, and the frontier is what a
// same-session rerun has to re-verify before trusting anything else.
// ---------------------------------------------------------------------------

export type LedgerState = 'in-flight' | 'built' | 'reused' | 'escalated';

export type LedgerRecord = {
  item: string;
  began: number;
  state: LedgerState;
  attempts: number;
  source?: Source | 'verified-existing';
  confidence?: number;
  decision?: string;
  readback?: string;
  settled?: boolean;
  signature?: string;
  history: string[];
};

export class Ledger {
  private rows = new Map<string, LedgerRecord>();

  begin(item: PlanItem): void {
    const prev = this.rows.get(item.id);
    this.rows.set(item.id, {
      item: item.id,
      began: Date.now(),
      state: 'in-flight',
      attempts: (prev?.attempts ?? 0) + 1,
      history: prev?.history ?? [],
    });
  }

  private close(item: PlanItem, patch: Partial<LedgerRecord> & { state: LedgerState }): void {
    const prev = this.rows.get(item.id);
    this.rows.set(item.id, {
      item: item.id,
      began: prev?.began ?? Date.now(),
      attempts: prev?.attempts ?? 1,
      history: prev?.history ?? [],
      ...patch,
    });
  }

  built(item: PlanItem, d: Partial<LedgerRecord>): void { this.close(item, { ...d, state: 'built' }); }
  reused(item: PlanItem, from: string): void { this.close(item, { state: 'reused', decision: `copied from ${from}` }); }
  escalated(item: PlanItem, signature: string): void { this.close(item, { state: 'escalated', signature }); }

  note(item: PlanItem, line: string): void {
    const r = this.rows.get(item.id);
    if (r) r.history.push(line);
  }

  get(id: string): LedgerRecord | undefined { return this.rows.get(id); }
  all(): LedgerRecord[] { return [...this.rows.values()]; }

  /**
   * The one item left in-flight: writes started, verify() never completed. At
   * most one, because the loop is sequential. Identified by its STATE, never by
   * its position — escalation leaves holes, so a built record at index 40 is
   * exactly as trustworthy as one at index 2.
   */
  frontier(): LedgerRecord | undefined { return this.all().find((r) => r.state === 'in-flight'); }

  counts() {
    const by = (s: LedgerState) => this.all().filter((r) => r.state === s).length;
    return { built: by('built'), reused: by('reused'), escalated: by('escalated'), inFlight: by('in-flight') };
  }
}

/** The guarantee, checked rather than asserted in prose. */
export function assertTerminated(ledger: Ledger, plan: PlanItem[]): { ok: boolean; unaccounted: string[] } {
  const done = new Set(ledger.all().filter((r) => r.state !== 'in-flight').map((r) => r.item));
  const unaccounted = plan.filter((p) => !done.has(p.id)).map((p) => p.id);
  return { ok: unaccounted.length === 0, unaccounted };
}

// ---------------------------------------------------------------------------
// The gate queue — keyed by the question, not by the item
// ---------------------------------------------------------------------------

export type GateItem = {
  signature: string;
  question: string;
  items: string[];
  tried: string[];
  /** Answers are chosen from the live page, never typed. */
  choices: { ref: number; name: string }[];
  answered?: { value: string; descriptor?: Descriptor };
};

export type Queue = Map<string, GateItem>;

export function escalate(q: Queue, signature: string, question: string, item: PlanItem, tried: string[], choices: GateItem['choices'] = []): void {
  const card = q.get(signature);
  if (card) {
    if (!card.items.includes(item.id)) card.items.push(item.id);
    for (const t of tried) if (!card.tried.includes(t)) card.tried.push(t);
    if (choices.length && card.choices.length === 0) card.choices = choices;
    return;
  }
  q.set(signature, { signature, question, items: [item.id], tried, choices });
}

// ---------------------------------------------------------------------------
// Session — the side panel document's lifetime. sw.ts holds no state and
// deliberately never will, so MV3 worker eviction is not a concern here.
// ---------------------------------------------------------------------------

export type Session = {
  id: string;
  tabId: number;
  url: string;
  study: string;
  facts: Facts;
  ledger: Ledger;
  queue: Queue;
  llmCalls: number;
};

export function newSession(tabId: number, url: string, ir: IR): Session {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? String(Date.now()),
    tabId,
    url,
    study: ir.study.protocol_id,
    facts: newFacts(),
    ledger: new Ledger(),
    queue: new Map(),
    llmCalls: 0,
  };
}

// ---------------------------------------------------------------------------
// Identity — the one place the agent refuses before doing any work
// ---------------------------------------------------------------------------

export type Identity =
  | { ok: true; matched: 'protocol_id' | 'title' | 'human' }
  | { ok: false; reason: 'different-study'; saw: string }
  | { ok: 'unconfirmed'; reason: 'no-anchor' };

const STUDY_WORDS = ['study', 'protocol', 'trial'];

/**
 * Three outcomes, and the difference between the last two is the whole point.
 *
 * Absent is not the same as wrong. A platform that never names the study in its
 * accessible tree would, under a two-state check, refuse to run at all — a
 * structural failure dressed up as a safety check. So "no anchor" is
 * unconfirmed: one gate card, the operator confirms once, and the run proceeds.
 * A page naming a DIFFERENT study still refuses, always.
 */
export function identify(snap: Snapshot, ir: IR): Identity {
  const wanted = [ir.study.protocol_id, ir.study.title].map(normName).filter(Boolean);
  const names = snap.compact
    .filter((c) => ['heading', 'banner', 'main', 'navigation', 'statictext', 'paragraph'].includes(c.role))
    .map((c) => normName(c.name))
    .filter(Boolean);

  for (const n of names) {
    if (n.includes(wanted[0])) return { ok: true, matched: 'protocol_id' };
  }
  for (const n of names) {
    if (wanted[1] && n.includes(wanted[1])) return { ok: true, matched: 'title' };
  }

  // Is some *other* study named here? Only then is this a hard stop.
  for (const c of snap.compact) {
    const n = normName(c.name);
    if (!n || !STUDY_WORDS.some((w) => n.includes(w))) continue;
    const rest = n.replace(new RegExp(STUDY_WORDS.join('|'), 'g'), '').trim();
    if (rest.length >= 3 && !wanted.some((w) => rest.includes(w) || w.includes(rest))) {
      return { ok: false, reason: 'different-study', saw: c.name! };
    }
  }
  return { ok: 'unconfirmed', reason: 'no-anchor' };
}

// ---------------------------------------------------------------------------
// Liveness — is the session still describing this page?
// ---------------------------------------------------------------------------

export type Liveness = { live: true } | { live: false; reason: string };

export function liveness(s: Session, snap: Snapshot, ir: IR, tabId: number): Liveness {
  if (s.ledger.all().every((r) => r.state === 'in-flight')) return { live: false, reason: 'no-ledger' };
  if (s.tabId !== tabId) return { live: false, reason: 'tab-changed' };

  // The identity check is the only skippable one. On a platform with no study
  // anchor it can never pass, and treating that as a session boundary would
  // silently disable the fast path everywhere — the optimisation switching
  // itself off for a structural reason while reporting it as a real boundary.
  if (s.facts.get('study.anchor')?.value !== 'absent') {
    const id = identify(snap, ir);
    if (id.ok === false) return { live: false, reason: `page-changed: ${id.saw}` };
  }

  const front = s.ledger.frontier();
  if (front) {
    const ctx = front.item.split('/')[0];
    if (ctx && !screenNames(snap, ctx)) return { live: false, reason: 'frontier-lost' };
  }
  return { live: true };
}

// ---------------------------------------------------------------------------
// verify — the deliverable, checked against the input file
// ---------------------------------------------------------------------------

export type Verdict = { ok: true } | { ok: false; missing: string[]; signature: string };

/**
 * Nodes around a named one. Generic stand-in for "the part of the screen this
 * field occupies": platforms differ wildly in structure but keep a field's
 * label, type and settings adjacent in the accessibility tree.
 */
function around(snap: Snapshot, name: string, span = 30): string {
  const i = snap.compact.findIndex((c) => normName(c.name) === normName(name));
  if (i === -1) return '';
  const lo = Math.max(0, i - 4);
  const text = snap.compact
    .slice(lo, i + span)
    .map((c) => `${normName(c.name)} | ${normName(c.value)} | ${(c.state ?? []).join(' ').toLowerCase()}`)
    .join(' | ');
  return ` ${text} `;
}

const named = (snap: Snapshot, name: string) =>
  snap.compact.some((c) => normName(c.name) === normName(name));

/**
 * Whole-token, never substring. A coded value of "M" is inside "Male", so a
 * substring check would report the codes present on a list that carries only
 * labels — passing the exact failure this verification exists to catch. The
 * same trap sits in ranges: 30 is inside 300.
 */
const has = (hay: string, needle: string) => {
  const n = normName(needle);
  return n !== '' && hay.includes(` ${n} `);
};

/**
 * Presence is never sufficient — this is what "already exists" has to survive
 * before an item counts as done, on a rerun or a first run alike.
 *
 * Three rules make it worth running: an element that exists but was never named
 * is a failure; option lists compare pairwise rather than by count, because a
 * bulk paste that dropped the codes still has the right length; and a reused
 * form verifies exactly like a built one.
 */
export function verify(snap: Snapshot, item: PlanItem, facts: Facts): Verdict {
  const missing: string[] = [];
  const fail = (sig: string): Verdict => ({ ok: false, missing, signature: sig });

  if (item.kind === 'visit') {
    if (!named(snap, item.visit.name)) { missing.push(`no element named "${item.visit.name}"`); return fail(`unbuilt:visit`); }
    const ctx = around(snap, item.visit.name);
    for (const d of [item.visit.window_start_day, item.visit.window_end_day]) {
      if (!has(ctx, String(d))) missing.push(`visit window day ${d} not shown`);
    }
    return missing.length ? fail('visit.window') : { ok: true };
  }

  if (item.kind === 'form') {
    if (!named(snap, item.form.name)) { missing.push(`no element named "${item.form.name}"`); return fail('unbuilt:form'); }
    const ctx = around(snap, item.form.name, 60);
    if (item.form.repeating && !V.repeating.some((w) => has(ctx, w))) {
      missing.push('form is repeating in the IR and nothing on screen says so');
      return fail('form.repeating');
    }
    return { ok: true };
  }

  const f: Field = item.field;
  // An element that exists but was never named is structurally present and
  // semantically worthless. The label check is not optional.
  if (!named(snap, f.label)) { missing.push(`no element named "${f.label}"`); return fail('unbuilt:field'); }

  const ctx = around(snap, f.label);
  const typeLabel = facts.get(`type:${f.type}`)?.value;
  if (typeLabel && !has(ctx, typeLabel)) missing.push(`type "${typeLabel}" not shown on the field`);
  if (f.required && !V.required.some((w) => has(ctx, w))) missing.push('required flag not shown');

  // Pairs, not counts: a list carrying only labels stores the wrong thing.
  for (const o of f.options ?? []) {
    if (!has(ctx, o.code)) missing.push(`option code "${o.code}" missing`);
    if (!has(ctx, o.label)) missing.push(`option label "${o.label}" missing`);
  }
  for (const [k, v] of [['min', f.min], ['max', f.max], ['units', f.units]] as const) {
    if (v !== undefined && !has(ctx, String(v))) missing.push(`${k} ${v} missing`);
  }
  if (f.skip_logic) {
    if (!has(ctx, f.skip_logic.when_field_label)) missing.push(`skip-logic controller "${f.skip_logic.when_field_label}" not wired`);
    if (!has(ctx, f.skip_logic.equals_value)) missing.push(`skip-logic value "${f.skip_logic.equals_value}" not wired`);
  }

  if (missing.length === 0) return { ok: true };
  if (f.options?.length && missing.some((m) => m.startsWith('option'))) return fail('field.options');
  if (f.skip_logic && missing.some((m) => m.startsWith('skip'))) return fail('field.skiplogic');
  if (missing.some((m) => m.startsWith('min') || m.startsWith('max') || m.startsWith('units'))) return fail('field.range');
  return fail(`field.detail:${f.type}`);
}

// ---------------------------------------------------------------------------
// Status — derived on every render, never stored, so it cannot drift
// ---------------------------------------------------------------------------

export type Status = 'complete' | 'in-progress' | 'escalated' | 'not-reached';
export type StatusNode = { id: string; label: string; status: Status; children: StatusNode[] };

const rollUp = (kids: Status[], self: Status): Status => {
  if (kids.some((k) => k === 'escalated') || self === 'escalated') return 'escalated';
  if (kids.some((k) => k === 'in-progress') || self === 'in-progress') return 'in-progress';
  if (kids.length && kids.every((k) => k === 'complete') && self === 'complete') return 'complete';
  if (!kids.length) return self;
  if (kids.some((k) => k === 'complete') || self === 'complete') return 'in-progress';
  return 'not-reached';
};

const statusOf = (l: Ledger, id: string): Status => {
  const r = l.get(id);
  if (!r) return 'not-reached';
  if (r.state === 'built' || r.state === 'reused') return 'complete';
  if (r.state === 'escalated') return 'escalated';
  return 'in-progress';
};

export function statusTree(ir: IR, ledger: Ledger): StatusNode[] {
  return ir.visits.map((v) => {
    const forms = v.forms.map((f) => {
      const fields = f.fields.map((fl) => ({
        id: `${v.name}/${f.name}/${fl.label}`,
        label: fl.label,
        status: statusOf(ledger, `${v.name}/${f.name}/${fl.label}`),
        children: [],
      }));
      return {
        id: `${v.name}/${f.name}`,
        label: f.name,
        status: rollUp(fields.map((x) => x.status), statusOf(ledger, `${v.name}/${f.name}`)),
        children: fields,
      };
    });
    return {
      id: v.name,
      label: v.name,
      status: rollUp(forms.map((x) => x.status), statusOf(ledger, v.name)),
      children: forms,
    };
  });
}

// ---------------------------------------------------------------------------
// Turning one plan item into writes
//
// Built in two phases because a designer's editor does not exist until the add
// control is clicked: phase 1 opens it, then the steps are planned against the
// screen that actually appeared. Planning both phases up front would be
// guessing at controls nobody has seen.
// ---------------------------------------------------------------------------

const TEXTISH = ['textbox', 'searchbox', 'spinbutton', 'textfield', 'combobox'];

function findAdd(snap: Snapshot, specific: readonly string[]): Descriptor | null {
  for (const words of [specific, V.addAny]) {
    for (const role of ['button', 'link', 'menuitem']) {
      if (locate(snap, { role, nameAny: words }) !== null) return { role, nameAny: words };
    }
  }
  return null;
}

/** Set a value into whichever control the platform uses for `words`. */
function fieldStep(snap: Snapshot, words: readonly string[], value: string, why: string): Step | null {
  for (const role of TEXTISH) {
    if (locate(snap, { role, nameAny: words }) !== null) {
      return { target: { role, nameAny: words }, op: 'type', arg: value, expect: { kind: 'value', expect: value }, why };
    }
  }
  return null;
}

/**
 * The type step, whose shape depends on the platform: a dropdown of element
 * types, or a palette of library entries you click. Both are discovered, not
 * assumed.
 */
function typeStep(snap: Snapshot, typeLabel: string, why: string): Step | null {
  for (const role of ['combobox', 'listbox', 'menu']) {
    if (locate(snap, { role, nameAny: V.type }) !== null) {
      return { target: { role, nameAny: V.type }, op: 'choose', arg: typeLabel, expect: { kind: 'value', expect: typeLabel }, why };
    }
  }
  for (const role of ['button', 'option', 'listitem', 'menuitem', 'cell', 'treeitem', 'link']) {
    if (locate(snap, { role, name: typeLabel }) !== null) {
      return { target: { role, name: typeLabel }, op: 'click', expect: { kind: 'changed' }, why };
    }
  }
  return null;
}

/**
 * Which control actually persists. Never decided by name alone — "Save" and
 * "Save As Template" sit next to each other and look alike, which is the point.
 * Decoys rank last, and the fact is only cached once read-back confirms the
 * page actually moved.
 */
function commitStep(snap: Snapshot, facts: Facts, why: string): Step | null {
  const known = facts.get('commit');
  if (known?.descriptor && locate(snap, known.descriptor) !== null) {
    return { target: known.descriptor, op: 'click', expect: { kind: 'changed' }, why };
  }
  const best = commitCandidates(snap)[0];
  if (!best) return null;
  return { target: { role: 'button', name: best.name }, op: 'click', expect: { kind: 'changed' }, why };
}

/**
 * Build order inside a field: type first, then everything the type governs.
 * Platforms discard silently what the current type cannot hold when the type
 * changes, so a range set before the type is a range that quietly vanishes.
 */
function fieldSteps(snap: Snapshot, item: Extract<PlanItem, { kind: 'field' }>, typeLabel: string): Step[] {
  const f = item.field;
  const why = item.id;
  const steps: Step[] = [];
  const push = (s: Step | null) => { if (s) steps.push(s); };

  push(typeStep(snap, typeLabel, why));
  push(fieldStep(snap, V.label, f.label, why));

  if (f.required) {
    const req = locate(snap, { role: 'checkbox', nameAny: V.required }) ?? locate(snap, { role: 'switch', nameAny: V.required });
    if (req !== null) {
      steps.push({ target: { role: 'checkbox', nameAny: V.required }, op: 'check', arg: 'true', expect: { kind: 'checked', expect: true }, why });
    }
  }

  // Coded values are pairs. Per-row entry appends; bulk paste tends to replace,
  // and a list carrying only labels stores the wrong thing.
  for (const o of f.options ?? []) {
    const add = findAdd(snap, V.addOption);
    if (add) steps.push({ target: add, op: 'click', expect: { kind: 'changed' }, why });
    steps.push({ target: { role: 'textbox', nameAny: V.optionCode, nth: -1 }, op: 'type', arg: o.code, expect: { kind: 'value', expect: o.code }, why });
    steps.push({ target: { role: 'textbox', nameAny: V.optionLabel, nth: -1 }, op: 'type', arg: o.label, expect: { kind: 'value', expect: o.label }, why });
  }

  if (f.min !== undefined) push(fieldStep(snap, V.min, String(f.min), why));
  if (f.max !== undefined) push(fieldStep(snap, V.max, String(f.max), why));
  if (f.units) push(fieldStep(snap, V.units, f.units, why));
  if (f.formula) push(fieldStep(snap, V.formula, f.formula, why));
  if (f.skip_logic) {
    push(fieldStep(snap, V.skip, `${f.skip_logic.when_field_label} = ${f.skip_logic.equals_value}`, why));
  }
  return steps;
}

function visitSteps(snap: Snapshot, item: Extract<PlanItem, { kind: 'visit' }>): Step[] {
  const steps: Step[] = [];
  const why = item.id;
  const name = fieldStep(snap, V.label, item.visit.name, why);
  if (name) steps.push(name);
  const s = fieldStep(snap, V.min, String(item.visit.window_start_day), why);
  const e = fieldStep(snap, V.max, String(item.visit.window_end_day), why);
  if (s) steps.push(s);
  if (e) steps.push(e);
  return steps;
}

function formSteps(snap: Snapshot, item: Extract<PlanItem, { kind: 'form' }>): Step[] {
  const steps: Step[] = [];
  const why = item.id;
  const name = fieldStep(snap, V.label, item.form.name, why);
  if (name) steps.push(name);
  if (item.form.repeating) {
    const rep = locate(snap, { role: 'checkbox', nameAny: V.repeating }) ?? locate(snap, { role: 'switch', nameAny: V.repeating });
    if (rep !== null) {
      steps.push({ target: { role: 'checkbox', nameAny: V.repeating }, op: 'check', arg: 'true', expect: { kind: 'checked', expect: true }, why });
    }
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Layer 1/2 — the element library and the type map, learned once per platform
// ---------------------------------------------------------------------------

function irLabels(ir: IR): Set<string> {
  const out = new Set<string>();
  for (const v of ir.visits) {
    out.add(normName(v.name));
    for (const f of v.forms) {
      out.add(normName(f.name));
      for (const fl of f.fields) out.add(normName(fl.label));
    }
  }
  return out;
}

function ensureLibrary(s: Session, snap: Snapshot, ir: IR): string[] | null {
  const known = s.facts.get('library');
  if (known) return known.value === 'absent' ? null : JSON.parse(known.value);
  const found = discoverLibrary(snap, irLabels(ir));
  if (!found) return null; // not on this screen; try again once the designer is open
  s.facts.set('library', { value: JSON.stringify(found.labels), source: 'discovered' });
  return found.labels;
}

/** 195 fields ask 13 questions. This is where that reduction happens. */
function ensureType(s: Session, canonical: Field['type'], library: string[]): { label: string } | { abstain: string } {
  const key = `type:${canonical}`;
  const known = s.facts.get(key);
  if (known) return known.value === 'absent' ? { abstain: known.why ?? 'unresolved' } : { label: known.value };

  const r = resolveType(canonical, library);
  if ('label' in r) {
    s.facts.set(key, { value: r.label, source: 'synonym', descriptor: { name: r.label } });
    return r;
  }
  return r; // not cached as absent: a later screen may show a fuller library
}

/**
 * Layer 3 — the model, for what the synonym pass would not answer.
 *
 * Asked once per unresolved *type*, not once per field, because the answer is
 * cached as a platform fact: the 40 single-selects in the study share one
 * question. That bounds a full run at 13 type calls plus a handful of control
 * questions, which is the same ceiling batching-per-form was aiming at, with
 * less machinery.
 *
 * The answer is still untrusted — validate() has already rejected a
 * hallucinated ref and anything under the confidence threshold before it
 * arrives here.
 */
async function askType(s: Session, snap: Snapshot, canonical: Field['type'], library: string[]): Promise<{ label: string } | null> {
  const key = `type:${canonical}`;
  if (s.facts.get(`asked:${key}`)) return null; // one call per question per session
  s.facts.set(`asked:${key}`, { value: 'yes', source: 'llm' });

  try {
    s.llmCalls++;
    const { ok } = await askModel(
      snap,
      [{ key, ask: `Which element in this platform's library means the canonical type "${canonical}"? Library entries seen: ${library.join(', ')}` }],
      s.facts,
    );
    const d = ok.find((x) => x.key === key);
    if (!d) return null;
    s.facts.set(key, { value: d.label, source: 'llm', confidence: d.confidence, why: d.why, descriptor: { name: d.label } });
    return { label: d.label };
  } catch {
    return null; // no key, a rate limit, a timeout — all escalate to the human
  }
}

// ---------------------------------------------------------------------------
// Building one item
// ---------------------------------------------------------------------------

type BuildOut = { snap: Snapshot; ok: boolean; escalate?: { sig: string; q: string; choices: GateItem['choices'] }; tried: string[] };

const choicesFrom = (snap: Snapshot, roles: string[]) =>
  snap.compact.filter((c) => roles.includes(c.role) && c.name).slice(0, 40).map((c) => ({ ref: c.ref, name: c.name! }));

async function buildItem(s: Session, item: PlanItem, snap: Snapshot, read: Read, ir: IR): Promise<BuildOut> {
  const tried: string[] = [];
  const words = item.kind === 'visit' ? V.addVisit : item.kind === 'form' ? V.addForm : V.addField;

  // Phase 1 — open the editor. Nothing beyond this point can be planned until
  // we have seen the screen the add control produced.
  const add = findAdd(snap, words);
  if (!add) {
    return {
      snap, ok: false, tried: ['looked for an add control by role and vocabulary'],
      escalate: { sig: `add:${item.kind}`, q: `Which control adds a ${item.kind} on this platform?`, choices: choicesFrom(snap, ['button', 'link', 'menuitem']) },
    };
  }
  tried.push(`clicked the add control matching ${JSON.stringify(words[0])}`);
  const opened = await apply(snap, read, [{ target: add, op: 'click', expect: { kind: 'changed' }, why: item.id }]);
  if (!opened.ok) {
    return { snap: opened.snap, ok: false, tried: [...tried, opened.results.at(-1)?.reason ?? 'the add control did nothing'],
      escalate: { sig: `add:${item.kind}`, q: `Which control adds a ${item.kind} on this platform?`, choices: choicesFrom(opened.snap, ['button', 'link', 'menuitem']) } };
  }
  let cur = opened.snap;

  // Phase 2 — plan against the editor that actually appeared.
  let steps: Step[];
  if (item.kind === 'visit') steps = visitSteps(cur, item);
  else if (item.kind === 'form') steps = formSteps(cur, item);
  else {
    const library = ensureLibrary(s, cur, ir) ?? [];
    let t = library.length ? ensureType(s, item.field.type, library) : { abstain: 'no element library found on this screen' };
    if ('abstain' in t && library.length) {
      tried.push(`layer 1 abstained: ${t.abstain}`);
      t = (await askType(s, cur, item.field.type, library)) ?? t; // layer 3
    }
    if ('abstain' in t) {
      return { snap: cur, ok: false, tried: [...tried, t.abstain],
        escalate: { sig: `type:${item.field.type}`, q: `What does this platform call a ${item.field.type}?`,
                    choices: library.length ? library.slice(0, 40).map((n) => ({ ref: locate(cur, { name: n }) ?? -1, name: n }))
                                            : choicesFrom(cur, ['button', 'option', 'listitem', 'menuitem', 'cell']) } };
    }
    steps = fieldSteps(cur, item, t.label);
  }

  if (steps.length === 0) {
    return { snap: cur, ok: false, tried: [...tried, 'the editor showed no control matching the designer vocabulary'],
      escalate: { sig: `editor:${item.kind}`, q: `Which control sets the name of a ${item.kind} here?`, choices: choicesFrom(cur, TEXTISH) } };
  }

  const done = await apply(cur, read, steps);
  cur = done.snap;
  for (const r of done.results) if (!r.ok) tried.push(`${r.step.op} ${JSON.stringify(r.step.arg ?? '')}: ${r.reason}`);
  if (!done.ok) {
    const err = done.results.find((r) => r.errors.length)?.errors[0];
    return { snap: cur, ok: false, tried,
      escalate: err ? { sig: `rejected:${item.kind}`, q: `The platform rejected this: "${err.text}". What should happen?`, choices: [] }
                    : { sig: `write:${item.kind}`, q: `A write did not take on this platform. Which control is right?`, choices: choicesFrom(cur, TEXTISH) } };
  }

  // Saving is explicit, and reaching a screen is not building.
  const commit = commitStep(cur, s.facts, item.id);
  if (commit) {
    const saved = await apply(cur, read, [commit]);
    cur = saved.snap;
    if (saved.ok && !s.facts.has('commit')) {
      s.facts.set('commit', { value: String(commit.target.name ?? ''), descriptor: commit.target, source: 'discovered' });
    }
    if (!saved.ok) tried.push(`commit via ${JSON.stringify(commit.target.name)}: ${saved.results.at(-1)?.reason}`);
  }
  return { snap: cur, ok: true, tried };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export type RunResult = {
  built: number; reused: number; escalated: number;
  unaccounted: string[]; llmCalls: number; ms: number; ok: boolean; resumed: boolean;
};

export type RunOpts = {
  onProgress?: (done: number, total: number, item: PlanItem) => void;
  shouldStop?: () => boolean;
  tabId: number;
};

export async function run(s: Session, ir: IR, read: Read, opts: RunOpts): Promise<RunResult> {
  const t0 = Date.now();
  const plan = planItems(ir);
  let snap = await read();

  // Identity, before anything is written. A *different* study is the only
  // outcome that refuses outright.
  const id = identify(snap, ir);
  if (id.ok === false) {
    for (const item of plan) s.ledger.escalated(item, 'identity');
    escalate(s.queue, 'identity', `This platform is showing "${id.saw}", not ${ir.study.protocol_id}. Build here anyway?`, plan[0], ['read the study name from the page'], []);
    return { ...tally(s, plan), ms: Date.now() - t0, llmCalls: s.llmCalls, resumed: false };
  }
  if (id.ok === 'unconfirmed' && !s.facts.has('study.anchor')) {
    escalate(s.queue, 'study.anchor', `I cannot tell which study this platform is showing. Is this the right place to build ${ir.study.protocol_id}?`, plan[0], ['looked for the protocol id and title in headings and landmarks'], []);
    s.facts.set('study.anchor', { value: 'absent', source: 'discovered', why: 'no study identifier in the accessible tree' });
  }

  const live = liveness(s, snap, ir, opts.tabId);
  if (!live.live) snap = await home(snap, read, [ir.study.protocol_id, ir.study.title]);

  let done = 0;
  for (const item of plan) {
    done++;
    opts.onProgress?.(done, plan.length, item);
    if (opts.shouldStop?.()) break;

    const rec = s.ledger.get(item.id);
    // A built record is trusted wherever it sits — escalation leaves holes, so
    // position tells you nothing. The frontier is the in-flight record, if any.
    if (live.live && rec && (rec.state === 'built' || rec.state === 'reused')) continue;
    if (live.live && rec?.state === 'escalated') {
      const card = rec.signature ? s.queue.get(rec.signature) : undefined;
      if (card && !card.answered) continue; // still unanswered: re-surface, do no work
    }

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const ctx = await ensureContext(snap, read, contextOf(item));
      snap = ctx.snap;
      if ('escalate' in ctx) {
        s.ledger.escalated(item, ctx.escalate);
        escalate(s.queue, ctx.escalate, `How does this platform open "${ctx.escalate.slice(8)}"?`, item, ['clicked every control carrying that name'], choicesFrom(snap, ['link', 'tab', 'button', 'row', 'listitem', 'cell']));
        break;
      }

      // Presence is never sufficient. This is the same verify() used after a
      // build, so an item that merely looks present still has to prove it.
      const pre = verify(snap, item, s.facts);
      if (pre.ok) { s.ledger.built(item, { source: 'verified-existing', settled: snap.settled.quiet }); break; }

      s.ledger.begin(item);
      const out = await buildItem(s, item, snap, read, ir);
      snap = out.snap;
      for (const line of out.tried) s.ledger.note(item, line);

      if (out.escalate) {
        s.ledger.escalated(item, out.escalate.sig);
        escalate(s.queue, out.escalate.sig, out.escalate.q, item, out.tried, out.escalate.choices);
        snap = await dismiss(snap, read); // never leave a modal for the next item
        break;
      }

      const post = verify(snap, item, s.facts);
      if (post.ok) {
        s.ledger.built(item, { source: 'synonym', settled: snap.settled.quiet, decision: out.tried.at(-1) });
        break;
      }
      s.ledger.note(item, `verify failed: ${post.missing.join('; ')}`);
      if (attempt === MAX_ATTEMPTS - 1) {
        s.ledger.escalated(item, post.signature);
        escalate(s.queue, post.signature, `Built "${item.id}" but it did not read back correctly. What is wrong?`, item, [...out.tried, ...post.missing], choicesFrom(snap, TEXTISH));
        snap = await dismiss(snap, read);
      }
    }

    if (!s.ledger.get(item.id) || s.ledger.get(item.id)!.state === 'in-flight') {
      s.ledger.escalated(item, `unverified:${item.id}`);
      escalate(s.queue, `unverified:${item.id}`, `"${item.id}" could not be completed.`, item, ['both attempts spent'], []);
    }
  }

  return { ...tally(s, plan), ms: Date.now() - t0, llmCalls: s.llmCalls, resumed: live.live };
}

function tally(s: Session, plan: PlanItem[]) {
  const c = s.ledger.counts();
  const t = assertTerminated(s.ledger, plan);
  return { built: c.built, reused: c.reused, escalated: c.escalated, unaccounted: t.unaccounted, ok: t.ok };
}

/** Counts the panel prints. Kept here so the UI never derives its own numbers. */
export const summary = (s: Session, ir: IR) => {
  const c = s.ledger.counts();
  const total = planItems(ir).length;
  return { ...c, total, expected: stats(ir), unaccounted: assertTerminated(s.ledger, planItems(ir)).unaccounted.length };
};
