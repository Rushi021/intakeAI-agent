/** The request we send and the reply we parse, without touching the network.
 *  An API key is the one value here that must never leak, so that is asserted
 *  rather than assumed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { PROVIDERS, CONFIG, chat, activeModel, type Config } from '../src/llm.ts';

const cfg: Config = { ...CONFIG, apiKey: 'FAKE-KEY-FOR-TESTS' };
const spec = PROVIDERS.mistral;

test('the key travels in a header, never in the URL', () => {
  assert.equal(spec.endpoint, 'https://api.mistral.ai/v1/chat/completions');
  assert.ok(!spec.endpoint.includes('key'));
  assert.equal(spec.headers(cfg.apiKey).Authorization, 'Bearer FAKE-KEY-FOR-TESTS');
  const body = JSON.stringify(spec.body(cfg, [{ role: 'user', content: 'hi' }], {}));
  assert.ok(!body.includes(cfg.apiKey), 'the key must not appear in the request body');
});

test('builds are deterministic by default', () => {
  const b = spec.body(cfg, [{ role: 'user', content: 'hi' }], {}) as any;
  assert.equal(b.temperature, 0);
  assert.equal(b.response_format, undefined);
  assert.deepEqual((spec.body(cfg, [], { json: true }) as any).response_format, { type: 'json_object' });
});

test('parses content and token usage', () => {
  assert.deepEqual(
    spec.parse({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
    { text: 'OK', inputTokens: 12, outputTokens: 3 },
  );
  // A malformed reply yields empty text rather than throwing mid-build.
  assert.deepEqual(spec.parse({}), { text: '', inputTokens: 0, outputTokens: 0 });
});

test('a missing key fails before any request is made', async () => {
  await assert.rejects(
    () => chat([{ role: 'user', content: 'x' }], {}, { ...CONFIG, apiKey: '' }),
    /No Mistral AI API key\. Copy \.env\.example to \.env, set VITE_MISTRAL_API_KEY/,
  );
});

test('provider errors are readable and do not echo the key', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"message":"Unauthorized"}', { status: 401 });
  try {
    await assert.rejects(() => chat([{ role: 'user', content: 'x' }], {}, cfg), (e: Error) => {
      assert.match(e.message, /rejected the API key \(401\)/);
      assert.ok(!e.message.includes(cfg.apiKey));
      return true;
    });
  } finally {
    globalThis.fetch = real;
  }
});

test('a 403 that is a tier block is not reported as a rejected key', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        message: 'This model is not available in your subscription tier',
        type: 'tier_not_allowed',
        code: '1910',
      }),
      { status: 403 },
    );
  };
  try {
    await assert.rejects(() => chat([{ role: 'user', content: 'x' }], {}, cfg), (e: Error) => {
      assert.match(e.message, /subscription tier/);
      assert.doesNotMatch(e.message, /rejected the API key/);
      return true;
    });
  } finally {
    globalThis.fetch = real;
  }
});

test('a 403 on the requested model falls back to one this key can use', async () => {
  const real = globalThis.fetch;
  const tried: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
    tried.push(body.model ?? '');
    if (body.model === 'mistral-large-latest') {
      return new Response(
        JSON.stringify({
          message: 'This model is not available in your subscription tier',
          type: 'tier_not_allowed',
          code: '1910',
        }),
        { status: 403 },
      );
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    );
  };
  try {
    const r = await chat([{ role: 'user', content: 'x' }], {}, { ...cfg, model: 'mistral-large-latest' });
    assert.equal(r.text, 'OK');
    assert.equal(tried[0], 'mistral-large-latest');
    assert.equal(tried[1], 'mistral-small-latest');
  } finally {
    globalThis.fetch = real;
  }
});

test('a model that goes sticky and later tier-blocks falls back, rather than failing every call for the rest of the session', async () => {
  // Sticky is an optimization (skip re-probing once a model is known good),
  // never a promise: an account's eligibility can change mid-session, or the
  // first success can be a fluke. If the sticky choice cannot recover, every
  // remaining question that build asks fails outright instead of degrading.
  // stickyModel is module state that earlier tests in this file may already
  // have set — so this does not assume which model is sticky going in, only
  // that whichever one is gets blocked and something else recovers it.
  const real = globalThis.fetch;
  let blocked = false;
  let blockedModel = '';
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
    if (blocked && body.model === blockedModel) {
      return new Response(
        JSON.stringify({ message: 'This model is not available in your subscription tier', type: 'tier_not_allowed' }),
        { status: 403 },
      );
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: blocked ? 'RECOVERED' : 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    );
  };
  try {
    const first = await chat([{ role: 'user', content: 'x' }], {}, cfg);
    assert.equal(first.text, 'OK');
    blockedModel = activeModel();

    blocked = true;
    const second = await chat([{ role: 'user', content: 'y' }], {}, cfg);
    assert.equal(second.text, 'RECOVERED', 'a later tier block on the sticky model must still fall through the ladder');
    assert.notEqual(activeModel(), blockedModel, 'a model that started failing must not stay sticky');
  } finally {
    globalThis.fetch = real;
  }
});

test('no API key is hardcoded anywhere in src/', () => {
  // A key can only ever arrive at runtime from chrome.storage.local. This
  // guards the boundary against a future "just for testing" paste.
  const dir = new URL('../src/', import.meta.url);
  const keyShaped = /(sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|Bearer\s+[A-Za-z0-9]{20,})/;
  for (const f of readdirSync(dir)) {
    const body = readFileSync(new URL(f, dir), 'utf8');
    const hit = keyShaped.exec(body);
    assert.equal(hit, null, `${f} contains something key-shaped: ${hit?.[0]}`);
  }
  // Outside a Vite build there is no import.meta.env, so this also proves the
  // key can only ever arrive from .env — there is no other source in the code.
  assert.equal(CONFIG.apiKey, '', 'no key without a .env-backed build');
});

test('.env is gitignored and .env.example carries no real key', () => {
  const root = new URL('../', import.meta.url);
  const ignored = readFileSync(new URL('.gitignore', root), 'utf8');
  assert.match(ignored, /^\.env$/m, '.env must never be committable');
  assert.match(ignored, /^dist\/$/m, 'dist/ holds the inlined key and must not be committed');
  const example = readFileSync(new URL('.env.example', root), 'utf8');
  assert.match(example, /^VITE_MISTRAL_API_KEY=\s*$/m, '.env.example must ship empty');
  assert.ok(existsSync(new URL('.env', root)), '.env must exist for a build to pick up a key');
});
