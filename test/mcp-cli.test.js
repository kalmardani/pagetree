import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createMcpServer, runStdio } from '../src/mcp.js';
import { main, parseArgs } from '../src/cli.js';
import { createSession } from '../src/llm/provider.js';
import { createFakeAdapter } from '../src/llm/fake.js';
import { tmpDir, copyExample, capture, TESTDATA } from '../testdata/helpers.js';

const env = (extra = {}) => ({ PAGETREE_PROVIDER: 'fake', PATH: process.env.PATH, ...extra });

async function cli(args, extraEnv = {}) {
  const stdout = capture();
  const stderr = capture();
  const code = await main(args, { stdout, stderr, env: env(extraEnv) });
  return { code, out: stdout.text, err: stderr.text };
}

async function indexedExample(name) {
  const dir = tmpDir();
  const src = copyExample(name, dir);
  const out = path.join(dir, 'doc.pagetree.json');
  const r = await cli(['index', src, '-o', out, '--quiet']);
  assert.equal(r.code, 0, r.err);
  return { dir, src, out };
}

test('parseArgs handles values, booleans, = form, short flags and rejects unknown options', () => {
  assert.deepEqual(parseArgs(['ask', 'i.json', 'q', '--beam=2', '--json', '-o', 'x']), { flags: { beam: '2', json: true, output: 'x' }, pos: ['ask', 'i.json', 'q'] });
  assert.throws(() => parseArgs(['--bogus']), /unknown option/);
  assert.throws(() => parseArgs(['--beam']), /needs a value/);
});

test('cli: help, version, unknown command and exit codes', async () => {
  assert.equal((await cli(['--version'])).out.trim(), '0.1.0');
  assert.match((await cli(['--help'])).out, /pagetree auth login claude/);
  assert.equal((await cli([])).code, 2);
  assert.equal((await cli(['frobnicate'])).code, 2);
  assert.equal((await cli(['ask', 'missing.json', 'q'])).code, 3);
});

test('cli: index, show, read, ask with the fake provider', async () => {
  const { out } = await indexedExample('tool-library.md');
  const show = await cli(['show', out]);
  assert.equal(show.code, 0);
  assert.match(show.out, /3\.2\s+Loan periods\s+\[36-43\]/);
  assert.match(show.out, /source: current/);
  const json = JSON.parse((await cli(['show', out, '--json'])).out);
  assert.equal(json.nodes[0].path, '');
  const read = await cli(['read', out, '3.2']);
  assert.match(read.out, /38\| Hand tools and garden equipment/);
  const readJson = JSON.parse((await cli(['read', out, '3.2', '--json', '--limit', '2'])).out);
  assert.equal(readJson.lines.length, 2);
  assert.equal((await cli(['read', out, '9.9'])).code, 2);
  const a = await cli(['ask', out, 'How', 'many', 'days', 'for', 'loan', 'periods?']);
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /Citations/);
  assert.match(a.out, /Navigation/);
  const aj = JSON.parse((await cli(['ask', out, 'loan periods days', '--json'])).out);
  assert.equal(aj.status, 'answered');
  assert.ok(aj.trace.steps[0].chosen[0].reason);
});

test('cli: --plan prints the call estimate without a provider', async () => {
  const dir = tmpDir();
  const src = copyExample('tool-library.md', dir);
  const r = await cli(['index', src, '--plan', '--json'], { PAGETREE_PROVIDER: 'openai' });
  assert.equal(r.code, 0, r.err);
  assert.ok(JSON.parse(r.out).est_calls > 0);
});

test('cli: stale index exits with code 4 and says how to fix it', async () => {
  const { out, src } = await indexedExample('handbook.html');
  fs.appendFileSync(src, '<p>new</p>\n');
  const r = await cli(['ask', out, 'Where can I charge?']);
  assert.equal(r.code, 4);
  assert.match(r.err, /stale/);
  assert.match(r.err, /pagetree index/);
});

