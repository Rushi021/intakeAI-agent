/** Hand-built accessibility trees, so every pure check runs with no browser. */
import { compactFrom, type AXNode, type Snapshot } from '../src/perceive.ts';

let id = 0;
const all = new Map<string, AXNode>();

export const N = (role: string, name?: string, kids: AXNode[] = [], extra: Partial<AXNode> = {}): AXNode => {
  const self: AXNode = {
    nodeId: `ax${++id}`,
    backendDOMNodeId: id,
    role: { value: role },
    name: name === undefined ? undefined : { value: name },
    childIds: kids.map((k) => k.nodeId),
    ...extra,
  };
  for (const k of kids) k.parentId = self.nodeId;
  all.set(self.nodeId, self);
  return self;
};

export const props = (...pairs: [string, unknown][]): Partial<AXNode> => ({
  properties: pairs.map(([name, value]) => ({ name, value: { value } })),
});

export const flat = (n: AXNode, acc: AXNode[] = []): AXNode[] => {
  acc.push(n);
  for (const k of n.childIds ?? []) {
    const kid = all.get(k);
    if (kid) flat(kid, acc);
  }
  return acc;
};

const boxes = new Map<number, [number, number, number, number]>();

export function snap(root: AXNode, url = 'https://esource.example/build', title = 'Study'): Snapshot {
  const nodes = flat(root);
  const { byAxId, byRef, compact } = compactFrom(nodes, boxes);
  return {
    url,
    title,
    compact,
    settled: { quiet: true, polls: 2, ms: 30, inflight: 0, maxGapMs: 120, ceilingMs: 2500 },
    full: { byAxId, byRef, bbox: boxes },
  };
}
