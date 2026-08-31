import { attach, detach, detachOnUnload, setStaleHandler } from './cdp.ts';
import { snapshot, toPrompt, expandAround, dialogControls, nodesNear, type Snapshot } from './perceive.ts';
import { parseIR, stats, type IR } from './ir.ts';
import { PROVIDERS, CONFIG, hasKey, testConnection } from './llm.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = (tag: string, text?: string, cls?: string) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text; // textContent, never innerHTML: the IR is untrusted input
  if (cls) n.className = cls;
  return n;
};

let ir: IR | null = null;
let snap: Snapshot | null = null;
let tab: chrome.tabs.Tab | null = null;

detachOnUnload();

// ── Tabs ────────────────────────────────────────────────────────────────────
for (const btn of document.querySelectorAll<HTMLButtonElement>('.tabs button')) {
  btn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b === btn);
    $('tab-build').hidden = btn.dataset.tab !== 'build';
    $('tab-trace').hidden = btn.dataset.tab !== 'trace';
  });
}

// ── Build tab: load the input file, then one button ──────────────────────────
$<HTMLInputElement>('ir').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    ir = parseIR(await file.text());
    $('ir-name').textContent = file.name;
    $('ir-out').textContent = `${ir.study.protocol_id} — ${stats(ir).visits} visits, ${stats(ir).fields} fields.`;
    $<HTMLButtonElement>('start').disabled = false;
    renderTrace(ir);
  } catch (err) {
    ir = null;
    $<HTMLButtonElement>('start').disabled = true;
    $('ir-out').textContent = String(err);
  }
});

$('start').addEventListener('click', async () => {
  if (!ir) return;
  const btn = $<HTMLButtonElement>('start');
  btn.disabled = true;
  $('status').textContent = 'Reading the page…';
  try {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('no active tab to build into');
    await attach(tab.id);
    $<HTMLButtonElement>('detach').disabled = false;
    await capture();
    // Pass 1 stops here: the page is perceived, nothing is written. Planning
    // and building land in the next pass.
    $('status').textContent =
      `Page read: ${snap!.compact.length} actionable nodes. Open the Trace tab to inspect. ` +
      `Building is not implemented yet.`;
  } catch (err) {
    $('status').textContent = String(err);
  } finally {
    btn.disabled = false;
  }
});

async function capture(): Promise<void> {
  snap = await snapshot(
    { url: tab?.url ?? '', title: tab?.title ?? '' },
    { screenshot: $<HTMLInputElement>('shot').checked },
  );
  $('t-stale').classList.add('hidden');
  const total = snap.full.byAxId.size;
  const pruned = Math.round((1 - snap.compact.length / Math.max(total, 1)) * 100);
  counts('t-perceive', [
    ['page', snap.title || snap.url || '—'],
    ['accessibility nodes', String(total)],
    ['kept in pruned view', String(snap.compact.length)],
    ['dropped as layout noise', `${pruned}%`],
    ['screenshot', snap.full.screenshot ? 'captured' : 'not captured'],
  ]);
  $('t-kept').textContent = `(${snap.compact.length} nodes)`;
  $('compact').textContent = toPrompt(snap);
}

// ── Trace tab ───────────────────────────────────────────────────────────────
function counts(id: string, rows: [string, string][]): void {
  const dl = $(id);
  dl.replaceChildren();
  for (const [k, v] of rows) dl.append(el('dt', k), el('dd', v));
}

function renderTrace(ir: IR): void {
  const s = stats(ir);
  $('t-study').textContent = `${ir.study.protocol_id} — ${ir.study.title}`;
  counts('t-counts', [
    ['visits', String(s.visits)],
    ['form appearances', String(s.formAppearances)],
    ['distinct form definitions', String(s.distinctForms)],
    ['fields', String(s.fields)],
    ['skip-logic rules', String(s.skipRules)],
    ['repeating forms', String(s.repeatingForms)],
  ]);

  const tree = $('t-tree');
  tree.replaceChildren();
  for (const v of ir.visits) {
    const visit = el('details') as HTMLDetailsElement;
    const n = v.forms.reduce((a, f) => a + f.fields.length, 0);
    visit.append(el('summary', `${v.name} — ${v.forms.length} forms, ${n} fields (day ${v.window_start_day} to ${v.window_end_day})`));
    for (const f of v.forms) {
      const form = el('details') as HTMLDetailsElement;
      form.append(el('summary', `${f.name} — ${f.fields.length} fields${f.repeating ? ' · repeating' : ''}`));
      const pre = el('pre', f.fields
        .map((fl) => {
          const bits = [fl.label, `· ${fl.type}`];
          if (fl.required) bits.push('· required');
          if (fl.options) bits.push(`· ${fl.options.length} coded values`);
          if (fl.min !== undefined || fl.max !== undefined) bits.push(`· ${fl.min ?? ''}–${fl.max ?? ''} ${fl.units ?? ''}`.trim());
          if (fl.skip_logic) bits.push(`· shown when "${fl.skip_logic.when_field_label}" = ${fl.skip_logic.equals_value}`);
          if (fl.formula) bits.push(`· = ${fl.formula}`);
          return bits.join(' ');
        })
        .join('\n'));
      form.append(pre);
      visit.append(form);
    }
    tree.append(visit);
  }
}

setStaleHandler((reason) => {
  if (reason === 'detached') $<HTMLButtonElement>('detach').disabled = true;
  $('t-stale').textContent = `page changed (${reason}) — re-read before acting`;
  $('t-stale').classList.remove('hidden');
});

$('detach').addEventListener('click', async () => {
  await detach();
  tab = null;
  snap = null;
  $<HTMLButtonElement>('detach').disabled = true;
  $('status').textContent = 'Detached.';
});

// ── Model ───────────────────────────────────────────────────────────────────
// Read-only: everything comes from .env at build time. The panel reports where
// the key came from and whether it works, never what it is.
counts('m-info', [
  ['provider', PROVIDERS[CONFIG.provider].label],
  ['model', CONFIG.model],
  ['API key', hasKey() ? 'set in .env at build time' : 'missing'],
]);
$('m-out').textContent = hasKey()
  ? 'Click Test connection to confirm the key works.'
  : 'Copy .env.example to .env, set VITE_MISTRAL_API_KEY, then re-run `npm run build`.';

$('m-test').addEventListener('click', async () => {
  $('m-out').textContent = 'Testing…';
  try {
    const r = await testConnection();
    $('m-out').textContent = `OK — ${CONFIG.model} replied "${r.text.trim()}" (${r.inputTokens}+${r.outputTokens} tokens).`;
  } catch (err) {
    $('m-out').textContent = err instanceof Error ? err.message : String(err);
  }
});

// ── Level-2 tools ───────────────────────────────────────────────────────────
const show = (v: unknown) => ($('detail').textContent = JSON.stringify(v, null, 1));
const num = (id: string) => Number($<HTMLInputElement>(id).value);

$('expand').addEventListener('click', () => snap && show(expandAround(snap, num('ref'))));
$('dialog').addEventListener('click', () => snap && show(dialogControls(snap)));
$('near').addEventListener('click', () => snap && show(nodesNear(snap, num('x'), num('y'))));
