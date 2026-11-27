// Command line interface. Every feature is reachable from here, the MCP server included.
// Results go to stdout, progress and logs to stderr, errors to stderr with a stable exit code.

import path from 'node:path';
import { resolveConfig, publicConfig, loadOAuthConfig } from './config.js';
import { createAdapter, createSession } from './llm/provider.js';
import { buildIndex } from './build.js';
import { saveIndex, loadIndex, openIndex } from './indexfile.js';
import { ask } from './ask.js';
import { renderTree, renderAnswer, renderPlan, renderUsage, renderNode } from './render.js';
import { PagetreeError, exitCodeFor } from './errors.js';
import { VERSION } from './version.js';
import { createMcpServer, runStdio } from './mcp.js';
import { createTokenStore, configDir } from './auth/store.js';
import { login as oauthLogin, profileKey, checkOAuthConfig } from './auth/oauth.js';
import { openBrowser } from './auth/browser.js';
import { loginClaude, loginChatgpt } from './auth/subscription.js';
import { authStatus, renderAuthStatus } from './auth/status.js';
import { sanitizeForTerminal } from './text.js';

const BOOLEAN = new Set(['json', 'plan', 'summaries', 'allow-stale', 'verbose', 'quiet', 'help', 'version', 'no-browser']);
const VALUED = new Set([
  'output', 'provider', 'model', 'base-url', 'auth', 'api-key-env', 'timeout', 'max-calls', 'oauth-config', 'grant', 'profile',
  'leaf-tokens', 'summary-tokens', 'fanout', 'window-tokens', 'split', 'concurrency', 'format',
  'beam', 'max-steps', 'read-tokens', 'unsupported', 'source', 'depth', 'offset', 'limit',
]);
const SHORT = { o: 'output', h: 'help', v: 'version', m: 'model', p: 'provider' };

export const HELP = `pagetree ${VERSION}
Retrieval over long documents without embeddings. Builds a table of contents tree, lets a
language model navigate it, and answers with citations checked against the source.

Usage
  pagetree index <file> [-o out.json] [--plan] [--leaf-tokens 1500] [--summary-tokens 80]
                 [--fanout 12] [--window-tokens 3000] [--split model|deterministic]
                 [--concurrency 3] [--format markdown|html|text|pdf]
  pagetree ask <index.json> "question" [--beam 3] [--max-steps 6] [--read-tokens 6000]
                 [--unsupported drop|flag] [--json] [--allow-stale] [--source file]
  pagetree show <index.json> [--summaries] [--depth n] [--json]
  pagetree read <index.json> <path> [--offset 0] [--limit 200] [--json] [--allow-stale]
  pagetree mcp <index.json> [more.json ...]
  pagetree auth login [--grant pkce|device|client_credentials] [--no-browser]
  pagetree auth login claude      sign in the official claude CLI with your subscription
  pagetree auth login chatgpt     sign in the official codex CLI with your subscription
  pagetree auth status [--json]
  pagetree auth logout [--profile name]

Model connection (flags or env)
  --provider claude-cli|codex-cli|anthropic|openai|fake   PAGETREE_PROVIDER (default claude-cli)
  --model id                                              PAGETREE_MODEL
  --base-url url                                          PAGETREE_BASE_URL
  --auth api-key|oauth|subscription|none                  PAGETREE_AUTH
  --api-key-env NAME                                      PAGETREE_API_KEY_ENV
  --timeout ms   --max-calls n   --oauth-config file   --verbose

Exit codes: 0 ok, 2 usage, 3 input, 4 stale index, 5 model output invalid, 6 provider,
7 call cap reached, 8 auth, 1 internal.`;

export function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    let key = null;
    let val;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) val = a.slice(eq + 1);
    } else if (/^-[a-z]$/i.test(a)) key = SHORT[a[1]] || a.slice(1);
    else {
      pos.push(a);
      continue;
    }
    if (BOOLEAN.has(key)) {
      if (val !== undefined) throw new PagetreeError('usage', `--${key} takes no value`);
      flags[key] = true;
    } else if (VALUED.has(key)) {
      if (val === undefined) {
        val = argv[++i];
        if (val === undefined) throw new PagetreeError('usage', `--${key} needs a value`);
      }
      flags[key] = val;
    } else throw new PagetreeError('usage', `unknown option ${a}. Run pagetree --help.`);
  }
  return { flags, pos };
}

function int(flags, key, fallback) {
  if (flags[key] === undefined) return fallback;
  const n = Number(flags[key]);
  if (!Number.isInteger(n)) throw new PagetreeError('usage', `--${key} must be an integer, got ${flags[key]}`);
  return n;
}

