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
  apply, dismiss, ensureContext, home, locate, candidates, optionsOf, screenNames,
  inDesigner, stepOut, isWayOut,
  type Descriptor, type Read, type Step,
} from './act.ts';
import { activeDialog, insideRole, normName, type Ref, type Snapshot } from './perceive.ts';
import {
  askModel, bestCanonical, commitCandidates, discoverLibrary, newFacts, reads, resolveType, score, V, COMMIT_WORDS,
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
  settleMs?: number;
  settleGapMs?: number;
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

/**
 * What a signature means, and whether a human picking a control can actually
 * settle it.
 *
 * 'choice' is exactly the set of signatures the loop reads back out of facts,
 * under the same key the card writes: type, add, commit and context. Offering
 * buttons on any other card would be worse than offering none — it would look
 * answered and change nothing on Resume — so everything else is a report, and
 * says plainly that the fix is on the platform.
 */
export function explain(signature: string): { kind: 'choice' | 'report'; reason: string } {
  const arg = signature.slice(signature.search(/[:.]/) + 1);

  if (signature.startsWith('type:')) {
    return { kind: 'choice', reason:
      `No entry in this platform's element library clearly means "${arg}" — either two scored the same or none did. `
      + `Neighbours like a multi-select and a single tick box look alike and store different things, so the agent refuses to pick. `
      + `Your answer is cached: every later ${arg} field reuses it.` };
  }
  if (signature.startsWith('add:')) {
    return { kind: 'choice', reason:
      `Nothing on that screen read as a control that adds a ${arg}, and the model would not commit to one either. `
      + `Pick the control that starts a new ${arg} and every later ${arg} uses it — the agent still clicks it through the same `
      + `read-back it applies to its own guesses, so a wrong pick fails loudly rather than building the wrong thing.` };
  }
  if (signature === 'commit') {
    return { kind: 'choice', reason:
      `The agent could not tell which control persists the work. Save and "Save as template" sit side by side on real designers, `
      + `and clicking the wrong one looks like success and stores nothing — so it stopped instead. `
      + `Pick the control that saves; it is cached for the rest of the run.` };
  }
  if (signature.startsWith('context:')) {
    return { kind: 'choice', reason:
      `The agent could not get to "${arg}". It clicked every control carrying that name and never arrived. `
      + `Pick the control that opens it — a tab, a row, a link — and the agent will use it for "${arg}" from then on.` };
  }

  const reports: Record<string, string> = {
    editor: `The editor opened but showed no control matching the designer vocabulary for a ${arg}'s name.`,
    write: `A write was dispatched but the value did not read back, so the agent will not claim it was built.`,
    rejected: `The platform itself refused the write and surfaced an error.`,
    unbuilt: `Nothing on the page carries this ${arg}'s name outside the box it was typed into, so it was never created — `
      + `a filled editor that was not saved reads exactly like this.`,
    unverified: `Both attempts were spent without a verified result.`,
    identity: `This platform appears to be showing a different study.`,
    'study': `No protocol id or title was found, so the agent cannot confirm this is the right place.`,
  };
  const fields: Record<string, string> = {
    'visit.window': `The visit exists but its day window did not read back as a pair.`,
    'form.repeating': `The form is repeating in the study file and nothing on screen says so.`,
    'field.options': `The coded values did not read back. Codes are checked in pairs with their labels, because a list carrying only labels stores the wrong thing.`,
    'field.range': `The range or units did not read back — often a type change silently discarded what the new type cannot hold.`,
    'field.skiplogic': `The skip-logic rule did not read back as wired.`,
    'field.required': `The study marks this field required and the platform's editor does not — either it has no such `
      + `control, or the one it has did not take. A required field collected as optional is a data-collection defect, `
      + `so it is raised rather than passed over.`,
  };

  const head = signature.split(/[:.]/)[0];
  return {
    kind: 'report',
    reason: fields[signature] ?? fields[`${head}.${arg}`] ?? reports[head]
      ?? `The agent stopped rather than guess. Signature: ${signature}.`,
  };
}

export function escalate(q: Queue, signature: string, question: string, item: PlanItem, tried: string[], choices: GateItem['choices'] = []): void {
  // A report card's answer is never read back, so it gets no buttons.
  const usable = explain(signature).kind === 'choice' ? choices : [];
  const card = q.get(signature);
  if (card) {
    if (!card.items.includes(item.id)) card.items.push(item.id);
    for (const t of tried) if (!card.tried.includes(t)) card.tried.push(t);
    if (usable.length && card.choices.length === 0) card.choices = usable;
    return;
  }
  q.set(signature, { signature, question, items: [item.id], tried, choices: usable });
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
  /** Injectable for tests, so the model layer can be exercised with no network. Defaults to the real askModel. */
  ask?: typeof askModel;
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
function sliceText(snap: Snapshot, from: number, span: number): string {
  const lo = Math.max(0, from - 4);
  const text = snap.compact
    .slice(lo, from + span)
    .map((c) => `${normName(c.name)} | ${normName(c.value)} | ${(c.state ?? []).join(' ').toLowerCase()}`)
    .join(' | ');
  return ` ${text} `;
}

function around(snap: Snapshot, name: string, span = 30): string {
  const i = snap.compact.findIndex((c) => normName(c.name) === normName(name));
  return i < 0 ? '' : sliceText(snap, i, span);
}

/**
 * Canvas neighbourhood plus the open inspector. Codes and min/max live on the
 * selected element's editor, which sits far from the card in the tree once
 * the page has more than a couple of fields.
 *
 * The inspector grows with the field it is editing — every coded value adds a
 * row of nodes — so the window is sized from the field rather than fixed. A
 * fixed one falls short on a long code list and reports the *last* code
 * missing while it is on screen, which is an escalation for nothing.
 */
function fieldCtx(snap: Snapshot, f: Field): string {
  const want = normName(f.label);
  // ponytail: nodes-per-row is a slack estimate, not a measurement. If a
  // platform spends more than a dozen nodes on one option row, widen it.
  const span = 55 + 12 * (f.options?.length ?? 0);
  let ctx = around(snap, f.label, 40);
  for (let i = 0; i < snap.compact.length; i++) {
    const c = snap.compact[i];
    if (normName(c.value) !== want) continue;
    ctx += sliceText(snap, i, span);
  }
  return ctx;
}

/**
 * Does anything on screen carry this name, *outside* a box someone is typing
 * into?
 *
 * An editor echoes its own draft: the text typed into "Visit name" shows up
 * again as a text node inside that box. Counting the echo means a form that was
 * filled and never saved verifies exactly like one that was — which is how a
 * run reported fourteen visits built while the platform held none. The name has
 * to appear somewhere the platform is *showing* it, not somewhere it is being
 * entered.
 */
const named = (snap: Snapshot, name: string) =>
  snap.compact.some((c) =>
    normName(c.name) === normName(name)
    && !TEXTISH.includes(c.role)
    && !insideRole(snap, c.ref, TEXTISH));

/**
 * Where the field editor is showing this field: the index of the box carrying
 * its name. -1 when the editor is showing something else, or nothing.
 */
const editing = (snap: Snapshot, label: string) =>
  snap.compact.findIndex((c) => normName(c.value) === normName(label));

/**
 * The coded values the editor currently holds for this field, read as sets
 * rather than out of a slice of page text.
 *
 * A code list has no bound on its length, so any fixed-size read of the page
 * can be outrun by a long enough one — that is a check reporting the last
 * code missing while it is on screen. This walks from the field's own name box
 * to the end of the editor and takes every row it finds, so the list's length
 * cannot outrun it. Null when the editor is not showing this field, or shows
 * its values somewhere other than in per-row boxes: the caller falls back to
 * reading the page text, which is all a read-only list ever offers.
 *
 * ponytail: assumes one field's editor is open at a time, which is what a
 * three-pane or modal designer gives you. A designer that inline-edits every
 * field at once needs a container boundary here, not a forward walk.
 */
function optionRows(snap: Snapshot, label: string): { codes: Set<string>; labels: Set<string> } | null {
  const start = editing(snap, label);
  if (start < 0) return null;
  const codes = new Set<string>();
  const labels = new Set<string>();
  for (const c of snap.compact.slice(start + 1)) {
    if (!TEXTISH.includes(c.role)) continue;
    if (reads(c.name, V.optionCode)) codes.add(normName(c.value));
    else if (reads(c.name, V.optionLabel)) labels.add(normName(c.value));
  }
  return codes.size ? { codes, labels } : null;
}

/**
 * Whether the editor's required flag is set for this field: true, false, or
 * null when this platform shows no such control at all.
 *
 * Read off the control's state, not off the word appearing somewhere nearby.
 * The word "Required" sits in the editor whether the box is ticked or not, so
 * searching the page text reports every field mandatory. Null is the honest
 * third answer — it escalates rather than passing, because a field the study
 * marks required and the platform does not is a data-collection defect.
 */
function requiredFlag(snap: Snapshot, label: string): boolean | null {
  const start = editing(snap, label);
  if (start < 0) return null;
  for (const c of snap.compact.slice(start + 1)) {
    if (c.role !== 'checkbox' && c.role !== 'switch') continue;
    if (!reads(c.name, V.required)) continue;
    return (c.state ?? []).some((s) => s.startsWith('checked') && !s.endsWith('false'));
  }
  return null;
}

/**
 * The rule as the editor actually holds it: what the controlling-field control
 * is set to, and what the comparison input contains.
 *
 * Read from control VALUES, never from surrounding page text. The controlling
 * field's label is sitting on the canvas a few nodes away, and a value like
 * "No" is a substring of half the words on any screen, so a text search
 * reports every rule wired whether it is or not — which is exactly how a study
 * shipped with no skip logic at all and nothing escalated.
 */
function skipWiring(snap: Snapshot, label: string): { controller: string; value: string } | null {
  const start = editing(snap, label);
  if (start < 0) return null;
  let controller = '';
  let value = '';
  for (const c of snap.compact.slice(start + 1)) {
    if (!controller && reads(c.name, V.skipWhen)) controller = normName(c.value);
    else if (!value && reads(c.name, V.skipValue)) value = normName(c.value);
  }
  return controller || value ? { controller, value } : null;
}

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
    const ctx = around(snap, item.visit.name, 8);
    const start = item.visit.window_start_day;
    const end = item.visit.window_end_day;
    const a = normName(String(start));
    const b = normName(String(end));
    const pair = ctx.includes(` ${a} to ${b} `);
    const both = a !== b && has(ctx, String(start)) && has(ctx, String(end));
    if (!pair && !both) {
      missing.push(`visit window day ${start} not shown`);
      if (start !== end) missing.push(`visit window day ${end} not shown`);
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

  const ctx = fieldCtx(snap, f);
  const typeLabel = facts.get(`type:${f.type}`)?.value;
  if (typeLabel && !has(ctx, typeLabel)) missing.push(`type "${typeLabel}" not shown on the field`);
  if (f.required) {
    const flag = requiredFlag(snap, f.label);
    if (flag === false) missing.push('the required flag is on the editor and is not set');
    else if (flag === null && !V.required.some((w) => has(ctx, w))) missing.push('nothing on this field says it is required');
  }

  // Pairs, not counts: a list carrying only labels stores the wrong thing.
  const rows = optionRows(snap, f.label);
  for (const o of f.options ?? []) {
    const code = rows ? rows.codes.has(normName(o.code)) : has(ctx, o.code);
    const label = rows ? rows.labels.has(normName(o.label)) : has(ctx, o.label);
    if (!code) missing.push(`option code "${o.code}" missing`);
    if (!label) missing.push(`option label "${o.label}" missing`);
  }
  for (const [k, v] of [['min', f.min], ['max', f.max], ['units', f.units]] as const) {
    if (v !== undefined && !has(ctx, String(v))) missing.push(`${k} ${v} missing`);
  }
  if (f.skip_logic) {
    const wired = skipWiring(snap, f.label);
    const same = (a: string, b: string) => a !== '' && a === normName(b);
    if (!wired || !same(wired.controller, f.skip_logic.when_field_label)) {
      missing.push(`skip-logic controller "${f.skip_logic.when_field_label}" not wired`);
    }
    if (!wired || !same(wired.value, f.skip_logic.equals_value)) {
      missing.push(`skip-logic value "${f.skip_logic.equals_value}" not wired`);
    }
  }

  if (missing.length === 0) return { ok: true };
  if (missing.some((m) => m.includes('required'))) return fail('field.required');
  if (f.options?.length && missing.some((m) => m.startsWith('option'))) return fail('field.options');
  if (f.skip_logic && missing.some((m) => m.startsWith('skip'))) return fail('field.skiplogic');
  if (missing.some((m) => m.startsWith('min') || m.startsWith('max') || m.startsWith('units'))) return fail('field.range');
  return fail(`field.detail:${f.type}`);
}

// ---------------------------------------------------------------------------
// Status — derived on every render, never stored, so it cannot drift
// ---------------------------------------------------------------------------

export type Status = 'complete' | 'in-progress' | 'escalated' | 'not-reached';
export type StatusNode = { id: string; label: string; status: Status; why?: string; children: StatusNode[] };

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
      const fields = f.fields.map((fl) => {
        const id = `${v.name}/${f.name}/${fl.label}`;
        const rec = ledger.get(id);
        return {
          id,
          label: fl.label,
          status: statusOf(ledger, id),
          why: rec?.state === 'escalated' ? rec.signature : undefined,
          children: [] as StatusNode[],
        };
      });
      const rec = ledger.get(`${v.name}/${f.name}`);
      return {
        id: `${v.name}/${f.name}`,
        label: f.name,
        status: rollUp(fields.map((x) => x.status), statusOf(ledger, `${v.name}/${f.name}`)),
        why: rec?.state === 'escalated' ? rec.signature : undefined,
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

const commitish = (name?: string) => reads(name, COMMIT_WORDS);

/** Site chrome, as the page itself declares it. Never where the work happens. */
const CHROME_REGIONS = new Set(['banner', 'navigation', 'contentinfo']);

/** Buttons, links and menu items the platform offers inside its content area. */
const localActions = (snap: Snapshot) =>
  snap.compact.filter((c) =>
    (c.role === 'button' || c.role === 'link' || c.role === 'menuitem')
    && !!c.name
    && !CHROME_REGIONS.has(c.region ?? '')
    && !(c.state ?? []).some((s) => s.startsWith('disabled')));

/**
 * @param structural whether the last-resort "the only action here" pass may
 *   fire. Off when the screen cannot possibly hold this control — a form
 *   designer never adds a visit, and letting the fallback pick *something*
 *   there is how a visit ends up built as a text field inside a form.
 */
function findAdd(snap: Snapshot, specific: readonly string[], structural = true): Descriptor | null {
  for (const role of ['button', 'link', 'menuitem']) {
    if (locate(snap, { role, nameAny: specific }) !== null) return { role, nameAny: specific };
  }
  // Every fallback below answers "which control adds *something* here", so
  // first rule out that the something is a different level of the hierarchy. A
  // screen listing a visit's forms offers "Add Source Record" and nothing else;
  // asked there for a control that adds a *visit*, both fallbacks would pick it
  // and the visit would be built as a form inside the visit before it.
  const otherLevels = [V.addVisit, V.addForm, V.addField].filter((v) => v !== specific);
  for (const words of otherLevels) {
    for (const role of ['button', 'link', 'menuitem']) {
      if (locate(snap, { role, nameAny: words }) !== null) return null;
    }
  }

  // Fallback is last-resort and must not click a commit control: "Create"
  // reads as add-ish and is the save button on many designers.
  for (const role of ['button', 'link', 'menuitem']) {
    const hits = candidates(snap, { role, nameAny: V.addAny }).filter((c) => !commitish(c.name));
    if (hits.length === 1) return { role, name: hits[0].name };
  }

  // Last resort, and the one that carries across vocabularies: a platform that
  // calls it "Define Assessment Point" or "Schedule Event" shares no word with
  // "Add Visit", but on a screen listing nothing yet it is still the only thing
  // in the content area you can press. Chrome is excluded by the page's own
  // landmarks rather than by a list of tab names, and a commit or a way out is
  // never an add. One candidate or nothing: two would be a guess, and the model
  // is asked next.
  if (!structural) return null;
  const only = localActions(snap).filter((c) => !commitish(c.name) && !isWayOut(c.name));
  return only.length === 1 ? { role: only[0].role, name: only[0].name } : null;
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
  // A tile named the type is an add. A type combobox is usually the inspector
  // of the field already selected — changing it mutates that field, and a
  // closed <select>'s options have no geometry, so choose() reports
  // "element not rendered". Prefer the tile. Skip `option`: those are the
  // un-rendered select entries.
  for (const role of ['button', 'listitem', 'menuitem', 'cell', 'treeitem', 'link']) {
    if (locate(snap, { role, name: typeLabel }) !== null) {
      return { target: { role, name: typeLabel }, op: 'click', expect: { kind: 'changed' }, why };
    }
  }
  for (const role of ['combobox', 'listbox', 'menu']) {
    if (locate(snap, { role, nameAny: V.type }) !== null) {
      return { target: { role, nameAny: V.type }, op: 'choose', arg: typeLabel, expect: { kind: 'value', expect: typeLabel }, why };
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
/**
 * @param appeared normalised names of the controls that showed up when the
 *   editor opened. The editor's own buttons, separated from the page behind it
 *   by what changed rather than by a list of words — "Up one level" and the add
 *   control that is still on screen are not candidates for Save, and no
 *   vocabulary reliably says so.
 */
function commitSteps(snap: Snapshot, facts: Facts, why: string, appeared?: Set<string>): { steps: Step[]; again?: string } {
  const one = (target: Descriptor) => ({ steps: [{ target, op: 'click' as const, expect: { kind: 'changed' as const }, why }] });

  // An overlay first, always. A modal property sheet sits over the toolbar that
  // holds Save, so a click aimed at the toolbar lands on the backdrop and does
  // nothing — while the page still "changes", because focus moved. Either the
  // overlay holds the commit, or it is in the way and has to be closed.
  const overlay = activeDialog(snap);
  if (overlay !== undefined) {
    const here = new Set(snap.compact.filter((c) => c.dialog === overlay).map((c) => c.ref));
    const inside = commitCandidates(snap).filter((c) => here.has(c.ref));
    const strongInside = inside.find((c) => !c.decoy && !c.weak);
    if (strongInside) return one({ role: strongInside.role, name: strongInside.name });

    const closer = inside.find((c) => !c.decoy)
      ?? snap.compact.find((c) => c.dialog === overlay && c.role === 'button' && isWayOut(c.name));
    return closer
      ? { steps: one({ role: closer.role, name: closer.name }).steps, again: 'closed the overlay covering the toolbar' }
      : { steps: [] };
  }

  const known = facts.get('commit');
  if (known?.descriptor && locate(snap, known.descriptor) !== null) return one(known.descriptor);

  const ranked = commitCandidates(snap);
  const strong = ranked.find((c) => !c.decoy && !c.weak);
  if (strong) return one({ role: strong.role, name: strong.name });

  // No commit word on screen. "Store", "Keep", "Lodge", "Add" are all somebody's
  // Save, and chasing that list is endless — so ask the structural question
  // instead: of the actions the editor itself brought with it, the one that is
  // not a way back out is the one that commits. Two candidates is a guess and
  // returns nothing, which escalates to a person.
  const rest = appeared?.size
    ? localActions(snap).filter((c) => appeared.has(normName(c.name)) && !isWayOut(c.name))
    : [];
  if (rest.length === 1) return one({ role: rest[0].role, name: rest[0].name });
  const none = { steps: [] as Step[] };

  // Still nothing: the designer may keep Save behind an overflow menu, which is
  // a real pattern and invisible until the menu is open. Two steps, because the
  // menu's contents do not exist yet — apply() re-reads and re-locates before
  // every step, so the second one is resolved against the opened menu.
  const popups = snap.compact.filter((c) =>
    c.role === 'button' && !!c.name && !isWayOut(c.name)
    && (c.state ?? []).some((st) => st.startsWith('haspopup') && !st.endsWith('false')));
  if (popups.length === 1) {
    // Only the opening click. What is inside does not exist until the menu is
    // open, and the entries may be buttons, menu items or links depending on
    // the widget library — so the caller re-reads and asks again, and the
    // ordinary ranking above picks the Save out of the opened menu.
    return { steps: one({ role: 'button', name: popups[0].name }).steps, again: 'opened the menu to look for the control that saves' };
  }

  // Last: a word that closes an editor as often as it saves one. Better than
  // nothing, and read-back still has to agree the page moved.
  const weak = ranked.find((c) => !c.decoy);
  return weak ? one({ role: weak.role, name: weak.name }) : none;
}

/**
 * Build order inside a field: type first, then everything the type governs.
 * Platforms discard silently what the current type cannot hold when the type
 * changes, so a range set before the type is a range that quietly vanishes.
 */
export function fieldSteps(snap: Snapshot, item: Extract<PlanItem, { kind: 'field' }>, typeLabel: string, includeType = true): Step[] {
  const f = item.field;
  const why = item.id;
  const steps: Step[] = [];
  const push = (s: Step | null) => { if (s) steps.push(s); };

  if (includeType) push(typeStep(snap, typeLabel, why));
  push(fieldStep(snap, V.label, f.label, why));

  if (f.required) {
    const req = locate(snap, { role: 'checkbox', nameAny: V.required }) ?? locate(snap, { role: 'switch', nameAny: V.required });
    if (req !== null) {
      steps.push({ target: { role: 'checkbox', nameAny: V.required }, op: 'check', arg: 'true', expect: { kind: 'checked', expect: true }, why });
    }
  }

  // Coded values are pairs. Per-row entry appends; bulk paste tends to replace,
  // and a list carrying only labels stores the wrong thing.
  //
  // Rows already on screen are filled, not appended to: a second attempt on a
  // field that half-built, or a rerun over a field that is already there, must
  // not leave the list carrying every option twice. Only the shortfall gets an
  // add click, and the rows are then addressed from the END of the list —
  // an option column shares its vocabulary with the field's own label input,
  // which sits before the rows, so counting forward can hit that instead.
  const options = f.options ?? [];
  if (options.length) steps.push(...optionSteps(snap, f, why));

  if (f.min !== undefined) push(fieldStep(snap, V.min, String(f.min), why));
  if (f.max !== undefined) push(fieldStep(snap, V.max, String(f.max), why));
  if (f.units) push(fieldStep(snap, V.units, f.units, why));
  if (f.formula) push(fieldStep(snap, V.formula, f.formula, why));
  if (f.skip_logic) steps.push(...skipSteps(snap, f.skip_logic, why));
  return steps;
}

/**
 * Entering the coded values, whichever way this designer accepts them.
 *
 * Per row when the editor has rows; otherwise the bulk box, which is the only
 * way in on a designer that offers no rows at all. Pairs either way — a list
 * carrying only labels stores the wrong thing — and read-back in verify() is
 * what settles whether the separator this platform expects was the one written.
 *
 * ponytail: the bulk box is written as `code=label`, one per line, because that
 * is what the box's own vocabulary ("code list", "paste values") implies and
 * there is no way to ask. A platform splitting on tabs or commas, or one whose
 * labels contain the separator, fails read-back and escalates as field.options
 * rather than storing something wrong quietly.
 */
function optionSteps(snap: Snapshot, f: Field, why: string): Step[] {
  const options = f.options ?? [];
  // Rows on screen only count as this field's when the editor is showing this
  // field — its name reads back somewhere as a value. Otherwise they belong to
  // whatever else is selected, and reusing them would fill the wrong list.
  const open = editing(snap, f.label) >= 0;
  const rows = open ? candidates(snap, { role: 'textbox', nameAny: V.optionCode, excludeAny: V.bulkOption }).length : 0;
  const addOption = findAdd(snap, V.addOption);
  const hasRowUi = rows > 0 || addOption !== null;

  if (!hasRowUi) {
    const bulk = TEXTISH.map((role) => ({ role, ref: locate(snap, { role, nameAny: V.bulkOption }) }))
      .find((x) => x.ref !== null);
    if (!bulk) return []; // neither way in — verify() escalates as field.options
    const text = options.map((o) => `${o.code}=${o.label}`).join('\n');
    const apply: Step[] = [{
      target: { role: bulk.role, nameAny: V.bulkOption }, op: 'type', arg: text,
      expect: { kind: 'value', expect: text }, why,
    }];
    // Whatever commits the box, if it has its own control. Not required: some
    // boxes take effect on blur, and the read-back in verify() is the judge.
    const load = findAdd(snap, V.bulkOption, false);
    if (load) apply.push({ target: load, op: 'click', expect: { kind: 'changed' }, why });
    return apply;
  }

  const steps: Step[] = [];
  for (let i = rows; i < options.length && addOption; i++) {
    steps.push({ target: addOption, op: 'click', expect: { kind: 'changed' }, why });
  }
  options.forEach((o, i) => {
    const nth = i - options.length; // -n … -1: the n rows at the end of the list
    steps.push({ target: { role: 'textbox', nameAny: V.optionCode, excludeAny: V.bulkOption, nth }, op: 'type', arg: o.code, expect: { kind: 'value', expect: o.code }, why });
    steps.push({ target: { role: 'textbox', nameAny: V.optionLabel, excludeAny: V.bulkOption, nth }, op: 'type', arg: o.label, expect: { kind: 'value', expect: o.label }, why });
  });
  return steps;
}

/**
 * Wiring one conditional rule.
 *
 * Three writes, not one: switch the mode control off "always", point the rule
 * at the controlling field, then give it the value to compare. The last two
 * controls usually do not exist until the first write lands, so they are
 * emitted unconditionally and located when their turn comes — apply() re-reads
 * before every step, and a control that never appears fails there as
 * "target not found", which is an escalation rather than a silent skip.
 */
function skipSteps(snap: Snapshot, rule: NonNullable<Field['skip_logic']>, why: string): Step[] {
  const mode = locate(snap, { role: 'combobox', nameAny: V.skip });
  if (mode === null) return []; // no mode control on screen — verify will fail and escalate
  const on = conditionalOption(snap, mode);
  if (!on) return [];
  return [
    { target: { role: 'combobox', nameAny: V.skip }, op: 'choose', arg: on, expect: { kind: 'value', expect: on }, why },
    {
      target: { role: 'combobox', nameAny: V.skipWhen }, op: 'choose', arg: rule.when_field_label,
      expect: { kind: 'value', expect: rule.when_field_label }, why,
    },
    {
      target: { role: 'textbox', nameAny: V.skipValue }, op: 'type', arg: rule.equals_value,
      expect: { kind: 'value', expect: rule.equals_value }, why,
    },
  ];
}

/**
 * Which entry on the mode control means "conditional". Read off the control
 * rather than assumed, because every platform words it differently — "Visible
 * When…", "Shown only when…", "Branch on another answer", "Only in certain
 * cases".
 */
function conditionalOption(snap: Snapshot, mode: Ref): string | null {
  const options = optionsOf(snap, mode);
  const named = options.find((o) => reads(o.name, V.skipOn))?.name;
  if (named) return named;
  // ponytail: with exactly two entries and neither reading as conditional, the
  // unconditional one is listed first on every designer seen so far. If a
  // platform inverts that, read-back on the step catches it.
  return options.length === 2 ? options[1].name ?? null : null;
}

function visitSteps(snap: Snapshot, item: Extract<PlanItem, { kind: 'visit' }>): Step[] {
  const steps: Step[] = [];
  const why = item.id;
  const name = fieldStep(snap, V.label, item.visit.name, why);
  if (name) steps.push(name);
  const start = String(item.visit.window_start_day);
  const end = String(item.visit.window_end_day);
  let s = fieldStep(snap, V.windowStart, start, why);
  let e = fieldStep(snap, V.windowEnd, end, why);
  if (!s || !e) {
    const wins = [...new Map(TEXTISH.flatMap((role) =>
      candidates(snap, { role, nameAny: V.window }).map((c) => [c.ref, c] as const),
    )).values()];
    if (wins.length === 2) {
      if (!s) s = { target: { role: wins[0].role, name: wins[0].name }, op: 'type', arg: start, expect: { kind: 'value', expect: start }, why };
      if (!e) e = { target: { role: wins[1].role, name: wins[1].name }, op: 'type', arg: end, expect: { kind: 'value', expect: end }, why };
    }
  }
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
export async function askType(s: Session, snap: Snapshot, canonical: Field['type'], library: string[]): Promise<{ label: string } | null> {
  const key = `type:${canonical}`;
  if (s.facts.get(`asked:${key}`)) {
    return null; // one call per question per session
  }
  // The verdict is recorded on this fact so the gate card can say what the
  // model did. A silently discarded answer is why "why am I being asked?" had
  // no answer on screen.
  const verdict = (why: string) => s.facts.set(`asked:${key}`, { value: 'yes', source: 'llm', why });
  verdict('asked, no reply yet');

  try {
    s.llmCalls++;
    const { ok, rejected } = await (s.ask ?? askModel)(
      snap,
      [{ key, ask: `Which element in this platform's library means the canonical type "${canonical}"? Library entries seen: ${library.join(', ')}` }],
      s.facts,
    );
    const d = ok.find((x) => x.key === key);
    if (!d) {
      verdict(rejected.map((r) => r.why).join('; ') || 'the model returned no decision for this question');
      return null;
    }
    // One veto, and only one: an entry whose name IS another canonical type's
    // name. "Select One" and "Select One (Expanded)" are the pair this platform
    // plants to be confused, and a confident model picks the shorter one — but
    // "Select One" is exactly what a single-select is called, so it cannot be
    // the radio. The longer one only *contains* that name, and nothing else
    // reads it, which is precisely the case the model exists to settle: it is
    // accepted. Anything weaker than an exact match is left to the model,
    // because vetoing on a partial match would reject every correct answer of
    // this shape.
    const own = bestCanonical(d.label);
    if (own && own !== canonical && score(d.label, own) === 3) {
      verdict(`answered "${d.label}" at confidence ${d.confidence}, but that is what this platform calls a ${own}`);
      return null;
    }
    verdict(`answered "${d.label}" at confidence ${d.confidence}`);
    s.facts.set(key, { value: d.label, source: 'llm', confidence: d.confidence, why: d.why, descriptor: { name: d.label } });
    return { label: d.label };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    verdict(why);
    return null; // no key, a rate limit, a timeout — all escalate to the human
  }
}

/**
 * Layer 2.5 — a structural fallback for "which control does X", asked before
 * escalating rather than instead of the heuristic. Symmetric with askType:
 * decision only, no click. The caller (buildItem / ensureContextRobust)
 * performs the actual click through the same verified `apply()` every other
 * write goes through, so a wrong answer here fails the same read-back gate a
 * wrong heuristic guess would — it never becomes a silent, confident mistake.
 *
 * Asked at most once per session per `key`, so a hopeless question does not
 * retry itself into a runaway model bill.
 */
export async function askControl(s: Session, snap: Snapshot, key: string, question: string): Promise<Descriptor | null> {
  if (s.facts.get(`asked:${key}`)) return null;
  const verdict = (why: string) => s.facts.set(`asked:${key}`, { value: 'yes', source: 'llm', why });
  verdict('asked, no reply yet');
  try {
    s.llmCalls++;
    const { ok, rejected } = await (s.ask ?? askModel)(snap, [{ key, ask: question }], s.facts);
    const d = ok.find((x) => x.key === key);
    if (!d) {
      verdict(rejected.map((r) => r.why).join('; ') || 'the model returned no decision for this question');
      return null;
    }
    const node = snap.compact.find((c) => c.ref === d.ref);
    if (!node) {
      verdict(`answered ref ${d.ref}, which is not on the snapshot the question was asked about`);
      return null;
    }
    verdict(`answered "${node.name}" at confidence ${d.confidence}`);
    return { role: node.role, name: node.name };
  } catch (err) {
    verdict(err instanceof Error ? err.message : String(err));
    return null; // no key, a rate limit, a timeout — all escalate to the human
  }
}

/** Which control adds a new visit/form/field. Cached per kind once a click actually opens the editor. */
export async function ensureAdd(
  s: Session,
  snap: Snapshot,
  kind: PlanItem['kind'],
  words: readonly string[],
  itemName: string,
  structural = true,
): Promise<{ target: Descriptor; source: Source } | null> {
  const key = `add:${kind}`;
  const known = s.facts.get(key);
  // Only when it is actually on this screen. A remembered descriptor that does
  // not locate here is worse than no answer: apply() would report "target not
  // found" as though the control had failed, when the truth is we are on the
  // wrong screen.
  if (known?.descriptor && locate(snap, known.descriptor) !== null) {
    return { target: known.descriptor, source: known.source };
  }

  const found = findAdd(snap, words, structural);
  if (found) return { target: found, source: 'synonym' };

  const guessed = await askControl(s, snap, key, `Which control adds a new ${kind} on this platform? About to add "${itemName}".`);
  return guessed ? { target: guessed, source: 'llm' } : null;
}

/**
 * Get to the visit/form an item needs, asking the model for the one segment
 * ensureContext's name-matching could not place, before giving up on it.
 *
 * Bounded at three rounds — there are at most two segments (visit, form), so
 * this is "try the deterministic path, ask once per stuck segment, try the
 * deterministic path again" and never an unbounded loop.
 */
async function ensureContextRobust(
  s: Session,
  snap: Snapshot,
  read: Read,
  path: { visit?: string; form?: string },
): Promise<{ snap: Snapshot } | { escalate: string; snap: Snapshot }> {
  let cur = snap;
  for (let i = 0; i < 3; i++) {
    const ctx = await ensureContext(cur, read, path);
    if (!('escalate' in ctx)) return ctx;

    const seg = ctx.escalate.slice('context:'.length);
    // A control the operator picked on the gate card outranks anything the
    // model would answer, and is tried first on every later item that needs
    // this segment — that is what makes answering the card worth doing.
    const answered = s.facts.get(ctx.escalate)?.descriptor;
    const guess = answered
      ?? await askControl(s, ctx.snap, ctx.escalate, `Which control navigates to the screen or section named "${seg}"? It may be a tab, tree item, row, link, menu item or button.`);
    if (!guess) return ctx;

    const result = await apply(ctx.snap, read, [{ target: guess, op: 'click', expect: { kind: 'changed' }, why: ctx.escalate }]);
    if (!result.ok || !screenNames(result.snap, seg)) return { escalate: ctx.escalate, snap: result.snap };
    cur = result.snap;
  }
  return ensureContext(cur, read, path);
}

// ---------------------------------------------------------------------------
// Building one item
// ---------------------------------------------------------------------------

type BuildOut = {
  snap: Snapshot; ok: boolean; tried: string[];
  escalate?: { sig: string; q: string; choices: GateItem['choices'] };
  /** An element was added to the platform during this attempt. */
  placed?: boolean;
};

const nameSet = (snap: Snapshot) => new Set(snap.compact.map((c) => normName(c.name)).filter(Boolean));

/**
 * Accessible names on the second screen that were not on the first.
 *
 * By name rather than by ref: an editor's heading usually repeats the name of
 * the control that opened it, so a ref-level diff calls that heading new and
 * the add button becomes a candidate for Save. And a ref does not survive the
 * re-render between two steps, so it could not be carried this far regardless.
 */
const newNames = (before: Snapshot, after: Snapshot): Set<string> => {
  const was = nameSet(before);
  return new Set([...nameSet(after)].filter((n) => !was.has(n)));
};

const choicesFrom = (snap: Snapshot, roles: string[]) =>
  snap.compact.filter((c) => roles.includes(c.role) && c.name).slice(0, 40).map((c) => ({ ref: c.ref, name: c.name! }));

async function buildItem(s: Session, item: PlanItem, snap: Snapshot, read: Read, ir: IR): Promise<BuildOut> {
  const tried: string[] = [];
  let placed = false;
  const words = item.kind === 'visit' ? V.addVisit : item.kind === 'form' ? V.addForm : V.addField;
  const itemName = item.kind === 'visit' ? item.visit.name : item.kind === 'form' ? item.form.name : item.field.label;
  let cur = snap;

  if (item.kind === 'form' && inDesigner(cur)) {
    cur = await stepOut(cur, read, contextOf(item).visit);
  }
  if (item.kind === 'visit') {
    if (inDesigner(cur)) cur = await stepOut(cur, read);
    // Two halves, and the first is the important one: a screen that is *about*
    // one visit is not the schedule, whatever add control happens to be on it.
    // Without that, "New Casebook Page" — the only add-ish control on a visit's
    // own screen — answers "which control adds a visit", and the next visit is
    // built as a form inside the previous one.
    const onSchedule = (s: Snapshot) =>
      !ir.visits.some((v) => screenNames(s, v.name)) && findAdd(s, V.addVisit) !== null;
    if (!onSchedule(cur)) cur = await home(cur, read, [ir.study.protocol_id, ir.study.title], onSchedule);
  }

  const already = !!itemName && named(cur, itemName);
  // discoverLibrary is the test for "am I in a designer", not inDesigner's word
  // list: a platform that titles its palette "Question Types" has one, and a
  // roster screen never passes discoverLibrary's half-the-vocabulary bar.
  const palette = item.kind === 'field' ? discoverLibrary(cur, irLabels(ir)) : null;
  const skipAdd = already || !!palette;

  // Phase 1 — open the editor. Skip when the item is already on screen, or
  // when a type palette is the add UI (no separate "Add Field" control).
  //
  // Vocabulary → cache → model, cheapest first, same as type resolution:
  // ensureAdd tries the cached fact, then the kind-specific synonym list
  // (never the wrong hierarchy's words — a field-add question never sees
  // V.addVisit), then asks the model only once this platform's add control
  // for this kind has never been found any other way.
  // A designer holds fields, never visits or forms. Letting the structural
  // fallback answer "which control adds a visit" from inside one picks whatever
  // single action is there and builds the visit as a field.
  const resolved = skipAdd ? null
    : await ensureAdd(s, cur, item.kind, words, itemName, item.kind === 'field' || !inDesigner(cur));
  const add = resolved?.target ?? null;
  /** Names that appeared when the editor opened — see commitStep. */
  let appeared = new Set<string>();
  if (skipAdd) {
    const match = cur.compact.find((c) => normName(c.name) === normName(itemName));
    tried.push(already
      ? `"${itemName}" is already on this screen as ${match?.role ?? '?'} ${JSON.stringify(match?.name ?? '')}; not creating a second copy`
      : 'type palette on screen; no separate add control');
  } else {
    if (!add) {
      const asked = s.facts.get(`asked:add:${item.kind}`)?.why;
      return {
        snap: cur, ok: false,
        tried: [
          `on "${cur.title || cur.url}", the actions outside the site chrome were: `
            + (localActions(cur).map((c) => c.name).join(', ') || 'none'),
          'none read as a control that adds this, and more than one was possible',
          ...(asked ? [`asked the model: ${asked}`] : []),
        ],
        escalate: { sig: `add:${item.kind}`, q: `Which control adds a ${item.kind} on this platform?`, choices: choicesFrom(cur, ['button', 'link', 'menuitem']) },
      };
    }
    tried.push(resolved!.source === 'llm' ? `the model picked "${add.name}" as the add control` : `clicked the add control matching ${JSON.stringify(words[0])}`);
    const before = cur;
    let opened = await apply(cur, read, [{ target: add, op: 'click', expect: { kind: 'changed' }, why: item.id }]);
    if (!opened.ok && opened.results.at(-1)?.reason === 'element not rendered') {
      // Found uniquely but not yet rendered is a timing gap, not a wrong
      // answer — the exact reasoning MAX_ATTEMPTS already applies to a
      // disagreeing read-back. One fresh look before giving up on it, not an
      // unbounded poll.
      tried.push('the add control was found but not yet rendered; re-read and tried once more');
      opened = await apply(await read(), read, [{ target: add, op: 'click', expect: { kind: 'changed' }, why: item.id }]);
    }
    if (!opened.ok) {
      return { snap: opened.snap, ok: false, tried: [...tried, opened.results.at(-1)?.reason ?? 'the add control did nothing'],
        escalate: { sig: `add:${item.kind}`, q: `Which control adds a ${item.kind} on this platform?`, choices: choicesFrom(opened.snap, ['button', 'link', 'menuitem']) } };
    }
    // Cached only now that a click on it actually opened something — never
    // memoize an untried guess, the same rule the commit fact already follows.
    if (!s.facts.get(`add:${item.kind}`)) {
      s.facts.set(`add:${item.kind}`, { value: itemName, source: resolved!.source, descriptor: add });
    }
    appeared = newNames(before, opened.snap);
    cur = opened.snap;
  }

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
    const exists = named(cur, item.field.label);
    const ts = exists ? null : typeStep(cur, t.label, item.id);
    if (exists) tried.push('field already on canvas; filling it, not adding another');
    if (ts) {
      const typed = await apply(cur, read, [ts]);
      cur = typed.snap;
      if (!typed.ok) {
        return { snap: cur, ok: false, tried: [...tried, typed.results.at(-1)?.reason ?? 'picking the type did nothing'],
          escalate: { sig: `write:${item.kind}`, q: `A write did not take on this platform. Which control is right?`, choices: choicesFrom(cur, TEXTISH) } };
      }
      tried.push(`picked type ${t.label}`);
      placed = true;

      // A library that is a dropdown rather than a row of tiles does not place
      // anything when the type is chosen — it needs the add control clicked
      // after the choice, not before it. Detected by the editor still having no
      // control that takes a name, so a platform that places on selection is
      // unaffected.
      if (fieldStep(cur, V.label, item.field.label, item.id) === null) {
        const insert = findAdd(cur, V.addField);
        if (insert) {
          const placed = await apply(cur, read, [{ target: insert, op: 'click', expect: { kind: 'changed' }, why: item.id }]);
          cur = placed.snap;
          tried.push(placed.ok
            ? `the type was chosen but nothing was placed, so clicked ${JSON.stringify(insert.name ?? insert.nameAny?.[0])}`
            : `clicking ${JSON.stringify(insert.name ?? insert.nameAny?.[0])} after choosing the type did nothing`);
        }
      }
    }
    steps = fieldSteps(cur, item, t.label, false);
  }

  if (steps.length === 0) {
    return { snap: cur, ok: false, placed, tried: [...tried, 'the editor showed no control matching the designer vocabulary'],
      escalate: { sig: `editor:${item.kind}`, q: `Which control sets the name of a ${item.kind} here?`, choices: choicesFrom(cur, TEXTISH) } };
  }

  const done = await apply(cur, read, steps);
  cur = done.snap;
  for (const r of done.results) if (!r.ok) tried.push(`${r.step.op} ${JSON.stringify(r.step.arg ?? '')}: ${r.reason}`);
  if (!done.ok) {
    const err = done.results.find((r) => r.errors.length)?.errors[0];
    return { snap: cur, ok: false, placed, tried,
      escalate: err ? { sig: `rejected:${item.kind}`, q: `The platform rejected this: "${err.text}". What should happen?`, choices: [] }
                    : { sig: `write:${item.kind}`, q: `A write did not take on this platform. Which control is right?`, choices: choicesFrom(cur, TEXTISH) } };
  }

  // Saving is explicit, and reaching a screen is not building.
  //
  // One card for the whole platform, not one per kind: which control saves is a
  // property of the designer, and the operator should be asked once. Not
  // finding one at all escalates too — a run that types into an editor nobody
  // saved leaves a draft, and a draft that is never mentioned is the silent
  // skip the brief calls the worst outcome.
  const commitCard = () => ({
    sig: 'commit',
    q: `Which control saves the work on this platform?`,
    choices: choicesFrom(cur, ['button', 'link', 'menuitem']),
  });
  const sawCommit = () => `controls reading as a commit: `
    + (commitCandidates(cur).map((c) => `${c.name}${c.decoy ? ' (decoy)' : c.weak ? ' (weak)' : ''}`).join(', ') || 'none');
  // A few rounds, because reaching Save can take more than one click: close the
  // property sheet covering the toolbar, open the overflow menu, then save. Each
  // round has to move the page or it fails, so this cannot spin.
  const COMMIT_ROUNDS = 4;
  for (let round = 0; round < COMMIT_ROUNDS; round++) {
    const { steps, again } = commitSteps(cur, s.facts, item.id, appeared);
    if (steps.length === 0) {
      return { snap: cur, ok: false, placed,
        tried: [...tried, sawCommit(), 'no control on the editor read as the one that saves, and more than one was possible'],
        escalate: commitCard() };
    }
    const saved = await apply(cur, read, steps);
    cur = saved.snap;
    if (!saved.ok) {
      // Returning ok:true here closed the item as `built` on a platform that
      // had persisted nothing — the ledger said 14 built while __readState()
      // showed zero visits. A commit that did not take is the whole failure,
      // not a footnote on a success.
      return { snap: cur, ok: false, placed,
        tried: [...tried, sawCommit(), `commit via ${JSON.stringify(steps[0].target.name)}: ${saved.results.at(-1)?.reason}`],
        escalate: commitCard() };
    }
    if (again) {
      tried.push(`${again}: clicked ${JSON.stringify(steps[0].target.name)}`);
      continue;
    }
    if (!s.facts.has('commit')) {
      s.facts.set('commit', { value: String(steps[0].target.name ?? ''), descriptor: steps[0].target, source: 'discovered' });
    }
    return { snap: cur, ok: true, tried, placed };
  }
  return { snap: cur, ok: false, placed,
    tried: [...tried, sawCommit(), `still not saved after ${COMMIT_ROUNDS} attempts at reaching the control that commits`],
    escalate: commitCard() };
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
  // Only when there is something to come back from. A fresh run starts wherever
  // the operator left the platform, and on a schedule screen that is already
  // the right place — walking the chrome from there lands in whichever module
  // the navigation happens to list first, which is how every item after it
  // escalates for want of a screen.
  if (!live.live && inDesigner(snap)) snap = await home(snap, read, [ir.study.protocol_id, ir.study.title]);

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
      const ctx = await ensureContextRobust(s, snap, read, contextOf(item));
      snap = ctx.snap;
      if ('escalate' in ctx) {
        s.ledger.escalated(item, ctx.escalate);
        const asked = s.facts.get(`asked:${ctx.escalate}`)?.why;
        escalate(s.queue, ctx.escalate, `How does this platform open "${ctx.escalate.slice(8)}"?`, item,
          [
            `ended up on "${snap.title || snap.url}", where the things that can be navigated to are: `
              + (choicesFrom(snap, ['link', 'tab', 'button', 'row', 'listitem', 'cell', 'option', 'treeitem'])
                  .map((c) => c.name).join(', ') || 'nothing'),
            'clicked every control carrying that name, went back to the root and came in again',
            ...(asked ? [`asked the model: ${asked}`] : []),
          ],
          choicesFrom(snap, ['link', 'tab', 'button', 'row', 'listitem', 'cell', 'option', 'treeitem']));
        break;
      }

      // Presence is never sufficient. This is the same verify() used after a
      // build, so an item that merely looks present still has to prove it.
      const pre = verify(snap, item, s.facts);
      if (pre.ok) { s.ledger.built(item, { source: 'verified-existing', settled: snap.settled.quiet, settleMs: snap.settled.ms, settleGapMs: snap.settled.maxGapMs }); break; }

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
        s.ledger.built(item, { source: 'synonym', settled: snap.settled.quiet, settleMs: snap.settled.ms, settleGapMs: snap.settled.maxGapMs, decision: out.tried.at(-1) });
        break;
      }
      s.ledger.note(item, `verify failed: ${post.missing.join('; ')}`);
      // A second attempt is only worth spending when the first left nothing
      // behind. Once an element is on the platform, re-running the whole build
      // adds a second one beside it — an extra field the study never asked for,
      // which is a defect of its own and one nobody looks for.
      if (attempt === MAX_ATTEMPTS - 1 || out.placed) {
        const leftover = out.placed
          ? ['an element was added and could not be completed — there is an unnamed one on this screen to remove or finish']
          : [];
        for (const line of leftover) s.ledger.note(item, line);
        s.ledger.escalated(item, post.signature);
        escalate(s.queue, post.signature, `"${item.id}" did not read back: ${post.missing.slice(0, 4).join('; ')}`, item,
          [...out.tried, ...post.missing, ...leftover], choicesFrom(snap, TEXTISH));
        snap = await dismiss(snap, read);
        break;
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
