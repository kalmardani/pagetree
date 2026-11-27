// The official CLIs are replaced by small scripts in testdata/, started through the same
// spawn path (shell: false). These tests prove pagetree only starts the CLIs and reads what
// they print; there is no code path that touches their credential stores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { claudeStatus, loginClaude, codexStatus, loginChatgpt } from '../src/auth/subscription.js';
import { createClaudeCliAdapter, claudeArgs, parseClaudeResult } from '../src/llm/claude-cli.js';
import { createCodexCliAdapter, parseCodexEvents } from '../src/llm/codex-cli.js';
import { authStatus, renderAuthStatus } from '../src/auth/status.js';
import { TESTDATA, tmpDir } from '../testdata/helpers.js';

const claudeBin = path.join(TESTDATA, 'fake-claude.js');
const codexBin = path.join(TESTDATA, 'fake-codex.js');

function freshState() {
  const dir = tmpDir();
  process.env.FAKE_STATE_DIR = dir;
  return dir;
}

test('claude args disable tools, MCP, session files and customisations', () => {
  const a = claudeArgs({ model: 'x' }, 'SYS');
  assert.deepEqual(a.slice(0, 5), ['-p', '--output-format', 'json', '--system-prompt', 'SYS']);
  assert.equal(a[a.indexOf('--tools') + 1], '');
  for (const f of ['--no-session-persistence', '--strict-mcp-config', '--safe-mode']) assert.ok(a.includes(f), f);
  assert.ok(!claudeArgs({ claudeSafeMode: false }, 's').includes('--safe-mode'));
});

test('parseClaudeResult reads text, tokens, cost and model, and classifies errors', () => {
  const ok = parseClaudeResult(JSON.stringify({ subtype: 'success', is_error: false, result: 'hi', total_cost_usd: 0.5, usage: { input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3 }, modelUsage: { m1: {} } }));
  assert.deepEqual(ok.usage, { input_tokens: 3, output_tokens: 3, cost_usd: 0.5 });
  assert.equal(ok.model, 'm1');
  assert.equal(parseClaudeResult(JSON.stringify({ subtype: 'success', is_error: true, api_error_status: 529, result: 'overloaded' })).retryable, true);
  assert.equal(parseClaudeResult('garbage').retryable, false);
});