function makeSession(cfg, stderr, maxCallsDefault) {
  const log = cfg.log ? (line) => stderr.write(JSON.stringify(line) + '\n') : null;
  return createSession(createAdapter(cfg), { maxCalls: cfg.maxCalls || maxCallsDefault, log });
}

function defaultOutput(file) {
  const dir = path.dirname(file);
  return path.join(dir, `${path.basename(file).replace(/\.[^.]+$/, '')}.pagetree.json`);
}

/** Run the CLI. Returns the exit code. io lets tests capture output. */
export async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;
  const out = (s) => stdout.write(s + '\n');
  try {
    const { flags, pos } = parseArgs(argv);
    if (flags.version) {
      out(VERSION);
      return 0;
    }
    const cmd = pos[0];
    if (flags.help || !cmd || cmd === 'help') {
      out(HELP);
      return cmd || flags.help ? 0 : 2;
    }
    switch (cmd) {
      case 'index':
        return await cmdIndex(pos, flags, env, out, stderr);
      case 'ask':
        return await cmdAsk(pos, flags, env, out, stderr);
      case 'show':
        return await cmdShow(pos, flags, out);
      case 'read':
        return await cmdRead(pos, flags, out);
      case 'mcp':
        return await cmdMcp(pos, flags, env, io);
      case 'auth':
        return await cmdAuth(pos, flags, env, out, stderr);
      default:
        throw new PagetreeError('usage', `unknown command ${cmd}. Run pagetree --help.`);
    }
  } catch (e) {
    const code = exitCodeFor(e);
    const msg = e instanceof PagetreeError ? e.message : `internal error: ${e && e.message}`;
    stderr.write(`pagetree: ${sanitizeForTerminal(msg)}\n`);
    if (!(e instanceof PagetreeError) && env.PAGETREE_DEBUG === '1') stderr.write(String(e && e.stack) + '\n');
    return code;
  }
}

async function cmdIndex(pos, flags, env, out, stderr) {
  const file = pos[1];
  if (!file || pos.length > 2) throw new PagetreeError('usage', 'usage: pagetree index <file> [-o out.json]');
  const outPath = flags.output || defaultOutput(file);
  const common = {
    leafTokens: int(flags, 'leaf-tokens'),
    summaryTokens: int(flags, 'summary-tokens'),
    fanout: int(flags, 'fanout'),
    windowTokens: int(flags, 'window-tokens'),
    split: flags.split,
    concurrency: Math.max(1, Math.min(16, int(flags, 'concurrency', 3))),
    format: flags.format,
  };
  if (flags.plan) {
    const { plan } = await buildIndex(file, { ...common, plan: true });
    if (flags.json) out(JSON.stringify(plan, null, 2));
    else out(renderPlan(plan));
    return 0;
  }
  const cfg = resolveConfig(flags, env);
  const session = makeSession(cfg, stderr, 500);
  const progress = flags.quiet ? null : (p) => stderr.write(`\r${p.task} ${p.done}/${p.total}   `);
  const { index } = await buildIndex(file, { ...common, session, maxCalls: cfg.maxCalls || 500, onProgress: progress });
  if (progress) stderr.write('\n');
  const saved = saveIndex(index, outPath, file);
  if (flags.json) out(JSON.stringify({ index: outPath, nodes: saved.nodes.length, usage: saved.usage, connection: publicConfig(cfg) }, null, 2));
  else {
    out(`wrote ${outPath} (${saved.nodes.length} nodes)`);
    out(`usage: ${renderUsage(session.summary())}`);
  }
  return 0;
}

async function cmdAsk(pos, flags, env, out, stderr) {
  const [_, indexPath, ...rest] = pos;
  const question = rest.join(' ');
  if (!indexPath || !question) throw new PagetreeError('usage', 'usage: pagetree ask <index.json> "question"');
  const cfg = resolveConfig(flags, env);
  const session = makeSession(cfg, stderr, 12);
  const r = await ask(indexPath, question, {
    session,
    beam: int(flags, 'beam', 3),
    maxSteps: Math.max(1, Math.min(12, int(flags, 'max-steps', 6))),
    readBudget: int(flags, 'read-tokens', 6000),
    unsupported: flags.unsupported || 'drop',
    source: flags.source,
    allowStale: flags['allow-stale'],
  });
  if (flags.json) out(JSON.stringify(r, null, 2));
  else out(renderAnswer(r));
  return 0;
}

