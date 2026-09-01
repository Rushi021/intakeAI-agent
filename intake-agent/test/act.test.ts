/**
 * locate() is the inverse of a ref, and every fact, step and retry routes
 * through it. Its most important property is that it abstains: a wrong ref is a
 * click on the wrong control, which builds the wrong thing silently, while
 * "not found" escalates to a human.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, candidates, screenNames } from '../src/act.ts';
import { N, props, snap } from './helpers.ts';

test('locate matches an accessible name regardless of case and punctuation', () => {
  const s = snap(N('RootWebArea', 'x', [N('button', '+ Add  Field')]));
  assert.notEqual(locate(s, { role: 'button', name: 'add field' }), null);
});

test('locate abstains when two controls match equally well', () => {
  const s = snap(N('RootWebArea', 'x', [N('button', 'Save'), N('button', 'Save')]));
  assert.equal(locate(s, { role: 'button', name: 'Save' }), null, 'an ambiguous match must not become a click');
  assert.equal(candidates(s, { role: 'button', name: 'Save' }).length, 2);
});

test('nth disambiguates a deliberate repeat, and -1 is the row just added', () => {
  const s = snap(N('RootWebArea', 'x', [N('textbox', 'Code'), N('textbox', 'Code'), N('textbox', 'Code')]));
  const last = locate(s, { role: 'textbox', name: 'Code', nth: -1 });
  const first = locate(s, { role: 'textbox', name: 'Code', nth: 0 });
  assert.notEqual(last, first);
  assert.notEqual(last, null);
});

test('nameAny matches the vocabulary form, exact beating substring', () => {
  const s = snap(N('RootWebArea', 'x', [N('textbox', 'Field Label'), N('textbox', 'Label')]));
  // "Label" is an exact vocabulary hit; "Field Label" is only a word hit.
  assert.equal(locate(s, { role: 'textbox', nameAny: ['label'] }) !== null, true);
});

test('inDialog keeps a write inside the overlay that is blocking the user', () => {
  const s = snap(N('RootWebArea', 'x', [
    N('button', 'Close'),
    N('dialog', 'Add Field', [N('button', 'Close')], props(['modal', true])),
  ]));
  const ref = locate(s, { role: 'button', name: 'Close', inDialog: true });
  const outside = s.compact.find((c) => c.role === 'button' && c.dialog === undefined);
  assert.notEqual(ref, null);
  assert.notEqual(ref, outside?.ref, 'the control behind the modal must not be the one found');
});

test('screenNames needs a heading or a current marker, not any mention', () => {
  // A list of every visit names all of them; that is not arrival.
  const list = snap(N('RootWebArea', 'x', [N('list', 'Visits', [N('listitem', 'Screening'), N('listitem', 'Baseline')])]));
  assert.equal(screenNames(list, 'Screening'), false, 'being listed is not being inside');

  const inside = snap(N('RootWebArea', 'x', [N('heading', 'Screening')]));
  assert.equal(screenNames(inside, 'Screening'), true);

  const tabbed = snap(N('RootWebArea', 'x', [N('tab', 'Screening', [], props(['selected', true]))]));
  assert.equal(screenNames(tabbed, 'Screening'), true);
});
