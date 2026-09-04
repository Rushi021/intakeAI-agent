/** One table over a directory of lane results. `node bench/summarize.mjs [dir]` */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), 'out', 'matrix');
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const rows = files.map((f) => {
  const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const s = r.score ?? { seen: {}, want: {}, findings: [] };
  const states = {};
  for (const line of (r.panel?.ledger ?? '').split('\n')) {
    const st = line.split('  ·  ')[1];
    if (st) states[st] = (states[st] ?? 0) + 1;
  }
  const cards = (r.panel?.cards ?? []).map((c) => c.signature.split(' ')[0]);
  return {
    lane: f.replace(/\.json$/, ''),
    outcome: r.error ? 'ERROR' : r.timedOut ? 'TIMEOUT' : 'completed',
    secs: Math.round((r.ms ?? 0) / 1000),
    fields: `${s.seen.fields ?? 0}/${s.want.fields ?? 0}`,
    recall: pct(s.seen.fields, s.want.fields),
    forms: `${s.seen.forms ?? 0}/${s.want.forms ?? 0}`,
    visits: `${s.seen.visits ?? 0}/${s.want.visits ?? 0}`,
    findings: s.findings.length,
    built: (states.built ?? 0) + (states.reused ?? 0),
    escalated: states.escalated ?? 0,
    inflight: states['in-flight'] ?? 0,
    cards: cards.join(' '),
  };
});

const cols = ['lane', 'outcome', 'secs', 'visits', 'forms', 'fields', 'recall', 'findings', 'built', 'escalated', 'inflight', 'cards'];
const w = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c]).length))]));
const line = (r) => cols.map((c) => String(r[c]).padEnd(w[c])).join('  ');
console.log(line(Object.fromEntries(cols.map((c) => [c, c]))));
console.log(cols.map((c) => '-'.repeat(w[c])).join('  '));
for (const r of rows) console.log(line(r));
