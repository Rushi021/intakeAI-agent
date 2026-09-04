/**
 * The guarantee: every plan item ends built-and-verified or escalated-with-
 * context, never a third silent state. Plus the two places that guarantee is
 * easiest to break — presence mistaken for success, and a rerun trusting an
 * item it should have re-checked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Ledger, assertTerminated, explain, identify, liveness, statusTree, verify, newSession, escalate, fieldSteps, askType,
  askControl, ensureAdd, type Session,
} from '../src/run.ts';
import { newFacts, V } from '../src/resolve.ts';
import { locate, candidates } from '../src/act.ts';
import { parseIR, planItems, type PlanItem } from '../src/ir.ts';
import { N, props, snap } from './helpers.ts';

const IR = parseIR(JSON.stringify({
  ir_version: '1.0',
  study: { protocol_id: 'ABC-101', title: 'A Study of Things' },
  visits: [{
    name: 'Screening', window_start_day: -28, window_end_day: -1,
    forms: [
      { name: 'Demographics', repeating: false, fields: [
        { label: 'Sex', type: 'single_select', required: true, options: [{ code: 'M', label: 'Male' }, { code: 'F', label: 'Female' }] },
        { label: 'Weight', type: 'decimal', required: true, min: 30, max: 200, units: 'kg' },
      ] },
      { name: 'Con Meds', repeating: true, fields: [{ label: 'Drug Name', type: 'text', required: false }] },
    ],
  }],
}));
const PLAN = planItems(IR);
const item = (id: string): PlanItem => PLAN.find((p) => p.id === id)!;

// ── the ledger and the guarantee ────────────────────────────────────────────

test('an interrupted item is distinguishable from an untouched one', () => {
  const l = new Ledger();
  l.begin(item('Screening'));
  assert.equal(l.frontier()?.item, 'Screening', 'a stop between begin and verify leaves a frontier');
  l.built(item('Screening'), { source: 'synonym' });
  assert.equal(l.frontier(), undefined);
});

test('assertTerminated fails loudly rather than reporting a green run', () => {
  const l = new Ledger();
  l.built(item('Screening'), {});
  const t = assertTerminated(l, PLAN);
  assert.equal(t.ok, false);
  assert.ok(t.unaccounted.length === PLAN.length - 1, 'every unfinished item is named, not counted away');
});

test('built + escalated === total, over a mix of outcomes', () => {
  const l = new Ledger();
  for (const [i, p] of PLAN.entries()) (i % 3 === 0 ? l.escalated(p, 'type:x') : l.built(p, {}));
  const c = l.counts();
  assert.equal(c.built + c.escalated + c.reused, PLAN.length);
  assert.deepEqual(assertTerminated(l, PLAN).unaccounted, []);
});

test('a built record is trusted by its state, never by its position', () => {
  // Escalation leaves holes, so completion is non-contiguous by design. An
  // implementer reaching for "items before the frontier" introduces a bug.
  const l = new Ledger();
  l.escalated(PLAN[1], 'type:single_select');   // a hole early on
  l.built(PLAN.at(-1)!, {});                    // and a completed item after it
  l.begin(PLAN[2]);                             // the frontier sits between them
  assert.equal(l.frontier()?.item, PLAN[2].id);
  assert.equal(l.get(PLAN.at(-1)!.id)?.state, 'built');
});

// ── identity: absent is not the same as wrong ───────────────────────────────

test('identity matches on protocol id or title', () => {
  assert.deepEqual(identify(snap(N('RootWebArea', 'x', [N('heading', 'ABC-101 Build')])), IR), { ok: true, matched: 'protocol_id' });
  assert.equal(identify(snap(N('RootWebArea', 'x', [N('heading', 'A Study of Things')])), IR).ok, true);
});

test('a page naming a different study is the only hard stop', () => {
  const other = identify(snap(N('RootWebArea', 'x', [N('heading', 'Study XYZ-999')])), IR);
  assert.equal(other.ok, false);
});

test('a platform with no study anchor is unconfirmed, never a hard fail', () => {
  // Otherwise the agent refuses to run at all on every platform that does not
  // badge the study — a structural failure dressed up as a safety check.
  const bare = identify(snap(N('RootWebArea', 'x', [N('button', 'Add Visit'), N('heading', 'Visit Schedule')])), IR);
  assert.equal(bare.ok, 'unconfirmed');
});

// ── liveness ────────────────────────────────────────────────────────────────

test('a platform with no study anchor never disables the fast path', () => {
  // The silent failure this guards: identity can never pass on a platform that
  // does not badge the study, so treating that as a boundary would downgrade
  // every rerun to a full walk while reporting it as a real session break.
  const s = newSession(7, 'u', IR);
  s.ledger.built(item('Screening'), {});
  const page = snap(N('RootWebArea', 'x', [N('heading', 'Screening')]));
  assert.equal(liveness(s, page, IR, 7).live, true);
  s.facts.set('study.anchor', { value: 'absent', source: 'human' });
  assert.equal(liveness(s, page, IR, 7).live, true);
});

test('a page that names a different study still breaks liveness', () => {
  const s = newSession(7, 'u', IR);
  s.ledger.built(item('Screening'), {});
  const elsewhere = snap(N('RootWebArea', 'x', [N('heading', 'Study XYZ-999'), N('heading', 'Screening')]));
  assert.equal(liveness(s, elsewhere, IR, 7).live, false);
});

test('a different tab is a session boundary', () => {
  const s = newSession(7, 'u', IR);
  s.ledger.built(item('Screening'), {});
  s.facts.set('study.anchor', { value: 'absent', source: 'human' });
  assert.equal(liveness(s, snap(N('RootWebArea', 'x', [N('heading', 'Screening')])), IR, 8).live, false);
});

// ── verify: presence is never sufficient ────────────────────────────────────

const facts = () => { const f = newFacts(); f.set('type:single_select', { value: 'Dropdown', source: 'synonym' }); return f; };

test('an element that exists but was never named is a failure', () => {
  const page = snap(N('RootWebArea', 'x', [N('textbox', undefined), N('heading', 'Demographics')]));
  const v = verify(page, item('Screening/Demographics/Sex'), facts());
  assert.equal(v.ok, false);
});

test('option lists are compared pairwise, not by count', () => {
  // A bulk paste that dropped the codes leaves the right number of values.
  const labelsOnly = snap(N('RootWebArea', 'x', [
    N('heading', 'Sex'), N('cell', 'Dropdown'), N('cell', 'required'),
    N('cell', 'Male'), N('cell', 'Female'),
  ]));
  const v = verify(labelsOnly, item('Screening/Demographics/Sex'), facts());
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.signature, 'field.options');
  assert.ok(v.ok === false && v.missing.some((m) => m.includes('"M"')));
});

test('a fully built field verifies', () => {
  const page = snap(N('RootWebArea', 'x', [
    N('heading', 'Sex'), N('cell', 'Dropdown'), N('cell', 'required'),
    N('cell', 'M'), N('cell', 'Male'), N('cell', 'F'), N('cell', 'Female'),
  ]));
  assert.equal(verify(page, item('Screening/Demographics/Sex'), facts()).ok, true);
});

/** An inspector with `pad` elements of chrome between the name box and the rows. */
const editorPage = (pad: number, rows: [string, string][]) => snap(N('RootWebArea', 'x', [
  N('heading', 'Sex'), N('cell', 'Dropdown'), N('cell', 'required'),
  N('textbox', 'Label', [], { value: { value: 'Sex' } }),
  N('combobox', 'Element Type'),
  ...Array.from({ length: pad }, (_, i) => N('option', `Type ${i}`)),
  ...rows.flatMap(([code, label]) => [
    N('labeltext', 'Code'), N('textbox', 'Code', [], { value: { value: code } }),
    N('labeltext', 'Label'), N('textbox', 'Label', [], { value: { value: label } }),
    N('button', '\u00d7'),
  ]),
]));

