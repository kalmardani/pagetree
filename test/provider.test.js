import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSession, createAdapter } from '../src/llm/provider.js';
import { createFakeAdapter } from '../src/llm/fake.js';
import { resolveConfig, resolveAuthMode } from '../src/config.js';
import { request } from '../src/llm/http.js';
import { PagetreeError } from '../src/errors.js';

const schema = { type: 'object', required: ['n'], extra: false, props: { n: { type: 'integer', min: 1, max: 3 } } };

test('json(): valid reply passes on the first call', async () => {
  const s = createSession(createFakeAdapter({ script: ['{"n":2}'] }));
  assert.deepEqual(await s.json({ system: 's', user: 'u', schema, meta: { task: 't' } }), { n: 2 });
  assert.equal(s.summary().calls, 1);
});

test('json(): one repair round carries the validation error back to the model', async () => {
  const fake = createFakeAdapter({ script: ['{"n":9}', '{"n":3}'] });
  const s = createSession(fake);
  assert.deepEqual(await s.json({ system: 's', user: 'u', schema, meta: { task: 't' } }), { n: 3 });
  const second = fake.calls[1].messages;
  assert.equal(second.length, 3);
  assert.equal(second[1].role, 'assistant');
  assert.match(second[2].content, /above the maximum 3/);
  assert.equal(s.summary().repairs, 1);
});

test('json(): fails closed after two invalid replies, and semantic checks count', async () => {
  const s = createSession(createFakeAdapter({ script: ['not json', '{"n":1}'] }));
  await assert.rejects(
    s.json({ system: 's', user: 'u', schema, check: (v) => (v.n === 1 ? ['$.n must not be 1'] : []), meta: { task: 't' } }),
    (e) => e instanceof PagetreeError && e.code === 'model_output',
  );
});

test('call cap stops before the call that would exceed it', async () => {
  const s = createSession(createFakeAdapter({ script: ['{"n":1}', '{"n":1}'] }), { maxCalls: 1 });
  await s.json({ system: 's', user: 'u', schema, meta: { task: 't' } });
  await assert.rejects(s.json({ system: 's', user: 'u', schema, meta: { task: 't' } }), (e) => e.code === 'budget');
});

test('decision table A: adapter and auth', () => {
  const env = {};
  assert.equal(resolveAuthMode('claude-cli', undefined, { env }), 'subscription');
  assert.equal(resolveAuthMode('codex-cli', undefined, { env }), 'subscription');
  assert.equal(resolveAuthMode('openai', undefined, { env }), 'api-key');
  assert.equal(resolveAuthMode('openai', undefined, { env, baseUrl: 'http://127.0.0.1:11434/v1' }), 'none');
  assert.equal(resolveAuthMode('openai', undefined, { env: { OPENAI_API_KEY: 'k' }, baseUrl: 'http://localhost:1/v1' }), 'api-key');
  assert.equal(resolveAuthMode('anthropic', 'oauth', { env }), 'oauth');
  assert.equal(resolveAuthMode('fake', undefined, { env }), 'none');
  assert.throws(() => resolveAuthMode('claude-cli', 'api-key', { env }), /works with auth subscription/);
  assert.throws(() => resolveAuthMode('openai', 'subscription', { env }), /works with auth/);
  assert.throws(() => resolveAuthMode('openai', 'none', { env, baseUrl: 'https://api.example.com/v1' }), /loopback/);
  assert.throws(() => resolveConfig({ provider: 'nope' }, {}), /unknown provider/);
});

function server(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test('openai adapter: bearer key from env, retry on 429, usage parsed, key never in errors', async () => {
  let hits = 0;
  let auth = null;
  const { srv, url } = await server((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      hits++;
      auth = req.headers.authorization;
      if (hits === 1) {
        res.writeHead(429, { 'retry-after': '0' }).end('{"error":{"message":"slow down"}}');
        return;
      }
      const j = JSON.parse(body);
      assert.equal(j.messages[0].role, 'system');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: 'm-1', choices: [{ message: { content: '{"n":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 3 } }));
    });
  });
  try {
    const cfg = resolveConfig({ provider: 'openai', model: 'm-1', 'base-url': `${url}/v1` }, { OPENAI_API_KEY: 'sk-test-secret' });
    const s = createSession(createAdapter(cfg));
    assert.deepEqual(await s.json({ system: 's', user: 'u', schema, meta: { task: 't' } }), { n: 1 });
    assert.equal(hits, 2);
    assert.equal(auth, 'Bearer sk-test-secret');
    assert.equal(s.summary().input_tokens, 11);
    assert.equal(s.summary().cost_usd, null);
  } finally {
    srv.close();
  }
});

test('anthropic adapter: x-api-key for api-key auth, bearer for oauth, error has no key', async () => {
  const seen = [];
  const { srv, url } = await server((req, res) => {
    seen.push({ key: req.headers['x-api-key'], auth: req.headers.authorization });
    if (seen.length === 1) {
      res.writeHead(400).end('{"error":{"message":"bad request"}}');
      return;
    }
    res.writeHead(200).end(JSON.stringify({ model: 'c-1', content: [{ type: 'text', text: '{"n":2}' }], usage: { input_tokens: 5, output_tokens: 2 } }));
  });
  try {
    const cfg = resolveConfig({ provider: 'anthropic', model: 'c-1', 'base-url': url }, { ANTHROPIC_API_KEY: 'ak-secret' });
    const a = createAdapter(cfg);
    await assert.rejects(a.complete({ system: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 10 }), (e) => !e.message.includes('ak-secret') && /400/.test(e.message));
    const r = await a.complete({ system: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 10 });
    assert.equal(r.text, '{"n":2}');
    assert.equal(seen[1].key, 'ak-secret');
    assert.equal(seen[1].auth, undefined);
  } finally {
    srv.close();
  }
});

test('missing API key is an auth error that names the variable, not a value', async () => {
  const cfg = resolveConfig({ provider: 'openai', model: 'm' }, {});
  await assert.rejects(createAdapter(cfg).complete({ system: 's', messages: [], maxTokens: 1 }), /set OPENAI_API_KEY/);
});

test('request(): timeout is reported and retried a bounded number of times', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    const e = new Error('timeout');
    e.name = 'TimeoutError';
    throw e;
  };
  await assert.rejects(request('https://example.invalid/x?key=secret', { fetchImpl, retries: 2, sleep: async () => {}, timeoutMs: 5 }), (e) => /timed out/.test(e.message) && !e.message.includes('secret'));
  assert.equal(calls, 3);
});
