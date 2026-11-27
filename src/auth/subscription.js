// Use your own subscription through the official vendor CLIs. pagetree only starts those CLIs
// (their sign in, their status command, a tiny print mode probe). It never opens, reads, copies
// or forwards the credentials they store, and never calls a vendor API with them.

import { resolveBin, run } from '../llm/subprocess.js';
import { createClaudeCliAdapter } from '../llm/claude-cli.js';
import { PagetreeError } from '../errors.js';

export const INSTALL_HINT = {
  claude: 'Install the official Claude Code CLI (see https://claude.com/claude-code, or `npm install -g @anthropic-ai/claude-code`), then run this command again.',
  codex: 'Install the official Codex CLI (`npm install -g @openai/codex`), then run this command again.',
};

function tryResolve(name, override) {
  try {
    return { bin: resolveBin(name, override) };
  } catch (e) {
    return { error: e.message };
  }
}

/** Status of the claude CLI from its own `auth status --json` command. No model call. */
export async function claudeStatus(cfg = {}) {
  const r = tryResolve('claude', cfg.claudeBin);
  if (r.error) return { installed: false, ready: false, note: r.error };
  if (!r.bin) return { installed: false, ready: false, note: INSTALL_HINT.claude };
  const res = await run(r.bin, ['auth', 'status', '--json'], { timeoutMs: 30000 });
  try {
    const j = JSON.parse(res.stdout);
    // Only these fields are read. Identity fields such as the e-mail are ignored on purpose.
    return { installed: true, ready: j.loggedIn === true, method: typeof j.authMethod === 'string' ? j.authMethod : null };
  } catch {
    return { installed: true, ready: null, note: 'could not read `claude auth status`; run `pagetree auth login claude` to probe' };
  }
}

/** Tiny print mode probe: proves the CLI can answer, which is what the adapter needs. */
export async function claudeProbe(cfg = {}) {
  const adapter = createClaudeCliAdapter({ ...cfg, timeoutMs: cfg.timeoutMs || 120000 });
  try {
    const r = await adapter.complete({ system: 'Reply with the single word ok.', messages: [{ role: 'user', content: 'ok?' }], maxTokens: 5 });
    return { ok: true, model: r.model, cost_usd: r.usage.cost_usd };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function loginClaude(cfg = {}, { print = () => {} } = {}) {
  const r = tryResolve('claude', cfg.claudeBin);
  if (r.error) throw new PagetreeError('usage', r.error);
  if (!r.bin) throw new PagetreeError('usage', `the claude CLI was not found on PATH. ${INSTALL_HINT.claude}`);
  print('Checking whether the claude CLI is signed in (one tiny request)...');
  const first = await claudeProbe(cfg);
  if (first.ok) {
    print('The claude CLI is already signed in. pagetree will use it with --provider claude-cli.');
    return { ready: true, already: true };
  }
  print('Not signed in yet. Starting the official claude sign in in this terminal.');
  const res = await run(r.bin, ['auth', 'login'], { inheritStdio: true, timeoutMs: 0 });
  if (res.code !== 0) throw new PagetreeError('auth', `claude sign in exited with code ${res.code}`);
  const second = await claudeProbe(cfg);
  if (!second.ok) throw new PagetreeError('auth', `the claude CLI still cannot answer: ${second.error}`);
  print('Signed in. pagetree will use it with --provider claude-cli.');
  return { ready: true, already: false };
}

/** Status of the codex CLI from its own `codex login status` command. No model call. */
export async function codexStatus(cfg = {}) {
  const r = tryResolve('codex', cfg.codexBin);
  if (r.error) return { installed: false, ready: false, note: r.error };
  if (!r.bin) return { installed: false, ready: false, note: INSTALL_HINT.codex };
  const res = await run(r.bin, ['login', 'status'], { timeoutMs: 30000 });
  const line = (res.stdout + '\n' + res.stderr).split('\n').map((s) => s.trim()).find(Boolean) || '';
  const method = /chatgpt/i.test(line) ? 'chatgpt' : /api key/i.test(line) ? 'api-key' : null;
  return { installed: true, ready: res.code === 0, method };
}

export async function loginChatgpt(cfg = {}, { print = () => {} } = {}) {
  const r = tryResolve('codex', cfg.codexBin);
  if (r.error) throw new PagetreeError('usage', r.error);
  if (!r.bin) throw new PagetreeError('usage', `the codex CLI was not found on PATH. ${INSTALL_HINT.codex}`);
  const first = await codexStatus(cfg);
  if (first.ready) {
    print('The codex CLI is already signed in. pagetree will use it with --provider codex-cli.');
    return { ready: true, already: true };
  }
  print('Not signed in yet. Starting the official codex sign in in this terminal.');
  const res = await run(r.bin, ['login'], { inheritStdio: true, timeoutMs: 0 });
  if (res.code !== 0) throw new PagetreeError('auth', `codex sign in exited with code ${res.code}`);
  const second = await codexStatus(cfg);
  if (!second.ready) throw new PagetreeError('auth', 'the codex CLI still reports that it is not signed in');
  print('Signed in. pagetree will use it with --provider codex-cli.');
  return { ready: true, already: false };
}