test('the last code reads back however far down the editor it sits', () => {
  // The escalation this prevents: every code is on screen, but the check
  // stopped short of the last row and reported it missing. No amount of
  // chrome above the rows, and no length of list, may reintroduce that — so
  // this asserts across both, rather than at one comfortable size.
  for (const pad of [0, 30, 500]) {
    const page = editorPage(pad, [['M', 'Male'], ['F', 'Female']]);
    assert.equal(verify(page, item('Screening/Demographics/Sex'), facts()).ok, true, `pad ${pad}`);
  }
});

test('a code that is genuinely absent is still caught, however long the list', () => {
  // The other half: reading the rows off the editor must not turn into
  // crediting a field for values it does not carry.
  const decoys: [string, string][] = Array.from({ length: 200 }, (_, i) => [`X${i}`, `Choice ${i}`]);
  const v = verify(editorPage(0, [['M', 'Male'], ...decoys]), item('Screening/Demographics/Sex'), facts());
  assert.equal(v.ok, false);
  assert.deepEqual(v.ok === false && v.missing, ['option code "F" missing', 'option label "Female" missing']);
});

test('min/max in the inspector verify even when far from the canvas card', () => {
  const fillers = Array.from({ length: 40 }, (_, i) => N('cell', `pad-${i}`));
  const page = snap(N('RootWebArea', 'x', [
    N('heading', 'Weight'), N('cell', 'required'),
    ...fillers,
    N('textbox', 'Label', [], { value: { value: 'Weight' } }),
    N('textbox', 'Minimum', [], { value: { value: '30' } }),
    N('textbox', 'Maximum', [], { value: { value: '200' } }),
    N('textbox', 'Units', [], { value: { value: 'kg' } }),
  ]));
  assert.equal(verify(page, item('Screening/Demographics/Weight'), newFacts()).ok, true);
});

