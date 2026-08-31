/** The IR parser is a trust boundary: bad input must fail loudly, and the
 *  counts it reports are what the end-of-run recall check is measured against. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseIR, stats, skeleton } from '../src/ir.ts';

const PATH = new URL('../../intake-takehome-2/data/abc-101-study.ir.json', import.meta.url);

test('parses the real study to the counts data/README.md documents', () => {
  const ir = parseIR(readFileSync(PATH, 'utf8'));
  const s = stats(ir);
  assert.equal(s.visits, 4);
  assert.equal(s.formAppearances, 28);
  assert.equal(s.distinctForms, 17);
  assert.equal(s.fields, 195);
  assert.equal(s.skipRules, 13);
});

test('the model gets names, not 195 fields', () => {
  const ir = parseIR(readFileSync(PATH, 'utf8'));
  const json = JSON.stringify(skeleton(ir));
  assert.ok(!json.includes('Subject Initials'), 'field labels must not reach the planning prompt');
  assert.ok(json.includes('Demographics'));
  assert.ok(json.length < 4000, `skeleton is ${json.length} chars — too big for a planning prompt`);
});

test('malformed input is rejected, not half-accepted', () => {
  assert.throws(() => parseIR('{}'), /protocol_id/);
  assert.throws(() => parseIR('{"study":{"protocol_id":"X"},"visits":[]}'), /no visits/);
  assert.throws(
    () => parseIR('{"study":{"protocol_id":"X"},"visits":[{"name":"V","forms":[{"name":"F","fields":[{"label":"L","type":"dropdown"}]}]}]}'),
    /unknown type "dropdown"/,
  );
});