test('cli: verbose log lines carry tokens and prompt version but no secrets', async () => {
  const { out } = await indexedExample('tool-library.md');
  const r = await cli(['ask', out, 'loan periods', '--verbose'], { OPENAI_API_KEY: 'sk-should-not-appear' });
  const lines = r.err.trim().split('\n').map((l) => JSON.parse(l));
  const call = lines.find((l) => l.event === 'model_call');
  assert.equal(call.prompt_version, 'navigate/1');
  assert.ok(call.input_tokens > 0);
  assert.ok(!r.err.includes('sk-should-not-appear'));
});

test('cli: auth login rejects an unknown target and auth status runs with fake CLIs', async () => {
  assert.equal((await cli(['auth', 'login', 'github'])).code, 2);
  const state = tmpDir();
  process.env.FAKE_STATE_DIR = state;
  const r = await cli(['auth', 'status'], { PAGETREE_CLAUDE_BIN: path.join(TESTDATA, 'fake-claude.js'), PAGETREE_CODEX_BIN: path.join(TESTDATA, 'fake-codex.js'), PAGETREE_CONFIG_DIR: state, FAKE_STATE_DIR: state });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /claude CLI/);
  assert.match(r.out, /oauth\n  not configured/);
  const lo = await cli(['auth', 'logout'], { PAGETREE_CONFIG_DIR: state });
  assert.match(lo.out, /no cached token/);
});

test('mcp: initialize, tools/list, toc, read_node, ask and error paths', async () => {
  const { out } = await indexedExample('tool-library.md');
  const server = createMcpServer({ indexPaths: [out], cfg: { provider: 'fake' }, sessionFactory: () => createSession(createFakeAdapter()) });
  const call = async (msg) => server.handleLine(JSON.stringify({ jsonrpc: '2.0', ...msg }));

  const init = await call({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'pagetree');
  assert.equal(await call({ method: 'notifications/initialized' }), null);
  const unknownVersion = await call({ id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(unknownVersion.result.protocolVersion, '2025-11-25');

  const list = await call({ id: 3, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['toc', 'read_node', 'ask']);
  assert.ok(list.result.tools.every((t) => /untrusted/.test(t.description)));

  const toc = JSON.parse((await call({ id: 4, method: 'tools/call', params: { name: 'toc', arguments: { max_depth: 1 } } })).result.content[0].text);
  assert.ok(toc.nodes.every((n) => n.depth <= 1));

  const rn = await call({ id: 5, method: 'tools/call', params: { name: 'read_node', arguments: { path: '3.2', limit: 3 } } });
  const node = JSON.parse(rn.result.content[0].text);
  assert.equal(node.lines[0].line, 36);
  assert.equal(node.next_offset, 3);

  const askRes = await call({ id: 6, method: 'tools/call', params: { name: 'ask', arguments: { question: 'loan periods days power tools' } } });
  assert.equal(askRes.result.isError, false);
  assert.equal(JSON.parse(askRes.result.content[0].text).status, 'answered');

  const bad = await call({ id: 7, method: 'tools/call', params: { name: 'read_node', arguments: { path: '3.2', extra: 1 } } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /unknown field/);
  const otherIndex = await call({ id: 8, method: 'tools/call', params: { name: 'toc', arguments: { index: '../../etc/passwd' } } });
  assert.equal(otherIndex.result.isError, true);
  assert.equal((await call({ id: 9, method: 'nope' })).error.code, -32601);
  assert.equal((await server.handleLine('{not json')).error.code, -32700);
  assert.equal((await server.handleLine('[]')).error.code, -32600);
});

test('mcp: stdio transport answers line by line', async () => {
  const { out } = await indexedExample('handbook.html');
  const server = createMcpServer({ indexPaths: [out], cfg: { provider: 'fake' } });
  const input = new PassThrough();
  const output = new PassThrough();
  let buf = '';
  output.on('data', (d) => (buf += d));
  const done = runStdio(server, { input, output });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\r\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  input.end();
  await done;
  const msgs = buf.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(msgs.map((m) => m.id).sort(), [1, 2]);
});