test('a range that vanished when the type changed is caught', () => {
  const page = snap(N('RootWebArea', 'x', [N('heading', 'Weight'), N('cell', 'required'), N('cell', '30')]));
  const v = verify(page, item('Screening/Demographics/Weight'), newFacts());
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.signature, 'field.range');
});

test('a repeating form that nothing on screen calls repeating escalates', () => {
  const page = snap(N('RootWebArea', 'x', [N('heading', 'Con Meds'), N('cell', 'Drug Name')]));
  const v = verify(page, item('Screening/Con Meds'), newFacts());
  assert.equal(v.ok === false && v.signature, 'form.repeating');
});

// ── option rows: filled once, never twice ───────────────────────────

const fieldItem = (id: string) => item(id) as Extract<PlanItem, { kind: 'field' }>;

const inspector = (rows: [string, string][]) => snap(N('RootWebArea', 'x', [
  N('heading', 'Sex'), N('button', 'Add Value'),
  N('textbox', 'Label', [], { value: { value: 'Sex' } }),
  ...rows.flatMap(([code, label]) => [
    N('textbox', 'Code', [], { value: { value: code } }),
    N('textbox', 'Label', [], { value: { value: label } }),
  ]),
]));

test('a field whose options are already on screen is filled, not doubled', () => {
  // The bug this catches: a second attempt clicked "Add Value" once per option
  // again, leaving the list carrying every code twice.
  const steps = fieldSteps(inspector([['M', 'Male'], ['F', 'Female']]), fieldItem('Screening/Demographics/Sex'), 'Dropdown', false);
  assert.equal(steps.filter((s) => s.op === 'click').length, 0, 'no row is added when the rows are already there');
  assert.deepEqual(steps.filter((s) => s.op === 'type').map((s) => s.arg), ['M', 'Male', 'F', 'Female']);
  // Addressed from the end, so the field's own Label input is never row one.
  assert.deepEqual(steps.filter((s) => s.arg === 'M' || s.arg === 'Male').map((s) => s.target.nth), [-2, -2]);
});

test('only the shortfall of option rows is added', () => {
  const one = fieldSteps(inspector([['M', 'Male']]), fieldItem('Screening/Demographics/Sex'), 'Dropdown', false);
  assert.equal(one.filter((s) => s.op === 'click').length, 1);
  const none = fieldSteps(inspector([]), fieldItem('Screening/Demographics/Sex'), 'Dropdown', false);
  assert.equal(none.filter((s) => s.op === 'click').length, 2, 'a fresh field still gets a row per option');
});

test('rows belonging to another field are never reused', () => {
  // The editor is showing something else: its rows are not this field's list.
  const other = snap(N('RootWebArea', 'x', [
    N('heading', 'Sex'), N('button', 'Add Value'),
    N('textbox', 'Label', [], { value: { value: 'Ethnicity' } }),
    N('textbox', 'Code', [], { value: { value: 'H' } }),
    N('textbox', 'Label', [], { value: { value: 'Hispanic' } }),
  ]));
  const steps = fieldSteps(other, fieldItem('Screening/Demographics/Sex'), 'Dropdown', false);
  assert.equal(steps.filter((s) => s.op === 'click').length, 2, 'both rows are added fresh');
});

