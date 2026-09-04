import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One lane = one browser, one profile, one mock tab, one panel. Lanes share
 * nothing but the dev server, and the mock's study lives in that tab's memory,
 * so lanes cannot contaminate each other.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '..', 'dist');
const DATA = join(HERE, '..', '..', 'intake-takehome-2', 'data');
export const OUT = join(HERE, 'out');

const nowIso = () => new Date().toISOString();

// ── grading: the built study vs the input file ──────────────────────────────

const norm = (v) => (v === undefined || v === null ? '' : String(v).trim());

/** Every difference between what the IR asked for and what the platform holds. */
function grade(ir, read) {
  const findings = [];
  const seen = { visits: 0, forms: 0, fields: 0 };
  const want = { visits: 0, forms: 0, fields: 0 };
  const builtVisits = read?.study?.visits ?? [];

  for (const v of ir.visits) {
    want.visits++;
    const bv = builtVisits.find((x) => x.name === v.name);
    if (!bv) {
      findings.push({ severity: 'missing', kind: 'visit', at: v.name, detail: 'visit was never created' });
      want.forms += v.forms.length;
      want.fields += v.forms.reduce((n, f) => n + f.fields.length, 0);
      continue;
    }
    seen.visits++;
    if (norm(bv.windowStart) !== norm(v.window_start_day) || norm(bv.windowEnd) !== norm(v.window_end_day)) {
      findings.push({ severity: 'wrong', kind: 'visit-window', at: v.name, detail: `want ${v.window_start_day}..${v.window_end_day}, got ${bv.windowStart}..${bv.windowEnd}` });
    }

    for (const f of v.forms) {
      want.forms++;
      want.fields += f.fields.length;
      const bf = (bv.forms ?? []).find((x) => x.name === f.name);
      if (!bf) {
        findings.push({ severity: 'missing', kind: 'form', at: `${v.name}/${f.name}`, detail: 'form was never created' });
        continue;
      }
      seen.forms++;
      if (!!bf.repeating !== !!f.repeating) {
        findings.push({ severity: 'wrong', kind: 'repeating', at: `${v.name}/${f.name}`, detail: `want repeating=${f.repeating}, got ${bf.repeating}` });
      }

      for (const fl of f.fields) {
        const at = `${v.name}/${f.name}/${fl.label}`;
        const bl = (bf.fields ?? []).find((x) => x.label === fl.label);
        if (!bl) {
          findings.push({ severity: 'missing', kind: 'field', at, detail: 'field was never created, or was created unnamed' });
          continue;
        }
        seen.fields++;
        if (bl.type !== fl.type) findings.push({ severity: 'wrong', kind: 'type', at, detail: `want ${fl.type}, got ${bl.type}` });
        if (!!bl.required !== !!fl.required) findings.push({ severity: 'wrong', kind: 'required', at, detail: `want ${fl.required}, got ${bl.required}` });

        const wantOpts = (fl.options ?? []).map((o) => `${o.code}=${o.label}`);
        const gotOpts = (bl.options ?? []).map((o) => `${o.code}=${o.label}`);
        if (wantOpts.join('|') !== gotOpts.join('|')) {
          const missing = wantOpts.filter((o) => !gotOpts.includes(o));
          const codeless = (bl.options ?? []).filter((o) => !norm(o.code)).length;
          findings.push({
            severity: wantOpts.length && !gotOpts.length ? 'missing' : 'wrong',
            kind: 'options', at,
            detail: `want ${wantOpts.length} pairs, got ${gotOpts.length}${missing.length ? `, missing ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` +${missing.length - 3}` : ''}` : ''}${codeless ? `, ${codeless} with no code` : ''}`,
          });
        }

        for (const key of ['min', 'max', 'units']) {
          if (fl[key] === undefined) continue;
          if (norm(bl[key]) !== norm(fl[key])) {
            findings.push({ severity: 'wrong', kind: key === 'units' ? 'units' : 'range', at, detail: `${key}: want ${norm(fl[key])}, got ${norm(bl[key]) || '(empty)'}` });
          }
        }
        if (fl.formula !== undefined && !norm(bl.formula)) {
          findings.push({ severity: 'missing', kind: 'formula', at, detail: 'formula not set' });
        }
        if (fl.skip_logic) {
          const s = bl.skipLogic;
          if (!s) findings.push({ severity: 'missing', kind: 'skip-logic', at, detail: `rule not set (want ${fl.skip_logic.when_field_label} = ${fl.skip_logic.equals_value})` });
          else if (s.whenFieldLabel !== fl.skip_logic.when_field_label || norm(s.equalsValue) !== norm(fl.skip_logic.equals_value)) {
            findings.push({ severity: 'wrong', kind: 'skip-logic', at, detail: `want ${fl.skip_logic.when_field_label}=${fl.skip_logic.equals_value}, got ${s.whenFieldLabel}=${s.equalsValue}` });
          }
        }
      }

      const extra = (bf.fields ?? []).filter((x) => !f.fields.some((y) => y.label === x.label));
      for (const x of extra) findings.push({ severity: 'extra', kind: 'field', at: `${v.name}/${f.name}/${x.label}`, detail: `not in the input file (type ${x.type})` });
    }
  }
  return { want, seen, findings };
}

