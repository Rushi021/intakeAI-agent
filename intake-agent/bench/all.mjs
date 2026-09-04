import { lane, OUT } from './lane.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The generalization matrix: every platform × every study input, no code
 * changes to either side. Lane names are `<platform>-<input>` so a lane is
 * addressable without a lookup table, and adding a surface or a fixture is one
 * entry here rather than a new lane definition.
 */
const M = 'http://localhost:5173';
export const PLATFORMS = {
  mockA:      `${M}/`,
  veridian:   `${M}/platform.html?surface=test`,
  trialforge: `${M}/platform.html?surface=test2`,
  sourceone:  `${M}/platform.html?surface=test3`,
};
export const INPUTS = {
  smoke:  'test.ir.json',    // all 13 canonical types, 34 fields
  struct: 'test2.ir.json',   // recurrence, bottom-up skip logic, name collisions
  awkward:'test3.ir.json',   // 28-value code list, non-ASCII, negative ranges
  full:   'abc-101-study.ir.json', // the supplied study, 195 fields
};

export const LANES = Object.fromEntries(
  Object.entries(PLATFORMS).flatMap(([p, url]) =>
    Object.entries(INPUTS).map(([i, irFile]) => [`${p}-${i}`, { url, irFile }]),
  ),
);

// `node bench/all.mjs mockA-smoke veridian-smoke` — or a bare platform/input
// name to mean every lane on it.
const expand = (arg) =>
  LANES[arg] ? [arg] : Object.keys(LANES).filter((n) => n.split('-')[0] === arg || n.split('-')[1] === arg);

async function main() {
  const pick = process.argv.slice(2).flatMap(expand);
  const names = pick.length ? [...new Set(pick)] : Object.keys(LANES);
  if (names.length === 0) throw new Error(`no lanes match ${process.argv.slice(2).join(' ')}`);
  console.log(`running ${names.length} lanes in parallel: ${names.join(', ')}`);

  const results = await Promise.all(names.map((n) => lane({ name: n, ...LANES[n] })));
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(results.map(({ read, ...r }) => r), null, 2));

  for (const r of results) {
    const s = r.score;
    console.log(
      `${r.name.padEnd(20)} ${r.error ? `ERROR ${r.error.slice(0, 80)}` : r.timedOut ? 'TIMEOUT' : 'done'}  ` +
      `${Math.round(r.ms / 1000)}s  ${s ? `fields ${s.seen.fields}/${s.want.fields} findings ${s.findings.length}` : ''}  ${r.panel?.status ?? ''}`,
    );
  }
}

// Only when run directly. gate.mjs imports LANES, and without this that import
// would run the whole matrix as a side effect.
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
