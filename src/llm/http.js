// HTTP helper for the API adapters and the OAuth client. Every request has a timeout, and
// requests that fail with 429, 5xx or a network error are retried a bounded number of times
// with exponential backoff and jitter. Error messages never include request headers.

import { PagetreeError } from '../errors.js';

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} url
 * @param {{method?:string, headers?:object, body?:string, timeoutMs?:number, retries?:number,
 *          fetchImpl?:Function, sleep?:Function, retryOn?:(status:number)=>boolean, errorCode?:string}} opts
 * @returns {Promise<{status:number, json:any, text:string, headers:Headers}>}
 */
export async function request(url, opts = {}) {
  const {
    method = 'POST',
    headers = {},
    body,
    timeoutMs = 60000,
    retries = 3,
    fetchImpl = globalThis.fetch,
    sleep = sleepReal,
    retryOn = (s) => s === 429 || s >= 500,
    errorCode = 'provider',
  } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const reason = e && e.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : `network error (${e && e.message})`;
      lastErr = new PagetreeError(errorCode, `request to ${safeUrl(url)} failed: ${reason}`);
      if (attempt < retries) {
        await sleep(backoff(attempt));
        continue;
      }
      throw lastErr;
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.ok) return { status: res.status, json, text, headers: res.headers };
    if (retryOn(res.status) && attempt < retries) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30000) : backoff(attempt));
      continue;
    }
    return { status: res.status, json, text, headers: res.headers };
  }
  throw lastErr;
}

export function backoff(attempt) {
  const base = 500 * 2 ** attempt;
  return Math.min(base + Math.floor(Math.random() * 250), 20000);
}

/** Strip query string and credentials from a URL before it goes into an error message. */
export function safeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(invalid url)';
  }
}

export function errorSnippet(res) {
  const msg = res.json && (res.json.error_description || (res.json.error && (res.json.error.message || res.json.error)));
  const s = typeof msg === 'string' ? msg : res.text;
  return String(s || '').replace(/\s+/g, ' ').slice(0, 300);
}
