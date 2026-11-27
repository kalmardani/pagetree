// Generic OAuth 2.0 client with three grants, zero dependencies.
//  - client_credentials (RFC 6749 section 4.4), for gateways and machine identities
//  - authorization_code with PKCE S256 (RFC 7636) and a loopback redirect on 127.0.0.1
//    with a random port (RFC 8252)
//  - device authorization grant (RFC 8628), with authorization_pending and slow_down handling
// Tokens are cached through the store and refreshed before expiry. Nothing here logs a token.

import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { request, errorSnippet, safeUrl } from '../llm/http.js';
import { PagetreeError } from '../errors.js';
import { isSafeAuthUrl } from './browser.js';

export const EXPIRY_SKEW_MS = 60_000;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function pkcePair() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

export function challengeFor(verifier) {
  return base64url(createHash('sha256').update(verifier).digest());
}

function authErr(msg) {
  return new PagetreeError('auth', msg);
}

export function checkOAuthConfig(cfg, grant = cfg.grant) {
  const missing = [];
  if (!cfg.tokenUrl) missing.push('token URL (PAGETREE_OAUTH_TOKEN_URL)');
  if (!cfg.clientId) missing.push('client id (PAGETREE_OAUTH_CLIENT_ID)');
  if (grant === 'pkce' && !cfg.authUrl) missing.push('authorization URL (PAGETREE_OAUTH_AUTH_URL)');
  if (grant === 'device' && !cfg.deviceUrl) missing.push('device authorization URL (PAGETREE_OAUTH_DEVICE_URL)');
  if (grant === 'client_credentials' && !cfg.clientSecret) missing.push('client secret (PAGETREE_OAUTH_CLIENT_SECRET)');
  if (!['client_credentials', 'pkce', 'device'].includes(grant)) missing.push('grant (client_credentials, pkce or device)');
  for (const [k, v] of [['token URL', cfg.tokenUrl], ['authorization URL', cfg.authUrl], ['device URL', cfg.deviceUrl]]) {
    if (v && !isSafeAuthUrl(v)) missing.push(`${k} must be https (plain http only on 127.0.0.1 or localhost)`);
  }
  if (missing.length) throw new PagetreeError('usage', `OAuth configuration incomplete: ${missing.join('; ')}`);
}

/** POST a form to the token or device endpoint. Returns the parsed response, ok or not. */
async function postForm(url, params, cfg, opts) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') body.set(k, v);
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (cfg.clientSecret && cfg.clientAuth === 'basic') {
    headers.authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString('base64');
  } else if (cfg.clientSecret) {
    body.set('client_secret', cfg.clientSecret);
  }
  if (!body.has('client_id')) body.set('client_id', cfg.clientId);
  const res = await request(url, {
    headers,
    body: body.toString(),
    timeoutMs: opts.timeoutMs || 30000,
    retries: 2,
    retryOn: (s) => s >= 500,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
    errorCode: 'auth',
  });
  return { ...res, url };
}

export function toEntry(json, cfg, grant, now, previous) {
  if (!json || typeof json.access_token !== 'string' || !json.access_token) {
    throw authErr('token endpoint answered without an access_token');
  }
  const expiresIn = Number(json.expires_in);
  return {
    grant,
    token_url: cfg.tokenUrl,
    client_id: cfg.clientId,
    scope: json.scope || cfg.scope || null,
    token_type: json.token_type || 'Bearer',
    access_token: json.access_token,
    refresh_token: json.refresh_token || (previous && previous.refresh_token) || null,
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(now() + expiresIn * 1000).toISOString() : null,
    obtained_at: new Date(now()).toISOString(),
  };
}

function tokenError(res, what) {
  const code = res.json && res.json.error;
  return authErr(`${what} failed at ${safeUrl(res.url || '')}: ${res.status}${code ? ` ${code}` : ''} ${errorSnippet(res)}`.trim());
}

export async function clientCredentials(cfg, opts = {}) {
  const now = opts.now || Date.now;
  const res = await postForm(cfg.tokenUrl, { grant_type: 'client_credentials', scope: cfg.scope }, cfg, opts);
  if (res.status !== 200) throw tokenError(res, 'client credentials request');
  return toEntry(res.json, cfg, 'client_credentials', now);
}

export async function refresh(cfg, entry, opts = {}) {
  const now = opts.now || Date.now;
  const res = await postForm(cfg.tokenUrl, { grant_type: 'refresh_token', refresh_token: entry.refresh_token, scope: cfg.scope }, cfg, opts);
  if (res.status !== 200) throw tokenError(res, 'token refresh');
  return toEntry(res.json, cfg, entry.grant, now, entry);
}

/**
 * Authorization code with PKCE. Starts a loopback server on 127.0.0.1 with a random port,
 * opens (or prints) the authorization URL, checks `state`, then exchanges the code.
 */
