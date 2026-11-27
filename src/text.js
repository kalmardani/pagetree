// Small text helpers shared by ingest, verifier and renderer. No language specific rules live
// here: everything works on Unicode code points and whitespace classes only.

import { createHash } from 'node:crypto';

/** Split text into lines, accepting LF, CRLF and lone CR. Drops a final empty line. */
export function splitLines(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Whitespace normalisation used by the quote verifier. NFC first so composed and decomposed
 * accents (common in Hungarian text copied from PDFs) compare equal, then every run of Unicode
 * whitespace becomes one space.
 */
export function normalizeWs(s) {
  return s.normalize('NFC').replace(/[\s\u00a0\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]+/gu, ' ').trim();
}

/**
 * Token estimate from UTF-8 byte length divided by four. Accented and non Latin scripts take
 * more bytes per character and also more tokens per character, so the estimate tracks real
 * tokenisers better than a character count would, without any language table.
 */
export function estimateTokens(s) {
  return Math.ceil(Buffer.byteLength(s, 'utf8') / 4);
}

export function sha256(bufOrString) {
  return createHash('sha256').update(bufOrString).digest('hex');
}

/**
 * Remove terminal control sequences and C0/C1 control characters (except tab and newline) from
 * text that came from a document or a model, before it is printed to a terminal.
 */
export function sanitizeForTerminal(s) {
  return String(s)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

/** Collapse to one line and cut to max characters, for titles and log lines. */
export function oneLine(s, max = 200) {
  const t = normalizeWs(String(s));
  return t.length > max ? t.slice(0, max - 3) + '...' : t;
}

/** Number lines for a prompt, `   12| text`. */
export function numberLines(lines, start) {
  const width = String(start + lines.length - 1).length;
  return lines.map((l, i) => `${String(start + i).padStart(width, ' ')}| ${l}`).join('\n');
}
