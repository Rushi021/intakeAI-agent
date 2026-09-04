import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseIR, stats, orderFields, recurring } from '../src/ir.ts';

/**
 * The three alternate study inputs, checked against the parser the agent
 * actually uses. They exist so a run can be exercised on more than one shape
 * of study, so the thing that must hold is that they are *valid* IRs with the
 * structure they claim: every skip-logic controller present in the same form,
 * every rule reachable once the fields are dependency-ordered, and the reuse
 * groups the fixture is supposed to pose.
 */

const DATA = new URL('../../intake-takehome-2/data/', import.meta.url);
const load = (name: string) => parseIR(readFileSync(new URL(`${name}.ir.json`, DATA), 'utf8'));

const EXPECTED = {
  'abc-101-study': { visits: 4, formAppearances: 28, distinctForms: 17, fields: 195, skipRules: 13, repeatingForms: 5 },
  test: { visits: 2, formAppearances: 4, distinctForms: 3, fields: 34, skipRules: 1, repeatingForms: 1 },
  test2: { visits: 5, formAppearances: 16, distinctForms: 5, fields: 84, skipRules: 23, repeatingForms: 0 },
  test3: { visits: 1, formAppearances: 4, distinctForms: 4, fields: 32, skipRules: 13, repeatingForms: 1 },
} as const;

for (const [name, counts] of Object.entries(EXPECTED)) {
  test(`${name}.ir.json parses with the counts it advertises`, () => {
    assert.deepEqual(stats(load(name)), counts);
  });

  test(`${name}.ir.json — every skip rule is buildable in dependency order`, () => {
    for (const visit of load(name).visits) {
      for (const form of visit.forms) {
        const where = `${visit.name}/${form.name}`;
        const labels = form.fields.map((f) => f.label);
        assert.equal(new Set(labels).size, labels.length, `duplicate field label in ${where}`);

        const placed = new Set<string>();
        for (const field of orderFields(form.fields)) {
          const dep = field.skip_logic?.when_field_label;
          if (dep) {
            assert.ok(labels.includes(dep), `${where}/${field.label} names a controller that is not in the form`);
            assert.ok(placed.has(dep), `${where}/${field.label} is ordered before its controller`);
          }
          placed.add(field.label);
        }
      }
    }
  });
}

test('test2 poses reuse and a name collision that is NOT reuse', () => {
  const ir = load('test2');
  const groups = [...recurring(ir).values()];
  assert.equal(groups.filter((g) => g.length > 1).length, 3, 'three definitions should recur across visits');

  // Two forms share the name "Hematology" and differ in content: keying by
  // name alone would wrongly reuse one for the other.
  const hematology = ir.visits.flatMap((v) => v.forms).filter((f) => f.name === 'Hematology');
  assert.equal(hematology.length, 2);
  assert.notEqual(hematology[0].fields.length, hematology[1].fields.length);
  assert.equal(recurring(ir).get([...recurring(ir).keys()].find((k) => k.startsWith('Hematology'))!)!.length, 1);
});

test('test.ir.json exercises all thirteen canonical types', () => {
  const types = new Set(load('test').visits.flatMap((v) => v.forms).flatMap((f) => f.fields).map((f) => f.type));
  assert.equal(types.size, 13);
});
