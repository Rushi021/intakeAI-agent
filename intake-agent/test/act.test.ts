/**
 * locate() is the inverse of a ref, and every fact, step and retry routes
 * through it. Its most important property is that it abstains: a wrong ref is a
 * click on the wrong control, which builds the wrong thing silently, while
 * "not found" escalates to a human.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, candidates, readBack, screenNames, isWayOut, inDesigner, NAV_ROLES } from '../src/act.ts';
import { N, props, snap } from './helpers.ts';

test('window start and end are distinct matches, and min/max do not stand in', () => {
  const s = snap(N('RootWebArea', 'x', [
    N('textbox', 'Visit Name'),
    N('textbox', 'Window Start (day)'),
    N('textbox', 'Window End (day)'),
  ]));
  assert.notEqual(locate(s, { role: 'textbox', nameAny: ['start'] }), null);
  assert.notEqual(locate(s, { role: 'textbox', nameAny: ['end'] }), null);
  assert.equal(locate(s, { role: 'textbox', nameAny: ['min', 'minimum', 'from'] }), null);
  assert.equal(locate(s, { role: 'textbox', nameAny: ['window'] }), null, 'a shared window word must abstain');
  assert.equal(candidates(s, { role: 'textbox', nameAny: ['window'] }).length, 2);
});

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

  const roster = snap(N('RootWebArea', 'x', [N('cell', 'Demographics'), N('button', 'Edit')]));
  assert.equal(screenNames(roster, 'Demographics'), false, 'a table cell is a list, not arrival');

  const designer = snap(N('RootWebArea', 'x', [N('statictext', 'Demographics'), N('button', 'Save')]));
  assert.equal(screenNames(designer, 'Demographics'), true, 'a unique title with no roster copy is arrival');
});

test('a write that re-renders its own control is read back, not failed', () => {
  // Mock A rebuilds the options panel when the visibility mode changes, so
  // every ref in it is new afterwards. Reading the old ref finds nothing, which
  // looks exactly like a rejected write — and silently escalated every
  // conditional field.
  const before = snap(N('RootWebArea', 'x', [N('combobox', 'Visibility', [], { value: { value: 'Visible' } })]));
  const ref = locate(before, { role: 'combobox', nameAny: ['visibility'] })!;
  const after = snap(N('RootWebArea', 'x', [N('combobox', 'Visibility', [], { value: { value: 'Visible When…' } })]));

  assert.equal(after.compact.some((c) => c.ref === ref), false, 'the ref must really be gone for this to test anything');
  const found = after.compact.find((c) => c.ref === locate(after, { role: 'combobox', nameAny: ['visibility'] })!);
  assert.equal(found?.value, 'Visible When…');
});

test('read-back follows a control through the re-render its own write caused', () => {
  // The defect this replaces: the write landed, the platform rebuilt the panel,
  // every ref in it was new, and looking up the old one found nothing — which
  // readBack reported as an empty value. Every conditional rule died here.
  const before = snap(N('RootWebArea', 'x', [N('combobox', 'Visibility', [], { value: { value: 'Visible' } })]));
  const ref = locate(before, { role: 'combobox', nameAny: ['visibility'] })!;
  const after = snap(N('RootWebArea', 'x', [N('combobox', 'Visibility', [], { value: { value: 'Visible When…' } })]));
  assert.equal(after.compact.some((c) => c.ref === ref), false, 'the ref must really be gone for this to test anything');

  const step = {
    target: { role: 'combobox', nameAny: ['visibility'] },
    op: 'choose' as const,
    arg: 'Visible When…',
    expect: { kind: 'value' as const, expect: 'Visible When…' },
  };
  assert.equal(readBack(after, ref, step, true).ok, true, 'the replacement carries the value that was written');
});

test('a control that is gone, and one that became ambiguous, do not read as empty', () => {
  const before = snap(N('RootWebArea', 'x', [N('textbox', 'Label')]));
  const ref = locate(before, { role: 'textbox', nameAny: ['label'] })!;
  const step = {
    target: { role: 'textbox', nameAny: ['label'] },
    op: 'type' as const,
    arg: 'Hematocrit',
    expect: { kind: 'value' as const, expect: 'Hematocrit' },
  };

  const gone = readBack(snap(N('RootWebArea', 'x', [N('button', 'Save')])), ref, step, true);
  assert.equal(gone.ok, false);
  assert.equal(gone.missing, true);
  assert.match(gone.reason!, /gone after the write/, 'never "read back \\"\\"" — that reads as a rejected write');

  const twins = snap(N('RootWebArea', 'x', [N('textbox', 'Label'), N('textbox', 'Label')]));
  const ambiguous = readBack(twins, ref, step, true);
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.reason!, /2 controls match/, 'ambiguity has a different cause and must say so');
});

test('a listbox pattern (role=option rows) is a navigable surface, like any other list', () => {
  // A platform never seen before that renders its visit/form list as a native
  // single-select listbox — role="listbox" over role="option" — rather than a
  // table, a card deck or a tree. Standard ARIA, not modelled on any known mock.
  const page = snap(N('RootWebArea', 'x', [
    N('listbox', 'Visits', [
      N('option', 'Intake Review'),
      N('option', 'Follow-up 1'),
    ]),
  ]));
  assert.equal(NAV_ROLES.includes('option'), true, 'without this, name-matched navigation cannot see a listbox pattern at all');
  const hit = candidates(page, { role: 'option', name: 'Intake Review' });
  assert.equal(hit.length, 1);
});

test('a card deck names every card, and that is not arrival', () => {
  // Each entry gets its own heading, so a screen listing four visits announces
  // all four. Believing it makes the agent build the visit's contents onto the
  // list of visits — an extra field in the wrong container, which the brief
  // penalises and nobody would notice.
  const deck = snap(N('RootWebArea', 'x', [
    N('main', undefined, [
      N('heading', 'Event Calendar', [], props(['level', 2])),
      N('heading', 'Screening', [], props(['level', 4])),
      N('heading', 'Week 4', [], props(['level', 4])),
    ]),
  ]));
  assert.equal(screenNames(deck, 'Screening'), false);
  assert.equal(screenNames(deck, 'Event Calendar'), true);

  const inside = snap(N('RootWebArea', 'x', [
    N('main', undefined, [N('heading', 'Screening — Data Sheets', [], props(['level', 2]))]),
  ]));
  assert.equal(screenNames(inside, 'Screening'), true);
});

test('a listbox row titles itself in a text node, and that is not arrival either', () => {
  const roster = snap(N('RootWebArea', 'x', [
    N('main', undefined, [
      N('heading', 'Screening — Source Records', [], props(['level', 2])),
      N('listbox', undefined, [
        N('option', 'Registration v1 · Under Construction', [
          N('statictext', 'Registration'),
          N('button', 'Open Designer'),
        ]),
      ]),
    ]),
  ]));
  assert.equal(screenNames(roster, 'Registration'), false, 'a row is not the screen it sits on');
});

test('a way back out is recognised by its arrow as well as by its word', () => {
  for (const name of ['← Return', '← Up one level', 'Back out', 'Cancel', 'Abandon']) {
    assert.equal(isWayOut(name), true, name);
  }
  for (const name of ['Attach Data Sheet', 'Add Source Record', 'Store Event', 'Commit Sheet']) {
    assert.equal(isWayOut(name), false, name);
  }
});

test('a roster of rows with the same three buttons is not a palette', () => {
  // Nine buttons at one depth, three names. Reading that as an element library
  // puts the agent in a designer it is not in, and it adds a field to a list of
  // forms.
  const roster = snap(N('RootWebArea', 'x', [
    N('main', undefined, [
      N('heading', 'Unscheduled — Source Documents', [], props(['level', 2])),
      ...[1, 2, 3].flatMap(() => [N('button', '✎ Edit'), N('button', 'Activate'), N('button', 'Delete')]),
      N('button', '+ New Source Document'),
    ]),
  ]));
  assert.equal(inDesigner(roster), false);

  const designer = snap(N('RootWebArea', 'x', [
    N('main', undefined, [
      N('heading', 'Question Types', [], props(['level', 3])),
      ...['Free Text', 'Long Text', 'Number', 'Decimal', 'Date', 'Time', 'Yes / No', 'Checkbox', 'Select One']
        .map((n) => N('button', n)),
    ]),
  ]));
  assert.equal(inDesigner(designer), true);
});
