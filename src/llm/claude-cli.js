// Adapter that runs the locally installed official `claude` CLI in print mode, so a user with a
// Claude subscription can use pagetree without an API key. pagetree never reads the CLI's
// stored credentials; it only starts the CLI and reads its JSON result from stdout.
//
// Flags: no tools (`--tools ""`), no MCP servers, no session file, safe mode (no CLAUDE.md,
// hooks, skills or plugins), our own system prompt, and an empty temp working directory.

import { resolveBin, run, freshWorkDir, removeDir, flattenMessages } from './subprocess.js';
import { PagetreeError } from '../errors.js';
import { backoff } from './http.js';

export function claudeArgs(cfg, system) {
  const args = ['-p', '--output-format', 'json', '--system-prompt', system, '--tools', '',
    '--no-session-persistence', '--strict-mcp-config'];
  if (cfg.claudeSafeMode !== false) args.push('--safe-mode');
  if (cfg.model) args.push('--model', cfg.model);
  return args;
}

export function parseClaudeResult(stdout) {
  let j;
  try {
    j = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() || '');
  } catch {
    return { error: 'claude CLI did not print a JSON result', retryable: false };
  }
  if (j.is_error || j.subtype !== 'success') {
    const status = Number(j.api_error_status);
    return {
      error: `claude CLI reported an error (${j.subtype || 'error'}${status ? `, status ${status}` : ''}): ${String(j.result || '').slice(0, 200)}`,
      retryable: status === 429 || status >= 500,
      auth: status === 401 || /log ?in|authenticat/i.test(String(j.result || '')),
    };
  }
  const u = j.usage || {};
  const models = Object.keys(j.modelUsage || {});
  return {
    text: typeof j.result === 'string' ? j.result : '',
    model: models[0] || null,
    stop: j.stop_reason,
    usage: {
      input_tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
      output_tokens: u.output_tokens ?? null,
      cost_usd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
    },
  };
}

export function createClaudeCliAdapter(cfg, deps = {}) {
  return {
    name: 'claude-cli',
    model: cfg.model || '(claude CLI default)',
    async complete({ system, messages }) {
      const bin = resolveBin('claude', cfg.claudeBin);
      if (!bin) throw new PagetreeError('usage', 'the claude CLI was not found on PATH. Install it, then run `pagetree auth login claude`.');
      const tries = 3;
      let last;
      for (let attempt = 0; attempt < tries; attempt++) {
        const cwd = freshWorkDir();
        const t0 = Date.now();
        let res;
        try {
          res = await run(bin, claudeArgs(cfg, system), { input: flattenMessages(messages), timeoutMs: cfg.timeoutMs, cwd, spawnImpl: deps.spawn });
        } finally {
          removeDir(cwd);
        }
        if (res.timedOut) {
          last = new PagetreeError('provider', `claude CLI did not answer within ${cfg.timeoutMs} ms`);
        } else {
          const r = parseClaudeResult(res.stdout);
          if (!r.error) return { ...r, model: r.model || cfg.model || null, latencyMs: Date.now() - t0 };
          last = new PagetreeError(r.auth ? 'auth' : 'provider', r.auth ? `${r.error}. Run \`pagetree auth login claude\`.` : r.error);
          if (!r.retryable) throw last;
        }
        if (attempt < tries - 1) await new Promise((ok) => setTimeout(ok, backoff(attempt)));
      }
      throw last;
    },
  };
}
