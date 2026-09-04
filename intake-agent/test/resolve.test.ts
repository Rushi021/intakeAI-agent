/**
 * The near-neighbour failure the brief calls the most common way a build looks
 * finished and is not: a list-of-choices control and a single tick-box sitting
 * one row apart with almost the same name.
 *
 * The scorer is not what makes this safe — the acceptance rule is, and its most
 * important behaviour is refusing to answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveType, score, bestCanonical, discoverLibrary, validate, commitCandidates, MIN_CONFIDENCE } from '../src/resolve.ts';
import { N, snap } from './helpers.ts';

const LIBRARY_A = ['Text', 'Text Area', 'Number', 'Decimal', 'Date', 'Time', 'Date Time',
                   'Yes/No', 'Dropdown', 'Check List', 'Radio Group', 'Checkbox', 'Calculated'];
// Same library, a different but equally plausible vocabulary.
const LIBRARY_B = ['Short Text', 'Long Text', 'Whole Number', 'Decimal', 'Date Picker', 'Time Picker',
                   'Timestamp', 'Y-N Switch', 'Picklist', 'Multi Picklist', 'Option Group', 'Tick Box', 'Derived'];

test('the near-neighbour pair resolves correctly in both vocabularies', () => {
  for (const lib of [LIBRARY_A, LIBRARY_B]) {
    const multi = resolveType('multi_select', lib);
    const single_box = resolveType('checkbox', lib);
    assert.ok('label' in multi, `multi_select unresolved in ${lib[9]}`);
    assert.ok('label' in single_box, `checkbox unresolved in ${lib[11]}`);
    assert.notEqual((multi as { label: string }).label, (single_box as { label: string }).label);
  }
});

test('a single_select resolves without ever naming a mock', () => {
  assert.equal((resolveType('single_select', LIBRARY_A) as { label: string }).label, 'Dropdown');
  assert.equal((resolveType('single_select', LIBRARY_B) as { label: string }).label, 'Picklist');
});

test('abstention is the feature: a tie refuses rather than guesses', () => {
  // Two entries that both read exactly as a single-select. The platform knows
  // how they differ; the agent cannot, so guessing here is the expensive failure.
  const r = resolveType('single_select', ['Dropdown', 'Picklist']);
  assert.ok('abstain' in r, 'a tie must fall through to a human, not pick one');
});

test('a clear runner-up is not a tie — "Select" beside "Multi Select" resolves', () => {
  // Worth pinning: these are adjacent and similar, but "Select" is a whole-name
  // hit and "Multi Select" is only a word hit, so the margin rule is satisfied
  // and abstaining here would send a resolvable question to a human.
  assert.equal((resolveType('single_select', ['Select', 'Multi Select']) as { label: string }).label, 'Select');
  assert.equal((resolveType('multi_select', ['Select', 'Multi Select']) as { label: string }).label, 'Multi Select');
});

test('a label that reads as another type is refused even when it scores', () => {
  // "Checkbox" contains no multi_select synonym, but guard the reverse direction:
  // the winner's own best canonical has to be the one being asked for.
  const r = resolveType('multi_select', ['Checkbox']);
  assert.ok('abstain' in r);
});

test('scoring ranks exact over word over substring', () => {
  assert.equal(score('Dropdown', 'single_select'), 3);
  assert.equal(score('Dropdown List', 'single_select'), 2);
  assert.equal(score('Superdropdown', 'single_select'), 1);
  assert.equal(score('Attachment', 'single_select'), 0);
});

test('bestCanonical abstains when a label reads as two things equally', () => {
  assert.equal(bestCanonical('Sparkle'), null);
  assert.equal(bestCanonical('Tick Box'), 'checkbox');
});

test('the element library is discovered, not told', () => {
  const lib = N('RootWebArea', 'Designer', [
    N('list', 'Elements', LIBRARY_A.map((l) => N('listitem', l))),
    N('heading', 'Demographics'),
  ]);
  const found = discoverLibrary(snap(lib), new Set(['demographics', 'sex']));
  assert.ok(found, 'a cluster where most of the vocabulary resolves is the library');
  assert.ok(found!.labels.includes('Dropdown'));
});

test('study content is not mistaken for an element library', () => {
  const fields = ['Sex', 'Date of Birth', 'Race', 'Ethnicity', 'Weight', 'Height'];
  const page = N('RootWebArea', 'Demographics', [N('list', 'Fields', fields.map((f) => N('listitem', f)))]);
  assert.equal(discoverLibrary(snap(page), new Set(fields.map((f) => f.toLowerCase()))), null);
});

test('model output is untrusted: a hallucinated ref never becomes a click', () => {
  const s = snap(N('RootWebArea', 'x', [N('button', 'Add Field')]));
  const { ok, rejected } = validate(s, JSON.stringify({ decisions: [{ key: 'type:text', ref: 99999, label: 'Text', confidence: 0.99, why: '' }] }));
  assert.equal(ok.length, 0);
  assert.match(rejected[0].why, /not on the page/);
});

test('a sub-threshold confidence escalates rather than building', () => {
  const s = snap(N('RootWebArea', 'x', [N('button', 'Add Field')]));
  const ref = s.compact.find((c) => c.role === 'button')!.ref;
  const low = validate(s, JSON.stringify({ decisions: [{ key: 'k', ref, label: 'Text', confidence: MIN_CONFIDENCE - 0.01, why: '' }] }));
  const high = validate(s, JSON.stringify({ decisions: [{ key: 'k', ref, label: 'Text', confidence: MIN_CONFIDENCE, why: '' }] }));
  assert.equal(low.ok.length, 0);
  assert.equal(high.ok.length, 1);
});

test('non-JSON from the model is a rejection, not a crash', () => {
  const s = snap(N('RootWebArea', 'x', [N('button', 'x')]));
  assert.equal(validate(s, 'I think you should click Save!').ok.length, 0);
});

test('Create is a commit verb, and Create New Version is a decoy', () => {
  const s = snap(N('RootWebArea', 'x', [N('button', 'Create New Version'), N('button', 'Create')]));
  assert.equal(commitCandidates(s)[0].name, 'Create');
  assert.equal(commitCandidates(s)[0].decoy, false);
});

test('a control that looks like Save and is not ranks below the real one', () => {
  const s = snap(N('RootWebArea', 'x', [N('button', 'Save As Template'), N('button', 'Save')]));
  assert.equal(commitCandidates(s)[0].name, 'Save');
  assert.equal(commitCandidates(s)[0].decoy, false);
});

test('a word that closes an editor ranks below one that unambiguously saves', () => {
  // "Done" dismisses an inspector on one designer and commits on another.
  // Preferring it over a real Save looks like success and stores nothing.
  const s = snap(N('RootWebArea', 'x', [
    N('button', 'Done'),
    N('button', 'Save As Template'),
    N('button', 'Commit Sheet'),
  ]));
  const ranked = commitCandidates(s);
  assert.deepEqual(ranked.map((c) => c.name), ['Commit Sheet', 'Done', 'Save As Template']);
  assert.equal(ranked[0].weak, false);
  assert.equal(ranked[1].weak, true);
  assert.equal(ranked[2].decoy, true);
});

test('a tie is broken by which label the library itself is undecided over', () => {
  // Both score on "number" for integer. Only one of them also reads as a
  // decimal, and that one is the ambiguous half of the pair.
  assert.deepEqual(resolveType('integer', ['Number (Decimal)', 'Number (Whole)', 'Free Text']),
    { label: 'Number (Whole)' });
  assert.deepEqual(resolveType('decimal', ['Number (Decimal)', 'Number (Whole)', 'Free Text']),
    { label: 'Number (Decimal)' });
  assert.deepEqual(resolveType('integer', ['Numeric (Integer)', 'Numeric (Fractional)']),
    { label: 'Numeric (Integer)' });

  // A real tie — two labels that read equally well and neither ambiguously —
  // still abstains. The rule breaks ties by ambiguity; it does not invent one.
  assert.ok('abstain' in resolveType('integer', ['Number', 'Numeric']));

  // And the near-neighbour pair the brief warns about is still refused, because
  // neither entry reads as a radio at all.
  assert.ok('abstain' in resolveType('radio', ['Select One', 'Select One (Expanded)']));
  assert.deepEqual(resolveType('single_select', ['Select One', 'Select One (Expanded)']), { label: 'Select One' });
});
