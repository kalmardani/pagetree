// Configuration from CLI flags and environment variables. Flags win over env. Keys are read
// from env at call time and are never stored in the config object that gets logged.

import fs from 'node:fs';
import { PagetreeError } from './errors.js';

export const PROVIDERS = ['openai', 'anthropic', 'claude-cli', 'codex-cli', 'fake'];
export const AUTH_MODES = ['api-key', 'oauth', 'subscription', 'none'];

const DEFAULT_KEY_ENV = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };

export function isLoopback(url) {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
}

/**
 * Decision table for adapter and auth (DEVELOPER.md, "Decision tables", table A).
 * Returns the auth mode to use or throws a usage error that names the allowed modes.
 */
export function resolveAuthMode(provider, requested, { baseUrl, env }) {
  const allowed = {
    openai: ['api-key', 'oauth', 'none'],
    anthropic: ['api-key', 'oauth', 'none'],
    'claude-cli': ['subscription'],
    'codex-cli': ['subscription'],
    fake: ['none'],
  }[provider];
  let mode = requested;
  if (!mode) {
    if (provider === 'claude-cli' || provider === 'codex-cli') mode = 'subscription';
    else if (provider === 'fake') mode = 'none';
    else if (!env[DEFAULT_KEY_ENV[provider]] && !env.PAGETREE_API_KEY_ENV && baseUrl && isLoopback(baseUrl)) mode = 'none';
    else mode = 'api-key';
  }
  if (!AUTH_MODES.includes(mode)) throw new PagetreeError('usage', `unknown auth mode ${mode} (expected ${AUTH_MODES.join(', ')})`);
  if (!allowed.includes(mode)) {
    throw new PagetreeError('usage', `provider ${provider} works with auth ${allowed.join(' or ')}, not ${mode}`);
  }
  if (mode === 'none' && (provider === 'openai' || provider === 'anthropic') && !(baseUrl && isLoopback(baseUrl))) {
    throw new PagetreeError('usage', 'auth none is only allowed with a loopback base URL (a local server)');
  }
  return mode;
}

function num(v, name, { min = 1, max = Number.MAX_SAFE_INTEGER, int = true } = {}) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || (int && !Number.isInteger(n)) || n < min || n > max) {
    throw new PagetreeError('usage', `${name} must be ${int ? 'an integer' : 'a number'} between ${min} and ${max}, got ${v}`);
  }
  return n;
}

export function loadOAuthConfig(flags, env) {
  let file = {};
  const p = flags['oauth-config'] || env.PAGETREE_OAUTH_CONFIG;
  if (p) {
    try {
      file = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      throw new PagetreeError('usage', `cannot read OAuth config ${p}: ${e.message}`);
    }
    if ('client_secret' in file) {
      throw new PagetreeError('usage', 'do not put client_secret in the OAuth config file; set PAGETREE_OAUTH_CLIENT_SECRET or name another variable in client_secret_env');
    }
  }
  const secretEnv = file.client_secret_env || 'PAGETREE_OAUTH_CLIENT_SECRET';
  return {
    grant: flags.grant || env.PAGETREE_OAUTH_GRANT || file.grant || 'pkce',
    tokenUrl: env.PAGETREE_OAUTH_TOKEN_URL || file.token_url,
    authUrl: env.PAGETREE_OAUTH_AUTH_URL || file.auth_url,
    deviceUrl: env.PAGETREE_OAUTH_DEVICE_URL || file.device_url,
    clientId: env.PAGETREE_OAUTH_CLIENT_ID || file.client_id,
    clientSecret: env[secretEnv] || undefined,
    clientAuth: env.PAGETREE_OAUTH_CLIENT_AUTH || file.client_auth || 'post',
    scope: env.PAGETREE_OAUTH_SCOPE || file.scope,
    profile: flags.profile || env.PAGETREE_OAUTH_PROFILE || file.profile || 'default',
  };
}

export function resolveConfig(flags = {}, env = process.env) {
  const provider = flags.provider || env.PAGETREE_PROVIDER || 'claude-cli';
  if (!PROVIDERS.includes(provider)) {
    throw new PagetreeError('usage', `unknown provider ${provider} (expected ${PROVIDERS.join(', ')})`);
  }
  const baseUrl = flags['base-url'] || env.PAGETREE_BASE_URL || undefined;
  const auth = resolveAuthMode(provider, flags.auth || env.PAGETREE_AUTH, { baseUrl, env });
  const temperature = env.PAGETREE_TEMPERATURE !== undefined && env.PAGETREE_TEMPERATURE !== ''
    ? num(env.PAGETREE_TEMPERATURE, 'PAGETREE_TEMPERATURE', { min: 0, max: 2, int: false })
    : undefined;
  return {
    provider,
    model: flags.model || env.PAGETREE_MODEL || undefined,
    baseUrl,
    auth,
    apiKeyEnv: flags['api-key-env'] || env.PAGETREE_API_KEY_ENV || DEFAULT_KEY_ENV[provider],
    timeoutMs: num(flags.timeout || env.PAGETREE_TIMEOUT_MS, 'timeout', { min: 1000, max: 3600000 }) || 180000,
    maxCalls: num(flags['max-calls'] || env.PAGETREE_MAX_CALLS, 'max-calls'),
    temperature,
    claudeBin: env.PAGETREE_CLAUDE_BIN || undefined,
    codexBin: env.PAGETREE_CODEX_BIN || undefined,
    claudeSafeMode: env.PAGETREE_CLAUDE_SAFE_MODE !== '0',
    codexUserConfig: env.PAGETREE_CODEX_USER_CONFIG === '1',
    fakeScriptFile: env.PAGETREE_FAKE_SCRIPT || undefined,
    log: Boolean(flags.verbose) || env.PAGETREE_LOG === '1',
    oauth: auth === 'oauth' ? loadOAuthConfig(flags, env) : null,
    env,
  };
}

/** A copy that is safe to print or log: no env, no secrets. */
export function publicConfig(cfg) {
  return { provider: cfg.provider, model: cfg.model || null, base_url: cfg.baseUrl || null, auth: cfg.auth };
}