// ── the run ─────────────────────────────────────────────────────────────────

export async function lane({ name, url, irFile, timeoutMs = 30 * 60_000 }) {
  const started = Date.now();
  const log = [];
  const say = (m) => { log.push(`${nowIso()}  ${m}`); console.log(`[${name}] ${m}`); };

  const ir = JSON.parse(readFileSync(join(DATA, irFile), 'utf8'));
  let ctx, result = { name, url, ir: irFile, ok: false };

  try {
    ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), `lane-${name}-`)), {
      headless: false,
      channel: 'chromium',
      args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    const extId = new URL(sw.url()).host;
    say(`extension ${extId} loaded`);

    const mock = await ctx.newPage();
    const consoleErrors = [];
    mock.on('pageerror', (e) => consoleErrors.push(String(e)));
    await mock.goto(url, { waitUntil: 'networkidle' });
    say(`platform "${await mock.title()}" at ${url}`);

    const panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    await panel.setInputFiles('#ir', join(DATA, irFile));
    await panel.waitForFunction(() => !document.getElementById('start').disabled, null, { timeout: 15000 });
    say(`input loaded: ${await panel.textContent('#ir-out')}`);

    await mock.bringToFront();
    const target = await panel.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.url);
    if (target !== url) throw new Error(`panel would attach to ${target}, not the platform`);

    // Click through the page's own handler: Playwright's click would raise the
    // panel and steal "active tab" from the platform it is supposed to drive.
    await panel.evaluate(() => document.getElementById('start').click());
    say('run started');

    const deadline = Date.now() + timeoutMs;
    let status = '';
    let lastProgress = '';
    while (Date.now() < deadline) {
      status = (await panel.textContent('#status')) ?? '';
      if (/^Done in|^Finished with|^Error|^TypeError/.test(status)) break;
      if (status !== lastProgress) { lastProgress = status; if (/\d+\/\d+/.test(status)) log.push(`${nowIso()}  ${status}`); }
      await panel.waitForTimeout(2000);
    }
    const timedOut = !/^Done in|^Finished with/.test(status);
    say(timedOut ? `TIMED OUT after ${Math.round((Date.now() - started) / 1000)}s — last status: ${status}` : status);

    const panelState = await panel.evaluate(() => ({
      status: document.getElementById('status')?.textContent ?? '',
      tally: [...document.querySelectorAll('#tally tr')].map((r) => [...r.cells].map((c) => c.textContent.trim())),
      gateHead: document.querySelector('#gate p.muted')?.textContent ?? '',
      cards: [...document.querySelectorAll('#gate .card')].map((c) => ({
        signature: c.querySelector('.sig')?.textContent ?? '',
        question: c.querySelector('h3')?.textContent ?? '',
        blocks: [...c.querySelectorAll('p.muted')].map((p) => p.textContent).find((t) => t.startsWith('Blocks')) ?? '',
        tried: c.querySelector('pre')?.textContent ?? '',
      })),
      ledger: document.getElementById('ledger')?.textContent ?? '',
    }));

    // The mock's own oracle, used the way it is meant to be used: by the human
    // checking the result, never by the agent.
    const read = await mock.evaluate(() => (typeof __readState === 'function' ? __readState() : null));
    const score = grade(ir, read);

    result = { name, url, ir: irFile, ok: !timedOut, timedOut, ms: Date.now() - started, panel: panelState, score, consoleErrors, read };
    say(`fields ${score.seen.fields}/${score.want.fields} · forms ${score.seen.forms}/${score.want.forms} · findings ${score.findings.length}`);
  } catch (err) {
    result.error = String(err);
    result.ms = Date.now() - started;
    say(`LANE FAILED: ${err}`);
  } finally {
    await ctx?.close().catch(() => {});
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(result, null, 2));
  writeFileSync(join(OUT, `${name}.log`), log.join('\n') + '\n');
  return result;
}
