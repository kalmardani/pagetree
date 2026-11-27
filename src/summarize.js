// Bottom up summaries. Leaves are summarised from their text, parents from their children's
// titles and summaries. Group nodes (synthetic parents) also get a model written title. Nodes
// of equal height run in parallel; a parent always waits for all its children.

import { loadPrompt, untrusted, plain } from './prompts.js';
import { numberLines, oneLine, estimateTokens } from './text.js';
import { pool } from './pool.js';

export function summarySchema(maxChars, needsTitle) {
  const props = { summary: { type: 'string', min: 1, max: maxChars } };
  if (needsTitle) props.title = { type: 'string', min: 1, max: 120 };
  return { type: 'object', required: Object.keys(props), extra: false, props };
}

export function maxCharsFor(summaryTokens) {
  // The budget is in estimated tokens (UTF-8 bytes / 4). Three characters per token keeps
  // accented text under the budget too.
  return summaryTokens * 3;
}

function height(n) {
  return n.children.length ? 1 + Math.max(...n.children.map(height)) : 0;
}

function leafText(lines, n, capTokens) {
  const slice = lines.slice(n.start - 1, n.end);
  let text = numberLines(slice, n.start);
  if (estimateTokens(text) > capTokens) text = text.slice(0, capTokens * 4) + '\n[section truncated for the summary]';
  return text;
}

export async function summarizeTree(root, lines, opts) {
  const { session, summaryTokens, leafTokens, concurrency = 3, onProgress } = opts;
  const maxChars = maxCharsFor(summaryTokens);
  // The prompt asks for less than the validator allows. Models count characters loosely, and
  // a reply a few characters over the hard cap would otherwise cost a repair round.
  const targetChars = Math.floor(maxChars * 0.75);
  const byHeight = new Map();
  const walk = (n) => {
    const h = height(n);
    if (!byHeight.has(h)) byHeight.set(h, []);
    byHeight.get(h).push(n);
    n.children.forEach(walk);
  };
  walk(root);
  const total = [...byHeight.values()].reduce((a, b) => a + b.length, 0);
  let done = 0;
  for (const h of [...byHeight.keys()].sort((a, b) => a - b)) {
    await pool(byHeight.get(h), concurrency, async (n) => {
      const needsTitle = n.kind === 'group';
      let prompt;
      let user;
      let meta;
      if (!n.children.length) {
        prompt = loadPrompt('summarize-leaf', { maxChars: targetChars });
        user = `Section "${plain(oneLine(n.title || '', 120))}", lines ${n.start} to ${n.end}:\n${untrusted(leafText(lines, n, Math.ceil(leafTokens * 1.5)))}`;
        meta = { task: 'summarize', kind: 'leaf', title: n.title, text: lines.slice(n.start - 1, n.end).join('\n'), maxChars };
      } else {
        prompt = loadPrompt('summarize-parent', {
          maxChars: targetChars,
          titleRule: needsTitle ? '- Also give the part a title of at most 80 characters that names what its subsections have in common.' : '',
          shape: needsTitle ? '{"title": "...", "summary": "..."}' : '{"summary": "..."}',
        });
        const list = n.children
          .map((c, i) => `${i + 1}. ${plain(oneLine(c.title || '', 120))} (lines ${c.start}-${c.end})\n   ${plain(oneLine(c.summary || '', maxChars))}`)
          .join('\n');
        user = `${n.title ? `Part "${plain(oneLine(n.title, 120))}"` : 'Untitled part'}, lines ${n.start} to ${n.end}, subsections:\n${untrusted(list)}`;
        meta = { task: 'summarize', kind: 'parent', title: n.title, children: n.children.map((c) => ({ title: c.title, summary: c.summary })), needsTitle, maxChars };
      }
      const v = await session.json({
        system: prompt.text,
        user,
        schema: summarySchema(maxChars, needsTitle),
        check: (x) => (x.summary.trim() ? [] : ['$.summary is blank']),
        maxTokens: Math.max(200, summaryTokens * 3),
        promptVersion: prompt.version,
        meta,
      });
      n.summary = oneLine(v.summary, maxChars);
      if (needsTitle) n.title = oneLine(v.title, 120);
      done++;
      if (onProgress) onProgress({ task: 'summarize', done, total });
    });
  }
}
