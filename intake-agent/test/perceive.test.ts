/**
 * The generalization check: two eSource platforms rendering the SAME screen
 * with different DOM, different nesting and different wording must produce the
 * same compact view of what a builder can act on. If this fails, the agent is
 * reading a platform rather than a page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactFrom, expandAround, dialogControls, type AXNode } from '../src/perceive.ts';

let id = 0;
const node = (role: string, name?: string, kids: AXNode[] = [], extra: Partial<AXNode> = {}): AXNode => {
  const self: AXNode = {
    nodeId: `ax${++id}`,
    backendDOMNodeId: id,
    role: { value: role },
    name: name === undefined ? undefined : { value: name },
    childIds: kids.map((k) => k.nodeId),
    ...extra,
  };
  for (const k of kids) k.parentId = self.nodeId;
  return self;
};
const flat = (n: AXNode, acc: AXNode[] = []): AXNode[] => {
  acc.push(n);
  for (const id of n.childIds ?? []) {
    const k = all.get(id);
    if (k) flat(k, acc);
  }
  return acc;
};
const all = new Map<string, AXNode>();
const reg = <T extends AXNode>(n: T): T => (all.set(n.nodeId, n), n);
const N = (...args: Parameters<typeof node>) => reg(node(...args));

// Mock A: table-based visit schedule, the shape the provided mock uses.
const mockA = N('RootWebArea', 'ABC-101 — eSource', [
  N('heading', 'Visit Schedule'),
  N('table', 'Visits', [
    N('row', '', [N('columnheader', 'Visit'), N('columnheader', 'Window')]),
  ]),
  N('button', '+ Add Visit'),
  N('StaticText', 'Study ABC-101'),
  N('generic', undefined, [N('generic', undefined, [N('link', 'Element Library')])]),
]);

// Mock B: same screen, div soup, list instead of table, deeper nesting,
// different chrome wording. The actionable surface is identical.
const mockB = N('RootWebArea', 'Protocol ABC-101 · StudyBuild', [
  N('generic', undefined, [
    N('generic', undefined, [
      N('heading', 'Visit Schedule'),
      N('list', 'Visits', [N('listitem', 'Visit'), N('listitem', 'Window')]),
      N('generic', undefined, [N('button', '+ Add Visit')]),
      N('StaticText', 'Study ABC-101'),
      N('link', 'Element Library'),
    ]),
  ]),
]);

const boxes = new Map<number, [number, number, number, number]>();
const actionable = (n: AXNode) =>
  compactFrom(flat(n), boxes)
    .compact.filter((c) => c.role === 'button' || c.role === 'link')
    .map((c) => `${c.role}:${c.name}`)
    .sort();

test('same screen, different DOM → same actionable surface', () => {
  assert.deepEqual(actionable(mockA), actionable(mockB));
  assert.deepEqual(actionable(mockA), ['button:+ Add Visit', 'link:Element Library']);
});

test('pruning drops layout noise but keeps context', () => {
  const { compact } = compactFrom(flat(mockB), boxes);
  assert.equal(compact.some((c) => c.role === 'generic'), false, 'generic wrappers are noise');
  assert.equal(compact.some((c) => c.role === 'heading' && c.name === 'Visit Schedule'), true);
  assert.equal(compact.some((c) => c.name === 'Study ABC-101'), true, 'study identity must survive pruning');
});

test('a pruned node is still retrievable by ref', () => {
  const nodes = flat(mockB);
  const { compact, byRef } = compactFrom(nodes, boxes);
  const snap = { compact, full: { byAxId: all, byRef, bbox: boxes } } as any;
  const button = compact.find((c) => c.role === 'button')!;
  const around = expandAround(snap, button.ref, 2);
  assert.ok(
    around.some((d) => d.role === 'generic'),
    'expand must return the wrapper the compact view deliberately dropped',
  );
});

test('dialog controls are scoped to the open dialog', () => {
  const outside = N('button', 'Save');
  const inside = N('button', 'Confirm');
  const dlg = N('dialog', 'Unsaved changes', [inside]);
  const root = N('RootWebArea', 'x', [outside, dlg]);
  const nodes = flat(root);
  const { compact, byRef } = compactFrom(nodes, boxes);
  const snap = { compact, full: { byAxId: all, byRef, bbox: boxes } } as any;
  const names = dialogControls(snap).map((d) => d.name);
  assert.ok(names.includes('Confirm'));
  assert.ok(!names.includes('Save'), 'a control outside the dialog is not a dialog control');
  assert.equal(compact.find((c) => c.name === 'Confirm')?.dialog, dlg.backendDOMNodeId);
});

test('iframe content is not dropped', () => {
  // getFullAXTree returns one parentless root per same-origin frame. Walking
  // only the first loses every form rendered inside a designer iframe.
  const main = N('RootWebArea', 'Study', [N('button', 'Add Visit')]);
  const framed = N('RootWebArea', 'Designer', [N('button', 'Add Element')]);
  const names = compactFrom([...flat(main), ...flat(framed)], boxes).compact.map((c) => c.name);
  assert.ok(names.includes('Add Visit'));
  assert.ok(names.includes('Add Element'), 'controls inside a second frame root must survive');
});

test('a modal dialog wins over a stale non-modal one', () => {
  const stale = N('dialog', 'Element Library', [N('button', 'Close')]);
  const modal = N('dialog', 'Discard changes?', [N('button', 'Discard')], {
    properties: [{ name: 'modal', value: { value: true } }],
  });
  // Document order puts the modal first — picking the last dialog would miss it.
  const root = N('RootWebArea', 'x', [modal, stale]);
  const nodes = flat(root);
  const { compact, byRef } = compactFrom(nodes, boxes);
  const snap = { compact, full: { byAxId: all, byRef, bbox: boxes } } as any;
  assert.deepEqual(dialogControls(snap).map((d) => d.name), ['Discard changes?', 'Discard']);
});

// ── comparison: one primitive, four readings of it ──────────────────────────

import { diff, classify, errorsIn, settle, toPrompt, activeDialog } from '../src/perceive.ts';
import { N as NN, props as P, snap as SNAP } from './helpers.ts';

test('an identical view produces an empty diff', () => {
  const s = SNAP(NN('RootWebArea', 'x', [NN('button', 'Save')]));
  const d = diff(s.compact, s.compact);
  assert.equal(d.added.length + d.removed.length + d.changed.length, 0);
});

test('a value change is a change, not an add plus a remove', () => {
  const before = SNAP(NN('RootWebArea', 'x', [NN('textbox', 'Label')]));
  const after = { ...before, compact: before.compact.map((c) => (c.role === 'textbox' ? { ...c, value: 'Sex' } : c)) };
  const d = diff(before.compact, after.compact);
  assert.equal(d.changed.length, 1);
  assert.equal(d.added.length + d.removed.length, 0);
});

test('a click that changes nothing is visible as an empty diff', () => {
  // The trap the brief names: a control that looks like Save and is not.
  const s = SNAP(NN('RootWebArea', 'x', [NN('button', 'Save As Template')]));
  assert.equal(classify(s, s), 'none');
});

test('classify separates navigation, an overlay and an in-page re-render', () => {
  const base = SNAP(NN('RootWebArea', 'x', [NN('button', 'Add Field')]));
  assert.equal(classify(base, { ...base, url: base.url + '/other' }), 'navigated');

  const withModal = SNAP(NN('RootWebArea', 'x', [NN('button', 'Add Field'), NN('dialog', 'New Field', [NN('button', 'OK')], P(['modal', true]))]));
  assert.equal(classify(base, withModal), 'overlay-opened');
  assert.equal(classify(withModal, base), 'overlay-closed');

  const renamed = { ...base, compact: base.compact.map((c) => ({ ...c, name: c.name === 'Add Field' ? 'Adding…' : c.name })) };
  assert.equal(classify(base, renamed), 'in-page');
});

test('a platform rejection is found, and is not a read-back failure', () => {
  const before = SNAP(NN('RootWebArea', 'x', [NN('textbox', 'Max')]));
  const after = SNAP(NN('RootWebArea', 'x', [NN('textbox', 'Max'), NN('alert', 'Range not allowed for this type')]));
  const found = errorsIn(diff(before.compact, after.compact), after);
  assert.equal(found.length, 1);
  assert.match(found[0].text, /Range not allowed/);
});

test('a control that gained aria-invalid is surfaced', () => {
  const before = SNAP(NN('RootWebArea', 'x', [NN('textbox', 'Weight')]));
  const after = { ...before, compact: before.compact.map((c) => (c.role === 'textbox' ? { ...c, state: ['invalid=true'] } : c)) };
  const found = errorsIn(diff(before.compact, after.compact), after);
  assert.equal(found[0]?.kind, 'invalid');
});

test('a clean write surfaces no error', () => {
  const before = SNAP(NN('RootWebArea', 'x', [NN('textbox', 'Label')]));
  const after = { ...before, compact: before.compact.map((c) => ({ ...c, value: 'Sex' })) };
  assert.deepEqual(errorsIn(diff(before.compact, after.compact), after), []);
});

test('the model sees only the modal that is blocking the user', () => {
  const s = SNAP(NN('RootWebArea', 'x', [
    NN('button', 'Delete Study'),
    NN('dialog', 'Add Field', [NN('button', 'Create')], P(['modal', true])),
  ]));
  const prompt = toPrompt(s);
  assert.ok(prompt.includes('Create'));
  assert.ok(!prompt.includes('Delete Study'), 'a control behind the modal must not be offerable');
  // Nothing is lost: it is still addressable by ref.
  assert.ok(s.compact.some((c) => c.name === 'Delete Study'));
  assert.notEqual(activeDialog(s), undefined);
});

// ── settling ────────────────────────────────────────────────────────────────

const scripted = (seq: { hash: string; inflight: number }[]) => {
  let i = 0;
  return async () => seq[Math.min(i++, seq.length - 1)];
};

test('settle waits for the tree to stop moving and the network to go quiet', async () => {
  const r = await settle({ quietMs: 0, timeoutMs: 500 }, scripted([
    { hash: 'a', inflight: 1 }, { hash: 'b', inflight: 0 }, { hash: 'b', inflight: 0 },
  ]));
  assert.equal(r.quiet, true);
});

test('a request still in flight is not quiet, however stable the tree', async () => {
  const r = await settle({ quietMs: 0, timeoutMs: 300 }, scripted([{ hash: 'a', inflight: 2 }]));
  assert.equal(r.quiet, false, 'a pending request is about to change the DOM');
});

test('a page that never settles returns a fact, not an exception', async () => {
  let n = 0;
  const r = await settle({ quietMs: 0, timeoutMs: 300 }, async () => ({ hash: `h${n++}`, inflight: 0 }));
  assert.equal(r.quiet, false);
  assert.ok(r.polls > 1);
  // The run continues and the ledger records it — an unsettled write is a
  // different failure from a wrong decision, and conflating them misleads the gate.
});
