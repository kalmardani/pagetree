// OAuth client against a local fake authorization server started inside the test. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  pkcePair, challengeFor, loginPkce, loginDevice, clientCredentials, getAccessToken, login, describeEntry, checkOAuthConfig,
} from '../src/auth/oauth.js';
import { createTokenStore, configDir } from '../src/auth/store.js';
import { tmpDir } from '../testdata/helpers.js';

function startFakeAuthServer(opts = {}) {
  const state = { codes: new Map(), tokenRequests: [], devicePolls: 0, refreshCount: 0, issued: 0 };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/authorize') {
      const redirect = url.searchParams.get('redirect_uri');
      const code = `code-${state.codes.size + 1}`;
      state.codes.set(code, { challenge: url.searchParams.get('code_challenge'), method: url.searchParams.get('code_challenge_method'), redirect });
      const back = new URL(redirect);
      back.searchParams.set('code', code);
      back.searchParams.set('state', opts.badState ? 'forged' : url.searchParams.get('state'));
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const p = new URLSearchParams(body);
      const json = (status, obj) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
      if (url.pathname === '/device') {
        json(200, { device_code: 'dev-1', user_code: 'ABCD-EFGH', verification_uri: 'https://auth.example.invalid/activate', interval: 1, expires_in: 600 });
        return;
      }
      if (url.pathname !== '/token') return json(404, {});
      state.tokenRequests.push(Object.fromEntries(p));
      const grant = p.get('grant_type');
      const issue = (extra = {}) => {
        state.issued++;
        json(200, { access_token: `at-${state.issued}`, token_type: 'Bearer', expires_in: opts.expiresIn ?? 3600, refresh_token: `rt-${state.issued}`, ...extra });
      };
      if (grant === 'authorization_code') {
        const c = state.codes.get(p.get('code'));
        if (!c || c.method !== 'S256' || challengeFor(p.get('code_verifier')) !== c.challenge || p.get('redirect_uri') !== c.redirect) {
          return json(400, { error: 'invalid_grant' });
        }
        state.codes.delete(p.get('code'));
        return issue();
      }
      if (grant === 'client_credentials') {
        if (p.get('client_secret') !== 's3cret') return json(401, { error: 'invalid_client' });
        return issue({ refresh_token: undefined });
      }
      if (grant === 'refresh_token') {
        state.refreshCount++;
        if (opts.refreshFails) return json(400, { error: 'invalid_grant' });
        return issue();
      }
      if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
        state.devicePolls++;
        const script = opts.deviceScript || ['authorization_pending', 'slow_down', 'ok'];
        const step = script[Math.min(state.devicePolls - 1, script.length - 1)];
        if (step === 'ok') return issue();
        return json(400, { error: step });
      }
      json(400, { error: 'unsupported_grant_type' });
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    resolve({ srv, base, state, cfg: { tokenUrl: `${base}/token`, authUrl: `${base}/authorize`, deviceUrl: `${base}/device`, clientId: 'cli-1', scope: 'read', profile: 'test' } });
  }));
}

// The browser stand-in: follow the authorize redirect to the loopback callback.
const fakeBrowser = (url) => {
  fetch(url, { redirect: 'follow' }).catch(() => {});
};

