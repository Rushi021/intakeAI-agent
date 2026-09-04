/** The IR parser is a trust boundary: bad input must fail loudly, and the
 *  counts it reports are what the end-of-run recall check is measured against. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseIR, stats, planItems, orderFields, formKey, recurring } from '../src/ir.ts';

const PATH = new URL('../../intake-takehome-2/data/abc-101-study.ir.json', import.meta.url);
const ir = parseIR(readFileSync(PATH, 'utf8'));

test('parses the real study to the counts data/README.md documents', () => {
  const ir = parseIR(readFileSync(PATH, 'utf8'));
  const s = stats(ir);
  assert.equal(s.visits, 4);
  assert.equal(s.formAppearances, 28);
  assert.equal(s.distinctForms, 17);
  assert.equal(s.fields, 195);
  assert.equal(s.skipRules, 13);
});

test('malformed input is rejected, not half-accepted', () => {
  assert.throws(() => parseIR('{}'), /protocol_id/);
  assert.throws(() => parseIR('{"study":{"protocol_id":"X"},"visits":[]}'), /no visits/);
  assert.throws(
    () => parseIR('{"study":{"protocol_id":"X"},"visits":[{"name":"V","forms":[{"name":"F","fields":[{"label":"L","type":"dropdown"}]}]}]}'),
    /unknown type "dropdown"/,
  );
});

// ── the plan ────────────────────────────────────────────────────────────────

test('the plan covers every visit, form and field, with unique ids', () => {
  const items = planItems(ir);
  const s = stats(ir);
  assert.equal(items.filter((i) => i.kind === 'visit').length, s.visits);
  assert.equal(items.filter((i) => i.kind === 'form').length, s.formAppearances);
  assert.equal(items.filter((i) => i.kind === 'field').length, s.fields);
  assert.equal(new Set(items.map((i) => i.id)).size, items.length, 'the id is the ledger key; collisions lose an item');
});

test('an item id round-trips to its entry in the input file', () => {
  const field = planItems(ir).find((i) => i.kind === 'field')!;
  const [visit, form, label] = field.id.split('/');
  const entry = ir.visits.find((v) => v.name === visit)!.forms.find((f) => f.name === form)!.fields.find((f) => f.label === label);
  assert.ok(entry, 'traceability is the id pointing at one IR entry, not a separate mechanism');
});

test('a skip-logic controller is always built before its dependent', () => {
  for (const v of ir.visits) {
    for (const f of v.forms) {
      const order = orderFields(f.fields).map((x) => x.label);
      for (const fl of f.fields) {
        if (!fl.skip_logic) continue;
        const controller = order.indexOf(fl.skip_logic.when_field_label);
        if (controller === -1) continue; // controller outside the form: escalated, not reordered
        assert.ok(controller < order.indexOf(fl.label), `${f.name}: ${fl.label} is built before its controller`);
      }
    }
  }
});

test('a skip-logic cycle emits every field rather than deadlocking', () => {
  const a = { label: 'A', type: 'text' as const, required: false, skip_logic: { when_field_label: 'B', equals_value: 'x' } };
  const b = { label: 'B', type: 'text' as const, required: false, skip_logic: { when_field_label: 'A', equals_value: 'y' } };
  assert.deepEqual(orderFields([a, b]).map((f) => f.label).sort(), ['A', 'B']);
});

test('formKey is key-order independent, and sensitive to a changed code', () => {
  const base = { name: 'Vitals', repeating: false, fields: [{ label: 'Sex', type: 'single_select' as const, required: true, options: [{ code: 'M', label: 'Male' }] }] };
  const reordered = { fields: base.fields.map((f) => ({ options: f.options, required: f.required, type: f.type, label: f.label })), repeating: false, name: 'Vitals' } as typeof base;
  assert.equal(formKey(base), formKey(reordered), 'JSON.stringify would differ here; the reuse decision must not');

  const changed = structuredClone(base);
  changed.fields[0].options![0].code = 'X';
  assert.notEqual(formKey(base), formKey(changed), 'a different stored code is a different form');
});

test('recurring finds the 17 definitions behind the 28 appearances', () => {
  const r = recurring(ir);
  assert.equal(r.size, stats(ir).distinctForms);
  assert.equal([...r.values()].reduce((a, o) => a + o.length, 0), stats(ir).formAppearances);
  assert.ok([...r.values()].some((o) => o.length === 4), 'Vital Signs appears at all four visits');
});
