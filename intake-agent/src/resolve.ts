/**
 * Deciding what this platform calls things.
 *
 * Three layers, cheapest first, so most questions never reach the LLM and far
 * fewer reach a human:
 *
 *   1. synonyms + an acceptance rule that abstains rather than guessing
 *   2. a per-session cache, because 195 fields ask ~13 distinct questions
 *   3. one batched LLM call per form, for whatever is left
 *
 * Nothing here is specific to a platform. The synonym table is the vocabulary
 * the *category* uses — the pool designers pick from — not any mock's labels,
 * and the acceptance rule is what makes a wrong pick abstain instead of build.
 */
import { chat, type Msg } from './llm.ts';
import { normName, toPrompt, type Snapshot } from './perceive.ts';
import { type Descriptor } from './act.ts';
import { CANONICAL_TYPES, type FieldType } from './ir.ts';

// ---------------------------------------------------------------------------
// Layer 2 — facts, owned by the session and passed in
// ---------------------------------------------------------------------------

export type Source = 'synonym' | 'discovered' | 'llm' | 'human';

export type Fact = {
  /** The library label, a shape name, or the sentinel 'absent'. */
  value: string;
  /** How to re-find the control. Never a ref — a ref dies on the next render. */
  descriptor?: Descriptor;
  source: Source;
  confidence?: number;
  why?: string;
};

/**
 * Session-scoped. Deliberately not module state: module state outlives a
 * session, would leak across a panel reload, and could only be cleared through
 * an exported reset that someone remembers once and forgets twice.
 */
export type Facts = Map<string, Fact>;
export const newFacts = (): Facts => new Map();

// ---------------------------------------------------------------------------
// Layer 1 — the synonym pass
// ---------------------------------------------------------------------------

const SYNONYMS: Record<FieldType, string[]> = {
  text: ['text', 'text field', 'short text', 'single line', 'one line text', 'string', 'free text', 'text box'],
  textarea: ['text area', 'textarea', 'long text', 'multi line', 'multiline text', 'paragraph', 'memo', 'notes', 'comment'],
  integer: ['integer', 'whole number', 'number', 'numeric', 'int', 'count'],
  decimal: ['decimal', 'float', 'number decimal', 'real', 'numeric decimal', 'measurement'],
  date: ['date', 'date picker', 'calendar', 'date field'],
  time: ['time', 'time picker', 'clock', 'time field'],
  datetime: ['date time', 'datetime', 'date and time', 'timestamp', 'date time picker'],
  boolean: ['yes no', 'yes/no', 'boolean', 'true false', 'true/false', 'toggle', 'switch', 'y n'],
  single_select: ['dropdown', 'drop down', 'picklist', 'pick list', 'combo', 'combo box', 'select',
                  'select one', 'choice list', 'single select', 'listbox', 'list box', 'code list'],
  multi_select: ['check list', 'checklist', 'multi select', 'multiselect', 'multi picklist',
                 'multi pick list', 'tag select', 'select many', 'multiple choice', 'multi choice'],
  radio: ['radio', 'radio group', 'radio buttons', 'option group', 'single choice', 'button group'],
  checkbox: ['checkbox', 'check box', 'tick box', 'single checkbox', 'flag', 'tickbox'],
  calculated: ['calculated', 'calculation', 'derived', 'formula', 'computed', 'expression', 'auto calculated'],
};

/** exact = 3, whole word = 2, substring = 1. Best synonym wins. */
export function score(label: string, canonical: FieldType): number {
  const l = normName(label);
  if (!l) return 0;
  let best = 0;
  for (const syn of SYNONYMS[canonical]) {
    const s = normName(syn);
    if (!s) continue;
    if (l === s) best = Math.max(best, 3);
    else if (` ${l} `.includes(` ${s} `)) best = Math.max(best, 2);
    else if (l.includes(s)) best = Math.max(best, 1);
  }
  return best;
}

/** Which canonical this library label reads as, on its own terms. */
export function bestCanonical(label: string): FieldType | null {
  const scored = CANONICAL_TYPES.map((c) => ({ c, s: score(label, c) })).sort((a, b) => b.s - a.s);
  if (scored[0].s === 0) return null;
  if (scored[1] && scored[1].s === scored[0].s) return null; // reads as two things equally
  return scored[0].c;
}

export type Resolution = { label: string } | { abstain: string };

/**
 * The acceptance rule, which is what makes this safe — not the scorer.
 *
 * All three must hold: the winning label's own best canonical is the one being
 * asked for, no other label ties it, and the margin over the runner-up is >= 1.
 * A platform shipping "Select" and "Multi Select" side by side ties for
 * single_select, and the rule refuses. Abstention is the feature: an abstained
 * type reaches a human, a wrong one reaches the database.
 */
