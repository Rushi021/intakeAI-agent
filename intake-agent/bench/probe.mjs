/** Dump what the agent's perceive layer sees, driving the page by visible name. */
import { chromium } from 'playwright';
import { compactFrom } from '../src/perceive.ts';

const url = process.argv[2];
// steps: "click:Name" | "fill:Label=Value" | "wait"
const steps = process.argv.slice(3);

const b = await chromium.launch({ headless: true, channel: 'chromium' });
const p = await b.newPage();
const cdp = await p.context().newCDPSession(p);
await cdp.send('DOM.enable'); await cdp.send('Accessibility.enable');
await p.goto(url, { waitUntil: 'networkidle' });

const read = async () => {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  return compactFrom(nodes, new Map()).compact;
};
const show = (compact, tag) => {
  console.log(`\n===== ${tag} (${compact.length} nodes) =====`);
  for (const c of compact) {
    console.log(`${'  '.repeat(Math.min(c.depth,12))}[${c.ref}] ${c.role}${c.name?` ${JSON.stringify(c.name)}`:''}${c.value?` = ${JSON.stringify(c.value)}`:''}${c.state?` {${c.state.join(',')}}`:''}${c.region?`  <${c.region}>`:''}`);
  }
};

show(await read(), 'root');
for (const s of steps) {
  const [op, rest] = [s.slice(0, s.indexOf(':')), s.slice(s.indexOf(':') + 1)];
  try {
    if (op === 'click') await p.getByRole('button', { name: rest, exact: true }).or(p.getByText(rest, { exact: true })).first().click({ timeout: 5000 });
    else if (op === 'fill') { const [l, v] = rest.split('='); await p.getByLabel(l).first().fill(v, { timeout: 5000 }); }
  } catch (e) { console.log(`!! ${s} failed: ${e.message.split('\n')[0].slice(0,120)}`); }
  await p.waitForTimeout(500);
  show(await read(), `after ${s}`);
}
await b.close();
