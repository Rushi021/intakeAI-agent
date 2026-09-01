/**
 * The guarantee: every plan item ends built-and-verified or escalated-with-
 * context, never a third silent state. Plus the two places that guarantee is
 * easiest to break — presence mistaken for success, and a rerun trusting an
 * item it should have re-checked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Ledger, assertTerminated, identify, liveness, statusTree, verify, newSession, escalate,
} from '../src/run.ts';
import { newFacts } from '../src/resolve.ts';
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

// ── status is derived, never stored ─────────────────────────────────────────

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

test('N fields failing one question produce one card, not N', () => {
  const q = new Map();
  for (const p of PLAN.filter((x) => x.kind === 'field')) escalate(q, 'type:single_select', 'What is a single-select?', p, ['tried the library'], []);
  assert.equal(q.size, 1);
  assert.ok(q.get('type:single_select')!.items.length > 1, 'every affected item is listed on the one card');
});