export async function loginPkce(cfg, opts = {}) {
  const now = opts.now || Date.now;
  const print = opts.print || (() => {});
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(24));
  const timeoutMs = opts.timeoutMs || 300000;

  const server = http.createServer();
  await new Promise((ok, bad) => {
    server.once('error', bad);
    server.listen(0, '127.0.0.1', ok);
  });
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const u = new URL(cfg.authUrl);
  const q = { response_type: 'code', client_id: cfg.clientId, redirect_uri: redirectUri, scope: cfg.scope, state, code_challenge: challenge, code_challenge_method: 'S256' };
  for (const [k, v] of Object.entries(q)) if (v) u.searchParams.set(k, v);
  const authorizeUrl = u.toString();

  const codePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(authErr(`no sign in callback within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    server.on('request', (req, res) => {
      const url = new URL(req.url, redirectUri);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const page = (msg) => `<!doctype html><meta charset="utf-8"><title>pagetree</title><p>${msg}</p>`;
      const err = url.searchParams.get('error');
      if (url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(page('Sign in rejected because the state value did not match. You can close this tab.'));
        clearTimeout(timer);
        reject(authErr('sign in rejected: state mismatch in the callback (possible CSRF or a stale browser tab)'));
        return;
      }
      if (err) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(page('Sign in failed. You can close this tab.'));
        clearTimeout(timer);
        reject(authErr(`authorization server returned error ${err.slice(0, 80)}`));
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('Signed in. You can close this tab and return to the terminal.'));
      clearTimeout(timer);
      resolve(code);
    });
  });

  try {
    print(`Open this URL to sign in:\n  ${authorizeUrl}`);
    if (opts.openBrowser) opts.openBrowser(authorizeUrl);
    const code = await codePromise;
    const res = await postForm(cfg.tokenUrl, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }, cfg, opts);
    if (res.status !== 200) throw tokenError(res, 'code exchange');
    return toEntry(res.json, cfg, 'pkce', now);
  } finally {
    server.close();
  }
}

/** Device authorization grant: print the code and URL, then poll with the server interval. */
export async function loginDevice(cfg, opts = {}) {
  const now = opts.now || Date.now;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const print = opts.print || (() => {});
  const res = await postForm(cfg.deviceUrl, { scope: cfg.scope }, cfg, opts);
  if (res.status !== 200 || !res.json || !res.json.device_code) throw tokenError(res, 'device authorization request');
  const d = res.json;
  const verify = d.verification_uri_complete || d.verification_uri || d.verification_url;
  if (!verify || !isSafeAuthUrl(verify)) throw authErr('device authorization response has no usable https verification URL');
  print(`To sign in, open ${verify}\nand enter the code ${String(d.user_code || '').slice(0, 40)}`);
  let interval = Math.max(1, Number(d.interval) || 5);
  const deadline = now() + (Number(d.expires_in) > 0 ? Number(d.expires_in) * 1000 : 900000);
  for (;;) {
    await sleep(interval * 1000);
    if (now() > deadline) throw authErr('the device code expired before sign in finished');
    const t = await postForm(cfg.tokenUrl, { grant_type: DEVICE_GRANT, device_code: d.device_code }, cfg, opts);
    if (t.status === 200) return toEntry(t.json, cfg, 'device', now);
    const code = t.json && t.json.error;
    if (code === 'authorization_pending') continue;
    if (code === 'slow_down') {
      interval += 5;
      continue;
    }
    if (code === 'access_denied') throw authErr('sign in was denied');
    if (code === 'expired_token') throw authErr('the device code expired before sign in finished');
    throw tokenError(t, 'device token request');
  }
}

export function profileKey(cfg) {
  return cfg.profile || 'default';
}

export function entryMatches(entry, cfg) {
  return entry && entry.token_url === cfg.tokenUrl && entry.client_id === cfg.clientId;
}

export function isFresh(entry, now = Date.now()) {
  if (!entry || !entry.access_token) return false;
  if (!entry.expires_at) return true;
  return Date.parse(entry.expires_at) - now > EXPIRY_SKEW_MS;
}

/** Return a valid access token, refreshing or re-requesting as the grant allows. */
export async function getAccessToken(cfg, store, opts = {}) {
  const now = opts.now || Date.now;
  const key = profileKey(cfg);
  let entry = store.get(key);
  if (!entryMatches(entry, cfg)) entry = null;
  if (isFresh(entry, now())) return entry.access_token;
  if (entry && entry.refresh_token) {
    try {
      const next = await refresh(cfg, entry, opts);
      store.set(key, next);
      return next.access_token;
    } catch (e) {
      if (cfg.grant !== 'client_credentials') {
        store.delete(key);
        throw authErr(`${e.message}. Run \`pagetree auth login\` again.`);
      }
    }
  }
  if (cfg.grant === 'client_credentials') {
    const next = await clientCredentials(cfg, opts);
    store.set(key, next);
    return next.access_token;
  }
  throw authErr('no valid OAuth token. Run `pagetree auth login` first.');
}

export async function login(cfg, store, opts = {}) {
  checkOAuthConfig(cfg);
  let entry;
  if (cfg.grant === 'client_credentials') entry = await clientCredentials(cfg, opts);
  else if (cfg.grant === 'pkce') entry = await loginPkce(cfg, opts);
  else entry = await loginDevice(cfg, opts);
  store.set(profileKey(cfg), entry);
  return entry;
}

/** Status without secrets. */
export function describeEntry(entry, now = Date.now()) {
  if (!entry) return { present: false };
  return {
    present: true,
    grant: entry.grant,
    valid: isFresh(entry, now),
    expires_at: entry.expires_at,
    has_refresh_token: Boolean(entry.refresh_token),
    scope: entry.scope,
  };
}