// ── status is derived, never stored ─────────────────────────────────────────

test('visit windows must read as a pair, not a neighbouring count of 0', () => {
  const empty = snap(N('RootWebArea', 'x', [
    N('button', 'Baseline (Day 1)'), N('statictext', ' to '), N('cell', '0'),
  ]));
  const baseline: PlanItem = {
    id: 'Baseline (Day 1)', kind: 'visit',
    visit: { name: 'Baseline (Day 1)', window_start_day: 0, window_end_day: 0, forms: [] },
  };
  assert.equal(verify(empty, baseline, newFacts()).ok, false, 'empty "to" plus a document count of 0 is not a 0-day window');

  const filled = snap(N('RootWebArea', 'x', [
    N('button', 'Baseline (Day 1)'), N('statictext', '0 to 0'), N('cell', '0'),
  ]));
  assert.equal(verify(filled, baseline, newFacts()).ok, true);
});

test('a filled visit window pair reads back after punctuation is stripped', () => {
  const page = snap(N('RootWebArea', 'x', [
    N('button', 'Screening'), N('statictext', '-28 to -1'), N('cell', '0'),
  ]));
  assert.equal(verify(page, item('Screening'), newFacts()).ok, true);
});

test('one escalated field escalates its form and its visit', () => {
  const l = new Ledger();
  l.escalated(item('Screening/Demographics/Sex'), 'type:single_select');
  const tree = statusTree(IR, l);
  assert.equal(tree[0].status, 'escalated');
  assert.equal(tree[0].children.find((c) => c.label === 'Demographics')!.status, 'escalated');
});

test('status recomputes from the ledger with no stored state', () => {
  const l = new Ledger();
  assert.equal(statusTree(IR, l)[0].status, 'not-reached');
  for (const p of PLAN) l.built(p, {});
  assert.equal(statusTree(IR, l)[0].status, 'complete', 'the same tree, recomputed, cannot drift');
});

// ── the gate queue collapses correlated failures ────────────────────────────

test('a card only offers buttons when the loop reads the answer back', () => {
  // The type answer is cached as a fact and consulted by ensureType. A
  // read-back failure is not, so buttons there would look answered and change
  // nothing on Resume.
  assert.equal(explain('type:integer').kind, 'choice');
  assert.equal(explain('field.options').kind, 'report');
  assert.equal(explain('write:field').kind, 'report');

  // The other three the loop reads back under the same key the card writes:
  // ensureAdd reads add:<kind>, commitStep reads commit, ensureContextRobust
  // reads context:<segment>. If one of these stops being consulted, its card
  // must stop offering buttons on the same commit.
  assert.equal(explain('add:visit').kind, 'choice');
  assert.equal(explain('commit').kind, 'choice');
  assert.equal(explain('context:Screening').kind, 'choice');

  const q = new Map();
  const p = PLAN.find((x) => x.kind === 'field')!;
  const choices = [{ ref: 1, name: 'Number (Whole)' }];
  escalate(q, 'type:integer', 'What is an integer?', p, [], choices);
  escalate(q, 'field.options', 'Codes missing', p, [], choices);
  assert.equal(q.get('type:integer')!.choices.length, 1);
  assert.equal(q.get('field.options')!.choices.length, 0, 'a report card must not offer a dead button');
});

test('every signature the loop can raise explains itself', () => {
  for (const sig of ['type:integer', 'add:field', 'editor:form', 'write:field', 'rejected:visit',
                     'context:Screening', 'commit', 'unbuilt:field', 'unverified:x/y/z', 'identity', 'study.anchor',
                     'visit.window', 'form.repeating', 'field.options', 'field.range', 'field.skiplogic',
                     'field.detail:decimal']) {
    const { reason } = explain(sig);
    assert.ok(reason.length > 20, `${sig} has no readable reason`);
    assert.ok(!reason.includes('undefined'), `${sig} leaked undefined into its reason`);
  }
});

test('N fields failing one question produce one card, not N', () => {
  const q = new Map();
  for (const p of PLAN.filter((x) => x.kind === 'field')) escalate(q, 'type:single_select', 'What is a single-select?', p, ['tried the library'], []);
  assert.equal(q.size, 1);
  assert.ok(q.get('type:single_select')!.items.length > 1, 'every affected item is listed on the one card');
});

