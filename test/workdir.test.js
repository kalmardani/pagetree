// The vendor CLIs read CLAUDE.md, AGENTS.md and similar files from their working directory and
// send them with every call. Each adapter call must therefore run in its own fresh, empty
// folder under the OS temp dir, never the current directory, and remove it afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClaudeCliAdapter } from '../src/llm/claude-cli.js';
import { createCodexCliAdapter } from '../src/llm/codex-cli.js';
import { TESTDATA } from '../testdata/helpers.js';

const CLAUDE_OK = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'pong', usage: {}, modelUsage: {} });
const CODEX_OK = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'pong' } }) + '\n';

// A spawn stand in. It records the cwd and what the folder holds while the "CLI" runs.
function fakeSpawn(reply) {
  const seen = [];
  const fn = (command, args, opts) => {
    seen.push({ cwd: opts.cwd, existed: fs.existsSync(opts.cwd), entries: fs.readdirSync(opts.cwd), shell: opts.shell });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    const r = reply(args);
    setImmediate(() => {
      child.stdout.end(r.stdout ?? '');
      child.stderr.end(r.stderr ?? '');
      setImmediate(() => child.emit('close', r.code ?? 0));
    });
    return child;
  };
  fn.seen = seen;
  return fn;
}

function insideTmp(dir) {
  const rel = path.relative(os.tmpdir(), dir);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function checkSeen(seen) {
  for (const s of seen) {
    assert.ok(insideTmp(s.cwd), `cwd ${s.cwd} is inside ${os.tmpdir()}`);
    assert.notEqual(s.cwd, process.cwd());
    assert.equal(s.shell, false);
    assert.ok(s.existed, 'the folder exists while the CLI runs');
    assert.deepEqual(s.entries, [], 'the folder is empty');
    assert.ok(!fs.existsSync(s.cwd), 'the folder is gone after the call');
  }
}

const adapters = [
  ['claude-cli', () => createClaudeCliAdapter, { claudeBin: path.join(TESTDATA, 'fake-claude.js') }, () => ({ stdout: CLAUDE_OK }),
    () => ({ code: 1, stdout: JSON.stringify({ subtype: 'success', is_error: true, result: 'bad request', api_error_status: 400 }) })],
  ['codex-cli', () => createCodexCliAdapter, { codexBin: path.join(TESTDATA, 'fake-codex.js') }, () => ({ stdout: CODEX_OK }),
    () => ({ code: 1, stderr: 'auth required, please login' })],
];

for (const [name, factory, bins, ok, fail] of adapters) {
  test(`${name} runs in a fresh empty temp dir and removes it, also on error`, async () => {
    const good = fakeSpawn(ok);
    const r = await factory()({ ...bins, timeoutMs: 20000 }, { spawn: good }).complete({ system: 'S', messages: [{ role: 'user', content: 'ping' }] });
    assert.equal(r.text, 'pong');
    const bad = fakeSpawn(fail);
    await assert.rejects(factory()({ ...bins, timeoutMs: 20000 }, { spawn: bad }).complete({ system: 'S', messages: [{ role: 'user', content: 'ping' }] }));
    const seen = [...good.seen, ...bad.seen];
    assert.equal(seen.length, 2);
    checkSeen(seen);
    assert.notEqual(seen[0].cwd, seen[1].cwd, 'every call gets its own folder');
  });
}
