// `pagetree ask`: navigate, read the chosen sections, answer with citations, verify every
// citation in code, and return a result object that holds the trace.

import { openIndex } from './indexfile.js';
import { navigate } from './navigate.js';
import { verifyClaims } from './verify.js';
import { loadPrompt, untrusted, plain } from './prompts.js';
import { numberLines, oneLine } from './text.js';
import { PagetreeError } from './errors.js';

export const ANSWER_SCHEMA = {
  type: 'object',
  required: ['status', 'claims'],
  extra: false,
  props: {
    status: { type: 'string', enum: ['answered', 'not_found'] },
    claims: {
      type: 'array',
      max: 12,
      items: {
        type: 'object',
        required: ['text', 'citations'],
        extra: false,
        props: {
          text: { type: 'string', min: 1, max: 800 },
          citations: {
            type: 'array',
            min: 1,
            max: 4,
            items: {
              type: 'object',
              required: ['path', 'start', 'end', 'quote'],
              extra: false,
              props: {
                path: { type: 'string', min: 1, max: 40 },
                start: { type: 'integer', min: 1 },
                end: { type: 'integer', min: 1 },
                quote: { type: 'string', min: 1, max: 1000 },
              },
            },
          },
        },
      },
    },
  },
};

export function answerCheck(v) {
  if (v.status === 'not_found' && v.claims.length) return ['$.claims must be empty when status is not_found'];
  if (v.status === 'answered' && !v.claims.length) return ['$.claims needs at least one claim when status is answered'];
  return [];
}

export const MAX_QUESTION_CHARS = 2000;

export async function ask(indexPath, question, opts) {
  const { session, beam = 3, maxSteps = 6, readBudget = 6000, unsupported = 'drop', source, allowStale } = opts;
  const q = String(question || '').trim();
  if (!q) throw new PagetreeError('usage', 'the question is empty');
  if (q.length > MAX_QUESTION_CHARS) throw new PagetreeError('usage', `the question is longer than ${MAX_QUESTION_CHARS} characters`);
  if (!Number.isInteger(beam) || beam < 1 || beam > 8) throw new PagetreeError('usage', '--beam must be an integer from 1 to 8');
  if (!Number.isInteger(readBudget) || readBudget < 200 || readBudget > 100000) throw new PagetreeError('usage', '--read-tokens must be between 200 and 100000');
  if (!['drop', 'flag'].includes(unsupported)) throw new PagetreeError('usage', '--unsupported must be drop or flag');

  const opened = opts.opened || (await openIndex(indexPath, { source, allowStale }));
  const { index, lines, byId } = opened;
  const { toRead, trace } = await navigate({ session, index, byId, lines, question: q, beam, maxSteps, readBudget });

  let status = 'not_found';
  let verified = { supported: [], unsupported: [] };
  if (toRead.length) {
    const prompt = loadPrompt('answer');
    const sections = toRead
      .map((n) => `section path ${n.path} | ${plain(oneLine(n.title, 120))} | lines ${n.start}-${n.end}\n${numberLines(lines.slice(n.start - 1, n.end), n.start)}`)
      .join('\n\n');
    const v = await session.json({
      system: prompt.text,
      user: `<question>\n${plain(q)}\n</question>\n\nSections:\n${untrusted(sections)}`,
      schema: ANSWER_SCHEMA,
      check: answerCheck,
      maxTokens: 2500,
      promptVersion: prompt.version,
      meta: { task: 'answer', question: q, nodes: toRead.map((n) => ({ path: n.path, start: n.start, lines: lines.slice(n.start - 1, n.end) })) },
    });
    verified = verifyClaims(v.claims, toRead, lines);
    if (v.status === 'answered') status = verified.supported.length ? 'answered' : 'unsupported';
  }

  return {
    question: q,
    status,
    claims: unsupported === 'flag' ? [...verified.supported, ...verified.unsupported] : verified.supported,
    dropped: unsupported === 'drop' ? verified.unsupported : [],
    unsupported_mode: unsupported,
    trace,
    index: { path: indexPath, source: opened.sourcePath, stale: opened.stale },
    usage: session.summary(),
  };
}
