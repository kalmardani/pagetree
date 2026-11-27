// Prompts live as versioned files in ../prompts. The first line is `version: <name>/<n>`, the
// rest is the system prompt with {{placeholders}}. The version is logged with every call.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const cache = new Map();

export function loadPrompt(name, vars = {}) {
  if (!cache.has(name)) {
    const raw = fs.readFileSync(path.join(DIR, `${name}.md`), 'utf8').replace(/\r\n?/g, '\n');
    const nl = raw.indexOf('\n');
    const version = raw.slice(0, nl).replace(/^version:\s*/, '').trim();
    cache.set(name, { version, body: raw.slice(nl + 1).trim() });
  }
  const p = cache.get(name);
  const text = p.body.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return { version: p.version, text };
}

/**
 * Wrap untrusted text between markers that carry a random nonce, so text inside cannot close
 * the block by guessing the marker. Any accidental occurrence of the nonce is removed.
 */
export function untrusted(content) {
  const nonce = randomBytes(6).toString('hex');
  const safe = String(content).split(nonce).join('');
  return `<<<DOCUMENT ${nonce}>>>\n${safe}\n<<<END DOCUMENT ${nonce}>>>`;
}

/** Text for a block that must not contain markup that could look like our own tags. */
export function plain(s) {
  return String(s).replace(/[<>]/g, ' ');
}