async function cmdShow(pos, flags, out) {
  const indexPath = pos[1];
  if (!indexPath) throw new PagetreeError('usage', 'usage: pagetree show <index.json>');
  const index = loadIndex(indexPath);
  let freshness = 'not checked';
  try {
    const o = await openIndex(indexPath, { source: flags.source, allowStale: true });
    freshness = o.stale ? 'STALE (source changed, run pagetree index again)' : 'current';
  } catch (e) {
    freshness = `source not available (${e.message})`;
  }
  if (flags.json) {
    out(JSON.stringify({ source: index.source, freshness, usage: index.usage || null, nodes: index.nodes }, null, 2));
    return 0;
  }
  out(renderTree(index, { summaries: Boolean(flags.summaries), maxDepth: flags.depth === undefined ? Infinity : int(flags, 'depth') }));
  out(`\nsource: ${sanitizeForTerminal(freshness)}`);
  if (index.usage) out(`built with ${renderUsage(index.usage)}`);
  return 0;
}

async function cmdRead(pos, flags, out) {
  const [_, indexPath, nodePath] = pos;
  if (!indexPath || nodePath === undefined) throw new PagetreeError('usage', 'usage: pagetree read <index.json> <path>  (path "" is the whole document)');
  const o = await openIndex(indexPath, { source: flags.source, allowStale: flags['allow-stale'] });
  const n = o.byPath.get(nodePath);
  if (!n) throw new PagetreeError('usage', `no section with path ${nodePath}. Run pagetree show to list paths.`);
  const offset = Math.max(0, int(flags, 'offset', 0));
  const limit = Math.max(1, Math.min(5000, int(flags, 'limit', 200)));
  if (flags.json) {
    const from = n.start + offset;
    const to = Math.min(n.end, from + limit - 1);
    out(JSON.stringify({ path: n.path, title: n.title, start: n.start, end: n.end, lines: from <= n.end ? o.lines.slice(from - 1, to).map((text, i) => ({ line: from + i, text })) : [] }, null, 2));
  } else out(renderNode(n, o.lines, { offset, limit }));
  return 0;
}

async function cmdMcp(pos, flags, env, io) {
  const indexPaths = pos.slice(1);
  const cfg = resolveConfig(flags, env);
  const server = createMcpServer({ indexPaths, cfg, sourceOverride: flags.source });
  (io.stderr || process.stderr).write(`pagetree mcp serving ${server.names.join(', ')} over stdio (${cfg.provider})\n`);
  await runStdio(server, { input: io.stdin || process.stdin, output: io.stdout || process.stdout });
  return 0;
}

async function cmdAuth(pos, flags, env, out, stderr) {
  const sub = pos[1];
  const target = pos[2];
  const cfgForCli = { claudeBin: env.PAGETREE_CLAUDE_BIN, codexBin: env.PAGETREE_CODEX_BIN, model: flags.model || env.PAGETREE_MODEL, timeoutMs: 180000 };
  const say = (s) => stderr.write(s + '\n');
  if (sub === 'status') {
    const s = await authStatus(flags, env);
    if (flags.json) out(JSON.stringify(s, null, 2));
    else out(renderAuthStatus(s));
    return 0;
  }
  if (sub === 'login') {
    if (target === 'claude') {
      await loginClaude(cfgForCli, { print: say });
      return 0;
    }
    if (target === 'chatgpt') {
      await loginChatgpt({ ...cfgForCli, model: undefined }, { print: say });
      return 0;
    }
    if (target) throw new PagetreeError('usage', `unknown login target ${target} (expected claude, chatgpt, or nothing for OAuth)`);
    const oc = loadOAuthConfig(flags, env);
    checkOAuthConfig(oc);
    const store = createTokenStore(configDir(env));
    const entry = await oauthLogin(oc, store, { print: say, openBrowser: flags['no-browser'] ? null : openBrowser });
    out(`signed in, profile ${profileKey(oc)}, grant ${entry.grant}${entry.expires_at ? `, token valid until ${entry.expires_at}` : ''}`);
    return 0;
  }
  if (sub === 'logout') {
    if (target === 'claude' || target === 'chatgpt') {
      out(`pagetree does not hold those credentials. Run \`${target === 'claude' ? 'claude auth logout' : 'codex logout'}\` to sign the official CLI out.`);
      return 0;
    }
    const oc = loadOAuthConfig(flags, env);
    const store = createTokenStore(configDir(env));
    const had = store.delete(profileKey(oc));
    out(had ? `removed cached token for profile ${profileKey(oc)}` : `no cached token for profile ${profileKey(oc)}`);
    return 0;
  }
  throw new PagetreeError('usage', 'usage: pagetree auth login [claude|chatgpt] | status | logout');
}
