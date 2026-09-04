/**
 * The human gate, end to end: run a lane, answer the cards a person can answer,
 * press Resume, and report what that unblocked.
 *
 * The answers live here, not in the agent. That is the point — the operator's
 * knowledge of their own platform is exactly what the agent does not have, and
 * the check is whether handing it over through the panel is enough to unblock
 * the work. A signature with no entry here is left unanswered, and shows up in
 * the report as "no operator answer given".
 *
 *   node bench/gate.mjs <lane>            (default: sourceone-smoke)
 */
import { chromium } from 'playwright';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANES } from './all.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '..', 'dist');
const DATA = join(HERE, '..', '..', 'intake-takehome-2', 'data');
const OUT = join(HERE, 'out');

/** What an operator looking at each platform would click, by card signature. */
const ANSWERS = {
  mockA: {},
  veridian: { 'type:datetime': 'Calendar + Clock', 'type:integer': 'Numeric (Integer)', 'type:decimal': 'Numeric (Fractional)' },
  trialforge: { 'type:radio': 'Choice Buttons', 'type:decimal': 'Measured Value', 'type:integer': 'Whole Count',
                'add:visit': 'Schedule Event', 'add:form': 'Attach Data Sheet', 'add:field': 'Insert' },
  sourceone: { 'type:radio': 'Select One (Expanded)', 'type:textarea': 'Free Text (Block)',
               'add:visit': 'Define Assessment Point', 'add:form': 'Add Source Record', commit: 'Record actions' },
};

const laneName = process.argv[2] ?? 'sourceone-smoke';
const lane = LANES[laneName];
if (!lane) throw new Error(`no such lane: ${laneName}`);
const platform = laneName.split('-')[0];
const answers = ANSWERS[platform] ?? {};

const readPanel = (panel) => panel.evaluate(() => ({
  status: document.getElementById('status')?.textContent ?? '',
  tally: Object.fromEntries([...document.querySelectorAll('#tally tr')].map((r) => [...r.cells].map((c) => c.textContent.trim()))),
  cards: [...document.querySelectorAll('#gate .card')].map((c) => ({
    signature: (c.querySelector('.sig')?.textContent ?? '').split(' ·')[0],
    answerable: (c.querySelector('.sig')?.textContent ?? '').includes('you can answer this'),
    blocks: [...c.querySelectorAll('p.muted')].map((p) => p.textContent).find((t) => t?.startsWith('Blocks')) ?? '',
    choices: [...c.querySelectorAll('.choices button')].map((b) => b.textContent),
    tried: c.querySelector('pre')?.textContent ?? '',
  })),
  ledger: document.getElementById('ledger')?.textContent ?? '',
}));

const ledgerStates = (text) => {
  const out = {};
  for (const line of text.split('\n')) {
    const state = line.split('  ·  ')[1];
    if (state) out[state] = (out[state] ?? 0) + 1;
  }
  return out;
};

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), `gate-${laneName}-`)), {
  headless: false, channel: 'chromium',
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const extId = new URL(sw.url()).host;

const mock = await ctx.newPage();
await mock.goto(lane.url, { waitUntil: 'networkidle' });
const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
await panel.setInputFiles('#ir', join(DATA, lane.irFile));
await panel.waitForFunction(() => !document.getElementById('start').disabled, null, { timeout: 15000 });
await mock.bringToFront();

const runToEnd = async (buttonId) => {
  await panel.evaluate((id) => document.getElementById(id).click(), buttonId);
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    const status = (await panel.textContent('#status')) ?? '';
    if (/^Done in|^Finished with|^Error|^TypeError/.test(status)) return status;
    if (Date.now() > deadline) return `TIMED OUT — ${status}`;
    await panel.waitForTimeout(2000);
  }
};

const first = await runToEnd('start');
const before = await readPanel(panel);
const readBefore = await mock.evaluate(() => (typeof __readState === 'function' ? __readState() : null));

// The operator answers. One click per card, chosen from the live page — the
// panel offers no free-text box, so an answer naming a control that is not
// there cannot be given.
const answered = [];
const unanswered = [];
for (const card of before.cards) {
  const want = answers[card.signature];
  if (!card.answerable || !want) { unanswered.push({ ...card, why: card.answerable ? 'no operator answer given' : 'not answerable' }); continue; }
  const clicked = await panel.evaluate(([sig, name]) => {
    const el = document.getElementById(`card-${sig}`);
    const button = [...(el?.querySelectorAll('.choices button') ?? [])].find((b) => b.textContent === name);
    button?.click();
    return !!button;
  }, [card.signature, want]);
  (clicked ? answered : unanswered).push({ ...card, picked: want, why: clicked ? undefined : `"${want}" was not offered` });
}

await mock.bringToFront();
const second = answered.length ? await runToEnd('resume') : 'not resumed — nothing was answered';
const after = await readPanel(panel);
const readAfter = await mock.evaluate(() => (typeof __readState === 'function' ? __readState() : null));

const fields = (s) => (s?.study?.visits ?? []).flatMap((v) => (v.forms ?? []).flatMap((f) => f.fields ?? [])).length;
const result = {
  lane: laneName, platform, ir: lane.irFile,
  first, second,
  answered: answered.map((a) => ({ signature: a.signature, picked: a.picked, blocks: a.blocks })),
  unanswered: unanswered.map((u) => ({ signature: u.signature, why: u.why, choices: u.choices })),
  cardsBefore: before.cards.length, cardsAfter: after.cards.length,
  ledgerBefore: ledgerStates(before.ledger), ledgerAfter: ledgerStates(after.ledger),
  stillEscalated: after.cards.map((c) => ({ signature: c.signature, blocks: c.blocks, tried: c.tried })),
  tallyBefore: before.tally, tallyAfter: after.tally,
  fieldsBefore: fields(readBefore), fieldsAfter: fields(readAfter),
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, `gate-${laneName}.json`), JSON.stringify({ ...result, ledgerAfterText: after.ledger, readAfter }, null, 2));
console.log(JSON.stringify(result, null, 2));
await ctx.close();
