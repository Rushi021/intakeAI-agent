import { attach, detach, detachOnUnload, setStaleHandler } from './cdp.ts';
import { snapshot, toPrompt, expandAround, dialogControls, nodesNear, type Snapshot } from './perceive.ts';
import { parseIR, stats, planItems, type IR } from './ir.ts';
import { PROVIDERS, CONFIG, hasKey, testConnection } from './llm.ts';
import { newSession, run, statusTree, summary, type Session, type StatusNode } from './run.ts';

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

/**
 * The session is this document's lifetime — not a service worker's. sw.ts holds
 * no state and deliberately never will, so MV3 eviction cannot silently destroy
 * a run's ledger. Closing the panel ends the session; that is also the
 * operator's way to force a full re-verification from the root.
 */
let session: Session | null = null;
let stopping = false;

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

$('start').addEventListener('click', () => void go(false));
$('resume').addEventListener('click', () => void go(true));
$('stop').addEventListener('click', () => { stopping = true; $('status').textContent = 'Stopping after the current item…'; });

async function go(resuming: boolean): Promise<void> {
  if (!ir) return;
  stopping = false;
  $<HTMLButtonElement>('start').disabled = true;
  $<HTMLButtonElement>('resume').hidden = true;
  $('stop').hidden = false;
  $('status').textContent = resuming ? 'Resuming…' : 'Reading the page…';

  try {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('no active tab to build into');
    await attach(tab.id);
    $<HTMLButtonElement>('detach').disabled = false;

    // A new session on a fresh start; the same one on Resume, so answered gate
    // cards stay cached and the confirmed history is not re-verified.
    if (!resuming || !session) session = newSession(tab.id, tab.url ?? '', ir);

    const result = await run(session, ir, capture, {
      tabId: tab.id,
      shouldStop: () => stopping,
      onProgress: (done, total, item) => {
        $('status').textContent = `${done}/${total} · ${item.id}`;
        render();
      },
    });

    render();
    $('status').textContent = result.ok
      ? `Done in ${Math.round(result.ms / 1000)}s · ${result.llmCalls} model calls${result.resumed ? ' · resumed' : ''}`
      : `Finished with ${result.unaccounted.length} unaccounted — that is a bug in the agent, not a result.`;
  } catch (err) {
    $('status').textContent = String(err);
  } finally {
    $('stop').hidden = true;
    $<HTMLButtonElement>('start').disabled = false;
    render();
  }
}

async function capture(): Promise<Snapshot> {
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
    ['page settled', snap.settled.quiet ? `yes (${snap.settled.polls} polls, ${snap.settled.ms}ms)` : `NO — read after ${snap.settled.ms}ms`],
  ]);
  $('t-kept').textContent = `(${snap.compact.length} nodes)`;
  $('compact').textContent = toPrompt(snap);
  return snap;
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

// ── The operator's view: what got built, and what needs a decision ──────────
//
// Every number and every row here is derived from the ledger and the queue on
// each render. Nothing is stored separately, so the display cannot drift from
// what was actually built — the same reason assertTerminated backs the counts
// rather than a tally the UI keeps for itself.

function render(): void {
  if (!ir || !session) return;
  const s = summary(session, ir);

  counts('tally', [
    ['built', String(s.built + s.reused)],
    ['escalated', String(s.escalated)],
    ['not reached', String(s.total - s.built - s.reused - s.escalated - s.inFlight)],
    ['unaccounted', String(s.unaccounted)], // must be 0, or the agent has a bug
    ['plan items', String(s.total)],
  ]);
  $('tally').classList.toggle('bad', s.unaccounted > 0);

  renderGate();
  renderStatus();
  renderLedger();
}

function renderGate(): void {
  const open = [...session!.queue.values()].filter((c) => !c.answered);
  $('gate-wrap').hidden = open.length === 0;
  $('gate-n').textContent = open.length ? `(${open.length})` : '';
  $<HTMLButtonElement>('resume').hidden = open.length === session!.queue.size;

  const box = $('gate');
  box.replaceChildren();
  for (const card of open) {
    const c = el('div', undefined, 'card');
    c.id = `card-${card.signature}`;
    c.append(el('h3', card.question));
    c.append(el('p', `${card.items.length} item${card.items.length === 1 ? '' : 's'} waiting — ${card.items.slice(0, 3).join(', ')}${card.items.length > 3 ? ` and ${card.items.length - 3} more` : ''}`, 'muted'));

    const tried = el('details') as HTMLDetailsElement;
    tried.append(el('summary', 'what the agent tried'));
    tried.append(el('pre', card.tried.join('\n') || '—'));
    c.append(tried);

    if (card.choices.length) {
      // The answer is chosen from the live page, never typed. A free-text box
      // would let a human invent a control that is not there.
      const list = el('div', undefined, 'choices');
      for (const choice of card.choices) {
        const b = el('button', choice.name) as HTMLButtonElement;
        b.addEventListener('click', () => {
          session!.facts.set(card.signature, { value: choice.name, descriptor: { name: choice.name }, source: 'human' });
          card.answered = { value: choice.name, descriptor: { name: choice.name } };
          render();
        });
        list.append(b);
      }
      c.append(list);
    } else {
      c.append(el('p', 'No candidate on the current screen. Navigate the platform to where this is possible, then Resume.', 'muted'));
    }
    box.append(c);
  }
}

function renderStatus(): void {
  const box = $('tree');
  box.replaceChildren();
  for (const visit of statusTree(ir!, session!.ledger)) box.append(nodeRow(visit, true));
}

function nodeRow(n: StatusNode, openable: boolean): HTMLElement {
  const kids = n.children.length;
  const line = `${n.label} — ${n.status}${kids ? ` (${n.children.filter((c) => c.status === 'complete').length}/${kids})` : ''}`;

  if (!kids) {
    const row = el(n.status === 'escalated' ? 'button' : 'div', line, `row ${n.status}`);
    if (n.status === 'escalated') row.addEventListener('click', () => jumpTo(n.id));
    return row;
  }
  const d = el('details', undefined, n.status) as HTMLDetailsElement;
  d.open = openable && n.status !== 'complete';
  d.append(el('summary', line));
  for (const kid of n.children) d.append(nodeRow(kid, false));
  return d;
}

/** The item id is already the shared key across the IR, the ledger and the queue. */
function jumpTo(itemId: string): void {
  const card = [...session!.queue.values()].find((c) => c.items.includes(itemId));
  if (!card) return;
  document.getElementById(`card-${card.signature}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderLedger(): void {
  const escOnly = $<HTMLInputElement>('led-esc').checked;
  const rows = session!.ledger.all().filter((r) => !escOnly || r.state === 'escalated');
  $('ledger').textContent = rows.length
    ? rows
        .map((r) =>
          [
            r.item,
            r.state,
            r.source ?? r.signature ?? '',
            r.settled === false ? 'page-not-settled' : '',
            `${r.attempts} attempt${r.attempts === 1 ? '' : 's'}`,
            r.history.at(-1) ?? '',
          ]
            .filter(Boolean)
            .join('  ·  '),
        )
        .join('\n')
    : 'Nothing built yet.';
}

$('led-esc').addEventListener('change', () => session && render());
