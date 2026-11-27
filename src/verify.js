// Deterministic citation verifier. No model involved. A citation is verified when its path is
// a section that was actually read, its line range lies inside that section, and its quote,
// after whitespace normalisation, is an exact substring of the text of that range.
// A claim is supported when it has at least one citation and every citation is verified.

import { normalizeWs } from './text.js';

export const QUOTE_MIN = 12;
export const QUOTE_MAX = 300;

/**
 * Normalised text of lines start..end plus a map from character offset to line number.
 */
export function normalizedRange(lines, start, end) {
  let text = '';
  const offsets = []; // [{at, line}]
  for (let ln = start; ln <= end; ln++) {
    const t = normalizeWs(lines[ln - 1] || '');
    if (!t) continue;
    if (text) text += ' ';
    offsets.push({ at: text.length, line: ln });
    text += t;
  }
  return { text, offsets };
}

function lineAt(offsets, pos) {
  let line = offsets.length ? offsets[0].line : 0;
  for (const o of offsets) {
    if (o.at <= pos) line = o.line;
    else break;
  }
  return line;
}

export function findQuote(lines, start, end, quote) {
  const { text, offsets } = normalizedRange(lines, start, end);
  const q = normalizeWs(quote);
  const at = q ? text.indexOf(q) : -1;
  if (at === -1) return null;
  return { start: lineAt(offsets, at), end: lineAt(offsets, at + q.length - 1) };
}

/**
 * Decision table C (DEVELOPER.md), checked in this order per citation:
 *   path not among read sections            -> not_read
 *   range invalid or outside the section    -> bad_range
 *   quote too short (and not the whole range) or too long -> bad_length
 *   quote not in the cited range            -> not_found (or found_elsewhere with lines)
 *   otherwise                               -> verified, with the exact matched lines
 */
export function verifyCitation(c, readByPath, lines) {
  const n = readByPath.get(c.path);
  if (!n) return { ok: false, reason: 'not_read', detail: `section ${c.path} was not read for this answer` };
  if (!(c.start <= c.end && c.start >= n.start && c.end <= n.end)) {
    return { ok: false, reason: 'bad_range', detail: `lines ${c.start}-${c.end} are not inside section ${c.path} (lines ${n.start}-${n.end})` };
  }
  const q = normalizeWs(c.quote);
  const whole = normalizedRange(lines, c.start, c.end).text;
  if ((q.length < QUOTE_MIN && q !== whole) || q.length > QUOTE_MAX) {
    return { ok: false, reason: 'bad_length', detail: `quote has ${q.length} characters, allowed ${QUOTE_MIN} to ${QUOTE_MAX}` };
  }
  const hit = findQuote(lines, c.start, c.end, c.quote);
  if (hit) return { ok: true, matched: hit };
  const elsewhere = findQuote(lines, n.start, n.end, c.quote);
  if (elsewhere) return { ok: false, reason: 'found_elsewhere', detail: `quote is at lines ${elsewhere.start}-${elsewhere.end}, outside the cited lines ${c.start}-${c.end}` };
  return { ok: false, reason: 'not_found', detail: `quote is not in lines ${c.start}-${c.end}` };
}

export function verifyClaims(claims, readNodes, lines) {
  const readByPath = new Map(readNodes.map((n) => [n.path, n]));
  const supported = [];
  const unsupported = [];
  for (const claim of claims) {
    const citations = claim.citations.map((c) => {
      const r = verifyCitation(c, readByPath, lines);
      const node = readByPath.get(c.path);
      return {
        path: c.path,
        title: node ? node.title : null,
        start: c.start,
        end: c.end,
        quote: c.quote,
        verified: r.ok,
        matched_lines: r.ok ? r.matched : null,
        problem: r.ok ? null : r.reason,
        detail: r.ok ? null : r.detail,
      };
    });
    const ok = citations.length > 0 && citations.every((c) => c.verified);
    (ok ? supported : unsupported).push({ text: claim.text, supported: ok, citations });
  }
  return { supported, unsupported };
}