// ── skip logic: three controls, and a check that can actually fail ──────────
//
// A conditional field shipped unbuilt and unescalated on every platform tried,
// because the rule was verified by searching the page's TEXT for the
// controlling field's label and the value. Both are always there: the
// controlling field sits on the same canvas, and a value like "No" is inside
// half the words on any screen. These pin the rule to the controls that hold it.

const COND = parseIR(JSON.stringify({
  ir_version: '1.0',
  study: { protocol_id: 'ABC-101', title: 'A Study of Things' },
  visits: [{
    name: 'V1', window_start_day: 0, window_end_day: 0,
    forms: [{ name: 'F1', repeating: false, fields: [
      { label: 'Ongoing', type: 'boolean', required: false },
      { label: 'Stop Date', type: 'date', required: false, skip_logic: { when_field_label: 'Ongoing', equals_value: 'No' } },
    ] }],
  }],
}));
const condItem = planItems(COND).find((p) => p.id === 'V1/F1/Stop Date')!;
const val = (v: string) => ({ value: { value: v } });

/** The canvas: both fields present, the controlling one's label as page text. */
const canvas = () => [
  N('heading', 'Ongoing'),
  N('heading', 'Stop Date'),
  N('paragraph', 'No values defined.'),
];

test('a rule that is only page text does not count as wired', () => {
  // Everything a text search looks for is here — "Ongoing" and "No" — and the
  // rule is not set on anything. This is the exact page that shipped green.
  const page = snap(N('RootWebArea', 'x', [
    ...canvas(),
    N('textbox', 'Label', [], val('Stop Date')),
    N('combobox', 'Visibility', [N('option', 'Visible'), N('option', 'Visible When…')], val('Visible')),
  ]));
  const v = verify(page, condItem, newFacts());
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.signature, 'field.skiplogic');
});

test('a rule reads back only from the controls that hold it', () => {
  const page = snap(N('RootWebArea', 'x', [
    ...canvas(),
    N('textbox', 'Label', [], val('Stop Date')),
    N('combobox', 'Visibility', [N('option', 'Visible'), N('option', 'Visible When…')], val('Visible When…')),
    N('combobox', 'When Element', [], val('Ongoing')),
    N('textbox', 'Equals Value', [], val('No')),
  ]));
  assert.equal(verify(page, condItem, newFacts()).ok, true);
});

test('a rule pointing at the wrong field is not wired', () => {
  const page = snap(N('RootWebArea', 'x', [
    ...canvas(),
    N('textbox', 'Label', [], val('Stop Date')),
    N('combobox', 'When Element', [], val('Something Else')),
    N('textbox', 'Equals Value', [], val('No')),
  ]));
  assert.equal(verify(page, condItem, newFacts()).ok, false);
});

test('wiring a rule is three writes, and the conditional option is read off the control', () => {
  const editor = snap(N('RootWebArea', 'x', [
    ...canvas(),
    N('textbox', 'Label', [], val('Stop Date')),
    N('combobox', 'Visibility', [N('option', 'Visible'), N('option', 'Visible When…')], val('Visible')),
  ]));
  const steps = fieldSteps(editor, condItem as Extract<PlanItem, { kind: 'field' }>, 'Date', false);
  const rule = steps.filter((s) => s.why === 'V1/F1/Stop Date' && s.arg !== 'Stop Date');
  assert.deepEqual(rule.map((s) => [s.op, s.arg]), [
    ['choose', 'Visible When…'],   // the platform's own wording, not a guess
    ['choose', 'Ongoing'],
    ['type', 'No'],
  ]);
});

test('no mode control on screen emits no rule steps, so verify escalates it', () => {
  const bare = snap(N('RootWebArea', 'x', [...canvas(), N('textbox', 'Label', [], val('Stop Date'))]));
  const steps = fieldSteps(bare, condItem as Extract<PlanItem, { kind: 'field' }>, 'Date', false);
  assert.equal(steps.filter((s) => s.op === 'choose').length, 0);
  assert.equal(verify(bare, condItem, newFacts()).ok, false);
});

// ---------------------------------------------------------------------------
// The model fallback for "which control does X" — asked only once heuristics
// give up, and only ever trusted after the same independent checks a
// deterministic guess would have to pass.
// ---------------------------------------------------------------------------

