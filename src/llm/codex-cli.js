// Adapter that runs the locally installed official `codex` CLI (`codex exec`), so a user with a
// ChatGPT subscription can use pagetree without an API key. pagetree never reads the CLI's
// stored credentials; it only starts the CLI and reads its JSONL events from stdout.
//
// codex exec is an agent that can run commands. pagetree starts it with the read-only sandbox,
// an empty temp working directory and no session file. SECURITY.md explains what that leaves.

import fs from 'node:fs';
import path from 'node:path';
import { resolveBin, run, freshWorkDir, removeDir, flattenMessages } from './subprocess.js';
import { PagetreeError } from '../errors.js';
import { backoff } from './http.js';

export function codexArgs(cfg, lastFile) {
  const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--color', 'never', '--json', '-o', lastFile];
  // Like safe mode for the claude CLI: the user's own codex config (which can add MCP servers,
  // and so tools, to the agent) and exec rules stay out of the run. Sign in is unaffected.
  if (cfg.codexUserConfig !== true) args.push('--ignore-user-config', '--ignore-rules');
  if (cfg.model) args.push('-m', cfg.model);
  args.push('-');
  return args;
}

export function codexPrompt(system, messages) {
  return `<instructions>\n${system}\nDo not run any commands and do not read any files. Answer from the text below only.\n</instructions>\n\n${flattenMessages(messages)}`;
}

export function parseCodexEvents(stdout) {
  let text = null;
  let usage = null;
  let error = null;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message') text = ev.item.text;
    if (ev.type === 'turn.completed' && ev.usage) usage = ev.usage;
    if (ev.type === 'turn.failed' || ev.type === 'error') error = (ev.error && ev.error.message) || ev.message || 'codex turn failed';
  }
  return { text, usage, error };
}

export function createCodexCliAdapter(cfg, deps = {}) {
  return {
    name: 'codex-cli',
    model: cfg.model || '(codex CLI default)',
    async complete({ system, messages }) {
      const bin = resolveBin('codex', cfg.codexBin);
      if (!bin) throw new PagetreeError('usage', 'the codex CLI was not found on PATH. Install it, then run `pagetree auth login chatgpt`.');
      let last;
      for (let attempt = 0; attempt < 2; attempt++) {
        const cwd = freshWorkDir();
        const lastFile = path.join(cwd, 'last-message.txt');
        const t0 = Date.now();
        try {
          const res = await run(bin, codexArgs(cfg, lastFile), { input: codexPrompt(system, messages), timeoutMs: cfg.timeoutMs, cwd, spawnImpl: deps.spawn });
          const ev = parseCodexEvents(res.stdout);
          let text = ev.text;
          if (text == null && fs.existsSync(lastFile)) text = fs.readFileSync(lastFile, 'utf8');
          if (res.timedOut) last = new PagetreeError('provider', `codex CLI did not answer within ${cfg.timeoutMs} ms`);
          else if (res.code !== 0 || text == null) {
            const msg = ev.error || res.stderr.trim().split('\n').pop() || `exit code ${res.code}`;
            const isAuth = /log ?in|auth|401/i.test(msg);
            last = new PagetreeError(isAuth ? 'auth' : 'provider', `codex CLI failed: ${String(msg).slice(0, 200)}${isAuth ? '. Run `pagetree auth login chatgpt`.' : ''}`);
            if (isAuth) throw last;
          } else {
            const u = ev.usage || {};
            return {
              text,
              model: cfg.model || null,
              stop: 'end',
              latencyMs: Date.now() - t0,
              usage: { input_tokens: u.input_tokens ?? null, output_tokens: u.output_tokens ?? null, cost_usd: null },
            };
          }
        } finally {
          removeDir(cwd);
        }
        if (attempt === 0) await new Promise((ok) => setTimeout(ok, backoff(0)));
      }
      throw last;
    },
  };
}