test('claude status and login: signed out, official sign in runs, then ready', async () => {
  const dir = freshState();
  const cfg = { claudeBin };
  const before = await claudeStatus(cfg);
  assert.deepEqual(before, { installed: true, ready: false, method: 'none' });
  const said = [];
  const r = await loginClaude(cfg, { print: (s) => said.push(s) });
  assert.deepEqual(r, { ready: true, already: false });
  const calls = fs.readFileSync(path.join(dir, 'claude-calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(calls.map((c) => c[0] === '-p' ? '-p' : c.join(' ')), ['auth status --json', '-p', 'auth login', '-p']);
  const after = await claudeStatus(cfg);
  assert.equal(after.ready, true);
  assert.ok(!JSON.stringify(after).includes('example.invalid'), 'identity fields from the CLI are not passed on');
  assert.deepEqual(await loginClaude(cfg), { ready: true, already: true });
});

test('claude-cli adapter sends the prompt on stdin and returns usage with cost', async () => {
  const dir = freshState();
  fs.writeFileSync(path.join(dir, 'claude-signed-in'), 'yes');
  process.env.FAKE_CLAUDE_REPLY = '{"n":1}';
  const a = createClaudeCliAdapter({ claudeBin, timeoutMs: 20000 });
  const r = await a.complete({ system: 'S', messages: [{ role: 'user', content: 'hello doc' }], maxTokens: 10 });
  assert.equal(r.text, '{"n":1}');
  assert.equal(r.usage.input_tokens, 115);
  assert.equal(r.usage.cost_usd, 0.0012);
  assert.equal(fs.readFileSync(path.join(dir, 'claude-last-stdin.txt'), 'utf8'), 'hello doc');
  delete process.env.FAKE_CLAUDE_REPLY;
});

test('claude-cli adapter turns a signed out CLI into an auth error with the login hint', async () => {
  freshState();
  const a = createClaudeCliAdapter({ claudeBin, timeoutMs: 20000 });
  await assert.rejects(a.complete({ system: 'S', messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'auth' && /auth login claude/.test(e.message));
});

test('codex status and login run the official commands only', async () => {
  const dir = freshState();
  const cfg = { codexBin };
  assert.deepEqual(await codexStatus(cfg), { installed: true, ready: false, method: null });
  assert.deepEqual(await loginChatgpt(cfg), { ready: true, already: false });
  assert.deepEqual(await codexStatus(cfg), { installed: true, ready: true, method: 'chatgpt' });
  const calls = fs.readFileSync(path.join(dir, 'codex-calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).join(' '));
  assert.deepEqual(calls, ['login status', 'login status', 'login', 'login status', 'login status']);
});

test('codex-cli adapter uses the read-only sandbox and parses JSONL usage', async () => {
  const dir = freshState();
  process.env.FAKE_CODEX_REPLY = '{"n":2}';
  const a = createCodexCliAdapter({ codexBin, timeoutMs: 20000 });
  const r = await a.complete({ system: 'S', messages: [{ role: 'user', content: 'doc' }] });
  assert.equal(r.text, '{"n":2}');
  assert.equal(r.usage.output_tokens, 4);
  const args = JSON.parse(fs.readFileSync(path.join(dir, 'codex-calls.log'), 'utf8').trim());
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(args.includes('--ephemeral'));
  assert.ok(args.includes('--ignore-user-config') && args.includes('--ignore-rules'));
  assert.match(fs.readFileSync(path.join(dir, 'codex-last-stdin.txt'), 'utf8'), /Do not run any commands/);
  delete process.env.FAKE_CODEX_REPLY;
  assert.equal(parseCodexEvents('{"type":"turn.failed","error":{"message":"boom"}}').error, 'boom');
});

test('auth status covers every connection type and never prints a secret', async () => {
  const dir = freshState();
  fs.writeFileSync(path.join(dir, 'claude-signed-in'), 'yes');
  const env = {
    OPENAI_API_KEY: 'sk-very-secret', PAGETREE_CLAUDE_BIN: claudeBin, PAGETREE_CODEX_BIN: codexBin,
    PAGETREE_CONFIG_DIR: dir, PAGETREE_OAUTH_TOKEN_URL: 'https://auth.example.invalid/token', PAGETREE_OAUTH_CLIENT_ID: 'c1',
  };
  const s = await authStatus({}, env);
  assert.equal(s.api_key.find((k) => k.env === 'OPENAI_API_KEY').ready, true);
  assert.equal(s.api_key.find((k) => k.env === 'ANTHROPIC_API_KEY').ready, false);
  assert.equal(s.oauth.configured, true);
  assert.equal(s.oauth.ready, false);
  assert.equal(s.claude_cli.ready, true);
  assert.equal(s.codex_cli.ready, false);
  const text = renderAuthStatus(s) + JSON.stringify(s);
  assert.ok(!text.includes('sk-very-secret'));
  assert.match(renderAuthStatus(s), /pagetree auth login chatgpt/);
});

test('a missing CLI is reported as not installed with an install hint', async () => {
  const c = await claudeStatus({ claudeBin: path.join(TESTDATA, 'no-such-claude') });
  assert.equal(c.installed, false);
  assert.match(c.note, /Install the official Claude Code CLI/);
  const x = await codexStatus({ codexBin: path.join(TESTDATA, 'no-such-codex') });
  assert.equal(x.installed, false);
  await assert.rejects(loginChatgpt({ codexBin: path.join(TESTDATA, 'no-such-codex') }), /not found on PATH/);
});
