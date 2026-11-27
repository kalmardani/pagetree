// Sections for text without usable headings. Deterministic windows bound the input of every
// call; inside each window the model proposes section starts and titles as validated JSON.
// Windows are independent (each sees only the last lines of the previous window), so they can
// run in parallel. No language specific rule is used anywhere.

import { windows, node, splitIntoParts, rangeTokens } from './tree.js';
import { numberLines, oneLine } from './text.js';
import { loadPrompt, untrusted } from './prompts.js';
import { pool } from './pool.js';

export const SEGMENT_SCHEMA = {
  type: 'object',
  required: ['sections'],
  extra: false,
  props: {
    continues_previous: { type: 'boolean' },
    sections: {
      type: 'array',
      min: 1,
      max: 40,
      items: {
        type: 'object',
        required: ['start_line', 'title'],
        extra: false,
        props: { start_line: { type: 'integer', min: 1 }, title: { type: 'string', min: 1, max: 120 } },
      },
    },
  },
};

export function segmentCheck(start, end, maxSections) {
  return (v) => {
    const errs = [];
    const s = v.sections;
    if (s.length > maxSections) errs.push(`$.sections: at most ${maxSections} sections allowed, got ${s.length}`);
    if (s[0].start_line !== start) errs.push(`$.sections[0].start_line must be ${start}, got ${s[0].start_line}`);
    for (let i = 0; i < s.length; i++) {
      if (s[i].start_line < start || s[i].start_line > end) errs.push(`$.sections[${i}].start_line ${s[i].start_line} is outside ${start}..${end}`);
      if (i > 0 && s[i].start_line <= s[i - 1].start_line) errs.push(`$.sections[${i}].start_line must be greater than ${s[i - 1].start_line}`);
      if (!s[i].title.trim()) errs.push(`$.sections[${i}].title is blank`);
    }
    return errs;
  };
}

function firstLineTitle(lines, start, end) {
  for (let ln = start; ln <= end; ln++) {
    const t = (lines[ln - 1] || '').trim();
    if (t) return oneLine(t, 60);
  }
  return `${start}-${end}`;
}

/**
 * @returns {Promise<object[]>} section build nodes covering start..end
 */
export async function segmentRange(lines, start, end, opts) {
  const { session, leafTokens, windowTokens, split = 'model', concurrency = 3, onProgress } = opts;
  const ws = windows(lines, start, end, windowTokens);
  let sections;
  if (split === 'deterministic' || !session) {
    sections = windows(lines, start, end, leafTokens).map((w) => node('section', firstLineTitle(lines, w.start, w.end), w.start, w.end));
  } else {
    const maxSections = Math.max(2, Math.min(40, Math.ceil(windowTokens / 150)));
    const results = await pool(ws, concurrency, async (w, k) => {
      const prompt = loadPrompt('segment', { start: w.start, end: w.end, maxSections });
      const prev = k > 0 ? numberLines(lines.slice(Math.max(w.start - 4, start) - 1, w.start - 1), Math.max(w.start - 4, start)) : '(none, this is the first window)';
      const user = `Last lines of the previous window:\n${untrusted(prev)}\n\nWindow, lines ${w.start} to ${w.end}:\n${untrusted(numberLines(lines.slice(w.start - 1, w.end), w.start))}`;
      const v = await session.json({
        system: prompt.text,
        user,
        schema: SEGMENT_SCHEMA,
        check: segmentCheck(w.start, w.end, maxSections),
        maxTokens: 1200,
        promptVersion: prompt.version,
        meta: { task: 'segment', window: w, lines: lines.slice(w.start - 1, w.end) },
      });
      if (onProgress) onProgress({ task: 'segment', done: k + 1, total: ws.length });
      return { w, v };
    });
    sections = [];
    for (const { w, v } of results) {
      v.sections.forEach((s, i) => {
        const sEnd = i + 1 < v.sections.length ? v.sections[i + 1].start_line - 1 : w.end;
        if (i === 0 && v.continues_previous && sections.length) sections[sections.length - 1].end = sEnd;
        else sections.push(node('section', oneLine(s.title, 120), s.start_line, sEnd));
      });
    }
  }
  // Any section still above the leaf budget is split deterministically into parts.
  for (const s of sections) {
    if (rangeTokens(lines, s.start, s.end) > leafTokens) {
      const parts = splitIntoParts(lines, s, leafTokens);
      if (parts) s.children = parts;
    }
  }
  return sections;
}

export function windowCount(lines, start, end, windowTokens) {
  return windows(lines, start, end, windowTokens).length;
}