/** A fake askModel: no network, so the fallback's own logic runs in milliseconds. */
const fakeAsk = (reply: { ref: number; label: string; confidence: number } | 'reject'): NonNullable<Session['ask']> =>
  async (_snap, questions, _facts) => {
    const key = questions[0].key;
    if (reply === 'reject') return { ok: [], rejected: [{ key, why: 'confidence 0.4 < 0.7' }], tokens: 3 };
    return { ok: [{ key, ref: reply.ref, label: reply.label, confidence: reply.confidence, why: 'because' }], rejected: [], tokens: 12 };
  };

test('hierarchy scoping: the right vocabulary finds the right control, the wrong one finds the wrong one', async () => {
  const root = N('main', 'Visit Schedule', [
    N('heading', 'Visit Schedule'),
    N('button', 'Add Visit'),
    N('button', 'Add Form'),
  ]);
  const schedule = snap(root);
  const visitRef = schedule.compact.find((c) => c.name === 'Add Visit')!.ref;
  const formRef = schedule.compact.find((c) => c.name === 'Add Form')!.ref;

  const forVisit = await ensureAdd(newSession(1, 'https://x', IR), schedule, 'visit', V.addVisit, 'Baseline');
  assert.equal(forVisit?.source, 'synonym');
  assert.equal(locate(schedule, forVisit!.target), visitRef);

  const forForm = await ensureAdd(newSession(1, 'https://x', IR), schedule, 'form', V.addForm, 'Demographics');
  assert.equal(forForm?.source, 'synonym');
  assert.equal(locate(schedule, forForm!.target), formRef);

  // Asking for a visit with the *form* vocabulary is what buildItem must never
  // do — this pins why: it finds a real control, just the wrong one.
  const misScoped = await ensureAdd(newSession(1, 'https://x', IR), schedule, 'visit', V.addForm, 'Baseline');
  assert.equal(locate(schedule, misScoped!.target), formRef);
});

/** Two nameless actions in the content area: the structural pass abstains, so the model is asked. */
const twoGlyphs = () => snap(N('main', 'Visit Schedule', [
  N('heading', 'Visit Schedule'), N('button', '⊕'), N('button', '⤢'),
]));

test('the one action in the content area is the add control, whatever it is called', async () => {
  // "Define Assessment Point" shares no word with "Add Visit", and site chrome
  // is not a candidate: the page's own landmarks say which is which.
  const page = snap(N('body', undefined, [
    N('banner', undefined, [N('navigation', 'Modules', [N('button', 'Subjects'), N('button', 'Exports')])]),
    N('main', undefined, [N('heading', 'Assessment Schedule'), N('button', 'Define Assessment Point')]),
  ]));
  const s = newSession(1, 'https://x', IR);
  s.ask = fakeAsk('reject'); // must not be needed
  const resolved = await ensureAdd(s, page, 'visit', V.addVisit, 'Baseline');
  assert.deepEqual(resolved?.target, { role: 'button', name: 'Define Assessment Point' });
  assert.equal(resolved?.source, 'synonym');
});

test('two possible actions in the content area is a guess, so the structural pass abstains', async () => {
  const s = newSession(1, 'https://x', IR);
  s.ask = fakeAsk('reject');
  assert.equal(await ensureAdd(s, twoGlyphs(), 'visit', V.addVisit, 'Baseline'), null);
});

test('an add control with no vocabulary match at all falls to the model, not to escalation', async () => {
  const onlyIcon = twoGlyphs();
  const iconRef = onlyIcon.compact.find((c) => c.name === '⊕')!.ref;

  const s = newSession(1, 'https://x', IR);
  s.ask = fakeAsk({ ref: iconRef, label: 'Add Visit (the model\'s guess at what the glyph means)', confidence: 0.9 });

  const resolved = await ensureAdd(s, onlyIcon, 'visit', V.addVisit, 'Baseline');
  assert.equal(resolved?.source, 'llm');
  // The real accessible name is trusted, never the model's prose claim about it.
  assert.deepEqual(resolved?.target, { role: 'button', name: '⊕' });
});

test('a hallucinated ref from the model fallback is refused, never clicked', async () => {
  const onlyIcon = twoGlyphs();
  const s = newSession(1, 'https://x', IR);
  s.ask = fakeAsk({ ref: 999999, label: 'Add Visit', confidence: 0.95 });

  const resolved = await ensureAdd(s, onlyIcon, 'visit', V.addVisit, 'Baseline');
  assert.equal(resolved, null);
});