export function resolveType(canonical: FieldType, library: string[]): Resolution {
  const scored = library
    .map((l) => ({ l, s: score(l, canonical) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  if (scored.length === 0) return { abstain: `no element in the library reads as ${canonical}` };
  const [top, next] = scored;
  if (next && next.s === top.s) return { abstain: `"${top.l}" and "${next.l}" score equally for ${canonical}` };
  if (next && top.s - next.s < 1) return { abstain: `"${top.l}" beats "${next.l}" by too little` };

  const own = bestCanonical(top.l);
  if (own !== canonical) {
    return { abstain: own ? `"${top.l}" reads more like ${own}` : `"${top.l}" does not read as any canonical type` };
  }
  return { label: top.l };
}

// ---------------------------------------------------------------------------
// Discovering that there is an element library at all
// ---------------------------------------------------------------------------

const PICKABLE = new Set(['button', 'listitem', 'option', 'menuitem', 'link', 'cell', 'gridcell', 'treeitem', 'row', 'tab']);

/**
 * The agent is not told an element library exists. Look for a cluster of
 * same-depth actionable nodes whose names are not IR labels, and keep the
 * cluster that most of the canonical vocabulary resolves inside.
 *
 * Deterministic, no LLM. A platform that hides its library behind a dialog is
 * found on the next snapshot, once that dialog is open.
 */
export function discoverLibrary(snap: Snapshot, irLabels: Set<string>): { labels: string[]; depth: number } | null {
  const groups = new Map<number, string[]>();
  for (const n of snap.compact) {
    if (!PICKABLE.has(n.role) || !n.name) continue;
    if (irLabels.has(normName(n.name))) continue; // that is study content, not a library
    const g = groups.get(n.depth) ?? [];
    g.push(n.name);
    groups.set(n.depth, g);
  }

  let best: { labels: string[]; depth: number; hits: number } | null = null;
  for (const [depth, labels] of groups) {
    if (labels.length < 5) continue;
    const hits = CANONICAL_TYPES.filter((c) => 'label' in resolveType(c, labels)).length;
    if (!best || hits > best.hits) best = { labels, depth, hits };
  }
  // Half the vocabulary resolving inside one cluster is what makes it a library
  // rather than a menu that happens to hold five buttons.
  return best && best.hits >= Math.ceil(CANONICAL_TYPES.length / 2) ? { labels: best.labels, depth: best.depth } : null;
}

// ---------------------------------------------------------------------------
// Vocabularies for the platform facts that are controls rather than types
// ---------------------------------------------------------------------------

export const COMMIT_WORDS = ['save', 'submit', 'apply', 'commit', 'publish', 'confirm', 'done', 'finish', 'ok'];
/** Ranked below the above, and never auto-accepted — these look like Save and are not. */
export const COMMIT_DECOYS = ['save as', 'save as template', 'save draft', 'save and new', 'save copy', 'export'];
export const REUSE_TEMPLATE_WORDS = ['save as template', 'publish as template', 'make template', 'save as'];
export const REUSE_COPY_WORDS = ['copy from', 'duplicate', 'clone', 'add existing', 'import', 'reuse', 'copy'];

/** Candidates for a commit control, best first. A decoy never outranks a plain one. */
export function commitCandidates(snap: Snapshot): { name: string; ref: number; decoy: boolean }[] {
  const out: { name: string; ref: number; decoy: boolean }[] = [];
  for (const n of snap.compact) {
    if (n.role !== 'button' && n.role !== 'menuitem') continue;
    const name = normName(n.name);
    if (!name) continue;
    if (!COMMIT_WORDS.some((w) => name.includes(w))) continue;
    out.push({ name: n.name!, ref: n.ref, decoy: COMMIT_DECOYS.some((w) => name.includes(w)) });
  }
  return out.sort((a, b) => Number(a.decoy) - Number(b.decoy) || a.name.length - b.name.length);
}

// ---------------------------------------------------------------------------
// Layer 3 — one batched LLM call, for what Layers 1-2 could not answer
// ---------------------------------------------------------------------------

export type Question = { key: string; ask: string };
export type Decision = { key: string; ref: number; label: string; confidence: number; why: string };

export const MIN_CONFIDENCE = 0.7;

const SYSTEM = `You map a clinical study specification onto an eSource platform you have never seen.
You are given the page's accessibility tree as "[ref] role name" lines, and a list of questions.
Answer only from what is on the page. Never invent a ref.
Reply as JSON: {"decisions":[{"key":"...","ref":0,"label":"...","confidence":0.0,"why":"..."}]}
confidence is your own honest probability the answer is right. Below 0.7 a human is asked instead,
which is cheap; a wrong answer is not. Prefer a low confidence to a plausible guess.`;

export function buildMessages(snap: Snapshot, questions: Question[], facts: Facts): Msg[] {
  const known = [...facts].map(([k, f]) => `${k} = ${f.value} (${f.source})`).join('\n') || 'nothing yet';
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `Page:\n${toPrompt(snap)}\n\nAlready established about this platform:\n${known}\n\nQuestions:\n${questions
        .map((q) => `- ${q.key}: ${q.ask}`)
        .join('\n')}`,
    },
  ];
}

/**
 * Model output is untrusted input, exactly like the IR file. Two checks before
 * anything becomes a click: the ref must exist in the snapshot the question was
 * asked about, and low confidence escalates rather than building.
 */
export function validate(snap: Snapshot, raw: string): { ok: Decision[]; rejected: { key: string; why: string }[] } {
  const ok: Decision[] = [];
  const rejected: { key: string; why: string }[] = [];
  let parsed: { decisions?: Decision[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok, rejected: [{ key: '*', why: 'the model did not return JSON' }] };
  }
  const refs = new Set(snap.compact.map((c) => c.ref));
  for (const d of parsed.decisions ?? []) {
    if (!d || typeof d.key !== 'string') continue;
    if (!refs.has(d.ref)) rejected.push({ key: d.key, why: `ref ${d.ref} is not on the page` });
    else if (!(d.confidence >= MIN_CONFIDENCE)) rejected.push({ key: d.key, why: `confidence ${d.confidence} < ${MIN_CONFIDENCE}` });
    else ok.push(d);
  }
  return { ok, rejected };
}

/** One call for every unresolved question in a form, not one call per field. */
export async function askModel(
  snap: Snapshot,
  questions: Question[],
  facts: Facts,
): Promise<{ ok: Decision[]; rejected: { key: string; why: string }[]; tokens: number }> {
  if (questions.length === 0) return { ok: [], rejected: [], tokens: 0 };
  const reply = await chat(buildMessages(snap, questions, facts), { json: true, maxTokens: 1500 });
  const v = validate(snap, reply.text);
  return { ...v, tokens: reply.inputTokens + reply.outputTokens };
}

// ---------------------------------------------------------------------------
// Designer vocabulary — the words a form designer uses for its own controls.
//
// Same justification as SYNONYMS: this is the pool the category draws from, not
// any one mock's labels. A platform calling its label box "Question" and
// another calling it "Caption" are both covered without either being hardcoded.
// ---------------------------------------------------------------------------

export const V = {
  addVisit: ['add visit', 'new visit', 'create visit', 'add timepoint', 'new timepoint'],
  addForm: ['add form', 'new form', 'add document', 'new document', 'add source', 'add crf', 'new crf', 'add page'],
  addField: ['add field', 'new field', 'add element', 'new element', 'add item', 'add question', 'insert field'],
  addAny: ['add', 'new', 'create', 'insert', '+'],
  label: ['label', 'field label', 'name', 'question', 'caption', 'title', 'prompt'],
  type: ['type', 'field type', 'element type', 'control type', 'data type', 'widget', 'control'],
  required: ['required', 'mandatory', 'must complete', 'is required'],
  repeating: ['repeating', 'repeat', 'log', 'multiple records', 'recurring', 'grid'],
  min: ['min', 'minimum', 'lower', 'low', 'range from', 'from'],
  max: ['max', 'maximum', 'upper', 'high', 'range to', 'to'],
  units: ['unit', 'units', 'uom', 'measure', 'measurement unit'],
  optionCode: ['code', 'coded value', 'value', 'stored value', 'submission value'],
  optionLabel: ['label', 'display', 'display text', 'text', 'option label', 'choice'],
  addOption: ['add option', 'add value', 'add choice', 'add row', 'add code', 'new option'],
  bulkOption: ['bulk', 'paste', 'import values', 'bulk entry', 'code list', 'paste values'],
  skip: ['skip', 'skip logic', 'condition', 'conditional', 'show when', 'visible when', 'branching', 'logic'],
  window: ['window', 'day', 'days', 'start', 'end', 'from', 'to', 'offset'],
  formula: ['formula', 'expression', 'calculation', 'derive', 'compute'],
} as const;

/** Does this accessible name read as one of `words`? */
export const reads = (name: string | undefined, words: readonly string[]): boolean => {
  const n = normName(name);
  return !!n && words.some((w) => n === normName(w) || ` ${n} `.includes(` ${normName(w)} `));
};
