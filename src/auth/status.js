// `pagetree auth status`: for every connection type, is it ready. Never prints a secret, a key
// length, a token or an account identity.

import { loadOAuthConfig } from '../config.js';
import { createTokenStore, configDir } from './store.js';
import { describeEntry, entryMatches, profileKey } from './oauth.js';
import { claudeStatus, codexStatus } from './subscription.js';

export async function authStatus(flags, env, deps = {}) {
  const keyEnvs = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
  if (env.PAGETREE_API_KEY_ENV && !keyEnvs.includes(env.PAGETREE_API_KEY_ENV)) keyEnvs.push(env.PAGETREE_API_KEY_ENV);
  const apiKeys = keyEnvs.map((name) => ({ env: name, ready: Boolean(env[name]) }));

  const oc = loadOAuthConfig(flags, env);
  const configured = Boolean(oc.tokenUrl && oc.clientId);
  const store = deps.store || createTokenStore(configDir(env));
  const entry = store.get(profileKey(oc));
  const token = configured && entryMatches(entry, oc) ? describeEntry(entry) : { present: false };
  const oauth = {
    configured,
    profile: profileKey(oc),
    grant: oc.grant,
    token,
    ready: Boolean(token.present && (token.valid || token.has_refresh_token || oc.grant === 'client_credentials')),
    cache_file: store.file,
  };

  const cfg = { claudeBin: env.PAGETREE_CLAUDE_BIN, codexBin: env.PAGETREE_CODEX_BIN };
  const [claude, codex] = await Promise.all([
    (deps.claudeStatus || claudeStatus)(cfg).catch((e) => ({ installed: false, ready: false, note: e.message })),
    (deps.codexStatus || codexStatus)(cfg).catch((e) => ({ installed: false, ready: false, note: e.message })),
  ]);
  return { api_key: apiKeys, oauth, claude_cli: claude, codex_cli: codex };
}

const yes = (b) => (b === null || b === undefined ? 'unknown' : b ? 'ready' : 'not ready');

export function renderAuthStatus(s) {
  const out = [];
  out.push('api-key');
  for (const k of s.api_key) out.push(`  ${k.env.padEnd(22)} ${k.ready ? 'set' : 'not set'}`);
  out.push('oauth');
  if (!s.oauth.configured) out.push('  not configured (set PAGETREE_OAUTH_TOKEN_URL and PAGETREE_OAUTH_CLIENT_ID, or PAGETREE_OAUTH_CONFIG)');
  else {
    const t = s.oauth.token;
    out.push(`  profile ${s.oauth.profile}, grant ${s.oauth.grant}: ${yes(s.oauth.ready)}`);
    if (!t.present) out.push('  no cached token, run `pagetree auth login`');
    else out.push(`  token ${t.valid ? 'valid' : 'expired'}${t.expires_at ? ` until ${t.expires_at}` : ' (no expiry given)'}, refresh token ${t.has_refresh_token ? 'yes' : 'no'}`);
    out.push(`  cache ${s.oauth.cache_file}`);
  }
  out.push('subscription, claude CLI (--provider claude-cli)');
  out.push(`  ${s.claude_cli.installed ? `installed, ${yes(s.claude_cli.ready)}${s.claude_cli.method ? ` (${s.claude_cli.method})` : ''}` : 'not installed'}${s.claude_cli.ready === false && s.claude_cli.installed ? ', run `pagetree auth login claude`' : ''}`);
  if (s.claude_cli.note && !s.claude_cli.installed) out.push(`  ${s.claude_cli.note}`);
  out.push('subscription, codex CLI (--provider codex-cli)');
  out.push(`  ${s.codex_cli.installed ? `installed, ${yes(s.codex_cli.ready)}${s.codex_cli.method ? ` (${s.codex_cli.method})` : ''}` : 'not installed'}${s.codex_cli.ready === false && s.codex_cli.installed ? ', run `pagetree auth login chatgpt`' : ''}`);
  if (s.codex_cli.note && !s.codex_cli.installed) out.push(`  ${s.codex_cli.note}`);
  return out.join('\n');
}