test('a sub-threshold answer from the model fallback escalates rather than guessing', async () => {
  const onlyIcon = twoGlyphs();
  const s = newSession(1, 'https://x', IR);
  s.ask = fakeAsk('reject');

  const resolved = await ensureAdd(s, onlyIcon, 'visit', V.addVisit, 'Baseline');
  assert.equal(resolved, null);
});

test('the model fallback is asked at most once per question per session', async () => {
  const onlyIcon = twoGlyphs();
  const iconRef = onlyIcon.compact.find((c) => c.name === '⊕')!.ref;
  const s = newSession(1, 'https://x', IR);

  let calls = 0;
  s.ask = async (snapArg, questions, facts) => { calls++; return fakeAsk({ ref: iconRef, label: 'x', confidence: 0.9 })(snapArg, questions, facts); };

  const first = await askControl(s, onlyIcon, 'add:visit', 'Which control adds a visit?');
  const second = await askControl(s, onlyIcon, 'add:visit', 'Which control adds a visit?');
  assert.notEqual(first, null);
  assert.equal(second, null); // already asked this session — the second call must not spend another one
  assert.equal(calls, 1);
});

test('a filled editor that was never saved does not verify as built', () => {
  // The draft echoes its own content as a text node inside the box holding it.
  // Counting that echo is how a run reported fourteen visits built while the
  // platform held none.
  const draft = snap(N('RootWebArea', 'x', [
    N('main', undefined, [
      N('heading', 'Assessment Schedule', [], props(['level', 2])),
      N('textbox', 'Assessment Point Name', [N('statictext', 'Screening')], { value: { value: 'Screening' } }),
      N('textbox', 'Earliest day', [N('statictext', '-28')], { value: { value: '-28' } }),
      N('textbox', 'Latest day', [N('statictext', '-1')], { value: { value: '-1' } }),
      N('button', 'Store'),
    ]),
  ]));
  const item = PLAN.find((p) => p.kind === 'visit')!;
  const before = verify(draft, item, newFacts());
  assert.equal(before.ok, false);
  assert.match((before as { missing: string[] }).missing[0], /no element named/);

  // The same name, once the platform is showing it in its own list, is a build.
  const saved = snap(N('RootWebArea', 'x', [
    N('main', undefined, [
      N('heading', 'Assessment Schedule', [], props(['level', 2])),
        N('listbox', undefined, [N('option', 'Screening -28 … -1', [N('statictext', 'Screening'), N('statictext', '-28 … -1')])]),
    ]),
  ]));
  assert.equal(verify(saved, item, newFacts()).ok, true);
});

test('a designer with no option rows takes the coded values through its bulk box', () => {
  const f = { label: 'Sex', type: 'single_select' as const, required: false,
              options: [{ code: 'M', label: 'Male' }, { code: 'F', label: 'Female' }] };
  const bulkOnly = snap(N('RootWebArea', 'x', [
    N('main', undefined, [
      N('textbox', 'Question Text', [], { value: { value: 'Sex' } }),
      N('textbox', 'Paste values'),
    ]),
  ]));
  const steps = fieldSteps(bulkOnly, { id: 'V/F/Sex', kind: 'field', visit: 'V', form: 'F', field: f }, 'Combo', false);
  const bulk = steps.find((s) => s.arg?.includes('M=Male'));
  assert.ok(bulk, 'the pairs must go in as pairs, not as labels');
  assert.equal(bulk!.arg, 'M=Male\nF=Female');

  // A designer that does have rows must not use the bulk path — bulk tends to
  // replace, and replacing a half-filled list loses what is already there.
  const withRows = snap(N('RootWebArea', 'x', [
    N('main', undefined, [
      N('textbox', 'Question Text', [], { value: { value: 'Sex' } }),
      N('button', 'Add option'),
      N('textbox', 'Paste values'),
    ]),
  ]));
  const rowSteps = fieldSteps(withRows, { id: 'V/F/Sex', kind: 'field', visit: 'V', form: 'F', field: f }, 'Combo', false);
  assert.equal(rowSteps.some((s) => s.arg?.includes('M=Male')), false);
  assert.equal(rowSteps.filter((s) => s.arg === 'M').length, 1);
});