test('PKCE verifier and S256 challenge match the RFC 7636 example', () => {
  assert.equal(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const p = pkcePair();
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(p.challenge, challengeFor(p.verifier));
});

test('authorization code with PKCE over a loopback redirect', async () => {
  const { srv, cfg, state } = await startFakeAuthServer();
  try {
    const printed = [];
    const entry = await loginPkce({ ...cfg, grant: 'pkce' }, { openBrowser: fakeBrowser, print: (s) => printed.push(s), timeoutMs: 10000 });
    assert.equal(entry.access_token, 'at-1');
    assert.equal(entry.refresh_token, 'rt-1');
    assert.equal(entry.grant, 'pkce');
    const req = state.tokenRequests[0];
    assert.match(req.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.ok(req.code_verifier);
    assert.match(printed[0], /code_challenge_method=S256/);
    assert.ok(!printed.join('').includes('at-1'));
  } finally {
    srv.close();
  }
});

test('a callback with the wrong state is rejected and no code is exchanged', async () => {
  const { srv, cfg, state } = await startFakeAuthServer({ badState: true });
  try {
    await assert.rejects(loginPkce({ ...cfg, grant: 'pkce' }, { openBrowser: fakeBrowser, timeoutMs: 10000 }), /state mismatch/);
    assert.equal(state.tokenRequests.length, 0);
  } finally {
    srv.close();
  }
});

test('client credentials grant sends the secret and caches the token', async () => {
  const { srv, cfg } = await startFakeAuthServer();
  try {
    const c = { ...cfg, grant: 'client_credentials', clientSecret: 's3cret' };
    const entry = await clientCredentials(c);
    assert.equal(entry.access_token, 'at-1');
    await assert.rejects(clientCredentials({ ...c, clientSecret: 'wrong' }), /invalid_client/);
  } finally {
    srv.close();
  }
});

test('device grant handles authorization_pending and slow_down with the server interval', async () => {
  const { srv, cfg, state } = await startFakeAuthServer();
  try {
    const waits = [];
    const printed = [];
    const entry = await loginDevice({ ...cfg, grant: 'device' }, { sleep: async (ms) => waits.push(ms), print: (s) => printed.push(s) });
    assert.equal(entry.access_token, 'at-1');
    assert.equal(state.devicePolls, 3);
    assert.deepEqual(waits, [1000, 1000, 6000]);
    assert.match(printed[0], /ABCD-EFGH/);
  } finally {
    srv.close();
  }
});

test('device grant stops on access_denied', async () => {
  const { srv, cfg } = await startFakeAuthServer({ deviceScript: ['authorization_pending', 'access_denied'] });
  try {
    await assert.rejects(loginDevice({ ...cfg, grant: 'device' }, { sleep: async () => {} }), /denied/);
  } finally {
    srv.close();
  }
});

test('cached token is reused, refreshed before expiry, and dropped when refresh fails', async () => {
  const { srv, cfg, state } = await startFakeAuthServer({ expiresIn: 3600 });
  const dir = tmpDir();
  try {
    const store = createTokenStore(dir);
    const c = { ...cfg, grant: 'device' };
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const now = () => clock;
    await login(c, store, { sleep: async () => {}, now });
    assert.equal(await getAccessToken(c, store, { now }), 'at-1');
    assert.equal(state.refreshCount, 0);
    clock += 3600 * 1000 - 30 * 1000; // 30 s before expiry, inside the 60 s skew
    assert.equal(await getAccessToken(c, store, { now }), 'at-2');
    assert.equal(state.refreshCount, 1);
    assert.equal(describeEntry(store.get('test'), clock).valid, true);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
    }
    const raw = fs.readFileSync(store.file, 'utf8');
    assert.ok(raw.includes('at-2'));
  } finally {
    srv.close();
  }
  const { srv: srv2, cfg: cfg2 } = await startFakeAuthServer({ refreshFails: true });
  try {
    const store = createTokenStore(tmpDir());
    const c = { ...cfg2, grant: 'device' };
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const now = () => clock;
    await login(c, store, { sleep: async () => {}, now });
    clock += 7200 * 1000; // expired
    await assert.rejects(getAccessToken(c, store, { now }), /auth login/);
    assert.equal(store.get('test'), null);
  } finally {
    srv2.close();
  }
});

test('expired client credentials token is simply requested again', async () => {
  const { srv, cfg, state } = await startFakeAuthServer({ expiresIn: 60 });
  try {
    const store = createTokenStore(tmpDir());
    const c = { ...cfg, grant: 'client_credentials', clientSecret: 's3cret' };
    assert.equal(await getAccessToken(c, store), 'at-1');
    assert.equal(await getAccessToken(c, store), 'at-2'); // 60 s lifetime is inside the skew
    assert.equal(state.tokenRequests.length, 2);
  } finally {
    srv.close();
  }
});

test('config check rejects plain http to remote hosts and missing fields', () => {
  assert.throws(() => checkOAuthConfig({ grant: 'pkce', tokenUrl: 'http://auth.example.com/token', authUrl: 'https://a', clientId: 'x' }), /must be https/);
  assert.throws(() => checkOAuthConfig({ grant: 'device', tokenUrl: 'https://a/t', clientId: 'x' }), /device authorization URL/);
  assert.throws(() => checkOAuthConfig({ grant: 'client_credentials', tokenUrl: 'https://a/t', clientId: 'x' }), /client secret/);
});

test('config dir follows the platform conventions', () => {
  assert.equal(configDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32'), path.join('C:\\Users\\u\\AppData\\Roaming', 'pagetree'));
  assert.ok(configDir({}, 'darwin').endsWith(path.join('Library', 'Application Support', 'pagetree')));
  assert.equal(configDir({ XDG_CONFIG_HOME: '/x/cfg' }, 'linux'), path.join('/x/cfg', 'pagetree'));
  assert.equal(configDir({ PAGETREE_CONFIG_DIR: '/tmp/pt' }, 'linux'), path.resolve('/tmp/pt'));
});
