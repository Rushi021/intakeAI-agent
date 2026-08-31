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