test('a screen that adds forms is not asked which control adds a visit', async () => {
  // Both fallbacks answer "which control adds something here". On a screen
  // listing a visit's forms the only answer is "Add Source Record", and taking
  // it builds the next visit as a form inside the previous one.
  const insideVisit = snap(N('RootWebArea', 'x', [
    N('main', undefined, [
      N('button', '← Up one level'),
      N('heading', 'Screening — Source Records', [], props(['level', 2])),
      N('button', 'Add Source Record'),
    ]),
  ]));
  const s = newSession(1, 'https://x', IR);
  s.ask = fakeAsk('reject');
  assert.equal(await ensureAdd(s, insideVisit, 'visit', V.addVisit, 'Week 4'), null);
  // The same screen answers the question it can answer.
  const forForm = await ensureAdd(newSession(1, 'https://x', IR), insideVisit, 'form', V.addForm, 'Registration');
  assert.equal(locate(insideVisit, forForm!.target), insideVisit.compact.find((c) => c.name === 'Add Source Record')!.ref);
});

test('the model does not get to overrule what a library entry plainly says', async () => {
  // "Select One" and "Select One (Expanded)" are the pair a platform plants to
  // be confused, and a confident model picks the first. The same acceptance
  // rule the synonym pass lives by applies to the model's answer.
  const library = ['Select One', 'Select One (Expanded)', 'Free Text'];
  const page = snap(N('main', 'Designer', library.map((n) => N('button', n))));
  const ask = (label: string) => async () => ({
    ok: [{ key: 'type:radio', ref: page.compact.find((c) => c.name === label)!.ref, label, confidence: 0.95, why: 'looks right' }],
    rejected: [], tokens: 0,
  });

  const wrong = newSession(1, 'https://x', IR);
  wrong.ask = ask('Select One') as never;
  assert.equal(await askType(wrong, page, 'radio', library), null, 'an entry that reads as single_select is not a radio');
  assert.match(wrong.facts.get('asked:type:radio')!.why!, /what this platform calls a single_select/);

  // An entry that reads as nothing in particular is exactly what only the model
  // can settle, so it is still accepted.
  const ok = newSession(1, 'https://x', IR);
  ok.ask = ask('Select One (Expanded)') as never;
  assert.deepEqual(await askType(ok, page, 'radio', library), { label: 'Select One (Expanded)' });
});

test('a bulk-paste box is not counted as a coded-value column', () => {
  // "Import list (overwrites the code list)" reads as a code column, and
  // counting it shifts every row by one: codes land beside the wrong labels,
  // which is worse than not entering them at all.
  const f = { label: 'Sex', type: 'radio' as const, required: false,
              options: [{ code: 'F', label: 'Female' }, { code: 'M', label: 'Male' }] };
  const editor = snap(N('RootWebArea', 'x', [
    N('main', undefined, [
      N('textbox', 'Item Caption', [], { value: { value: 'Sex' } }),
      N('button', '+ Add Code'),
      N('textbox', 'Stored Code'), N('textbox', 'Display Text'),
      N('textbox', 'Stored Code'), N('textbox', 'Display Text'),
      N('textbox', 'Import list (overwrites the code list)'),
    ]),
  ]));
  const steps = fieldSteps(editor, { id: 'V/F/Sex', kind: 'field', visit: 'V', form: 'F', field: f }, 'Option Group', false);
  const codes = steps.filter((s) => s.target.nameAny === V.optionCode);
  assert.equal(codes.length, 2);
  // Two rows already on screen and two wanted, so nothing is appended.
  assert.equal(steps.filter((s) => s.op === 'click' && s.target.nameAny === V.addOption).length, 0);
  // The paste box reads as a code column and must not be addressed as a row:
  // with it counted, nth -2/-1 lands on the second row and the paste box, and
  // the first row keeps an empty code.
  assert.equal(candidates(editor, { role: 'textbox', nameAny: V.optionCode }).length, 3);
  assert.equal(candidates(editor, { role: 'textbox', nameAny: V.optionCode, excludeAny: V.bulkOption }).length, 2);
  assert.deepEqual(codes.map((s) => s.target.nth), [-2, -1]);
  for (const c of codes) assert.equal(c.target.excludeAny, V.bulkOption);
});
