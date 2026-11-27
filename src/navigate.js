// Navigation: the model sees candidate sections (path, title, range, summary), picks at most
// `beam` of them with a short reason, the chosen parents are opened, the chosen leaves are
// read. One model call per tree level. The code, not the model, decides what "open" and
// "read" mean, enforces the beam, the step cap and the read budget, and keeps the trace.

import { loadPrompt, untrusted, plain } from './prompts.js';
import { oneLine, estimateTokens } from './text.js';

export const NAV_SCHEMA = {
  type: 'object',
  required: ['choices'],
  extra: false,
  props: {
    choices: {
      type: 'array',
      max: 10,
      items: {
        type: 'object',
        required: ['path', 'reason'],
        extra: false,
        props: { path: { type: 'string', min: 1, max: 40 }, reason: { type: 'string', max: 300 } },
      },
    },
  },
};

export function navCheck(candidatePaths, beam) {
  const allowed = new Set(candidatePaths);
  return (v) => {
    const errs = [];
    const seen = new Set();
    if (v.choices.length > beam) errs.push(`$.choices: choose at most ${beam} paths, got ${v.choices.length}`);
    v.choices.forEach((c, i) => {
      if (!allowed.has(c.path)) errs.push(`$.choices[${i}].path "${oneLine(c.path, 40)}" is not one of the listed candidates (${candidatePaths.slice(0, 20).join(', ')})`);
      if (seen.has(c.path)) errs.push(`$.choices[${i}].path "${c.path}" is chosen twice`);
      seen.add(c.path);
    });
    return errs;
  };
}

export function nodeTokens(lines, n) {
  return estimateTokens(lines.slice(n.start - 1, n.end).join('\n'));
}

function describe(n, byId) {
  const kids = n.children.length;
  return `path ${n.path} | ${plain(oneLine(n.title, 120))} | lines ${n.start}-${n.end} | subsections: ${kids ? `yes (${kids})` : 'no'}\n  ${plain(oneLine(n.summary, 400))}`;
}

/**
 * Decision table B (DEVELOPER.md): for each chosen node
 *   has children, step < maxSteps            -> open
 *   has children, last step, fits budget     -> read whole node
 *   no children, fits budget                 -> read
 *   otherwise                                -> skip (budget)
 */
export function decide(n, { lastStep, remaining, tokens }) {
  if (n.children.length && !lastStep) return 'open';
  if (tokens <= remaining) return 'read';
  return 'skip_budget';
}

export async function navigate({ session, index, byId, lines, question, beam = 3, maxSteps = 6, readBudget = 6000 }) {
  const root = index.nodes[0];
  const trace = { steps: [], read: [], skipped: [] };
  let candidates = root.children.map((id) => byId.get(id));
  let remaining = readBudget;
  const toRead = [];
  if (!candidates.length) candidates = [root];

  for (let step = 1; step <= maxSteps && candidates.length; step++) {
    const prompt = loadPrompt('navigate', { beam });
    const user = `<question>\n${plain(question)}\n</question>\n\nCandidate sections (step ${step}):\n${untrusted(candidates.map((c) => describe(c, byId)).join('\n'))}`;
    const v = await session.json({
      system: prompt.text,
      user,
      schema: NAV_SCHEMA,
      check: navCheck(candidates.map((c) => c.path), beam),
      maxTokens: 700,
      promptVersion: prompt.version,
      meta: { task: 'navigate', question, beam, candidates: candidates.map((c) => ({ path: c.path, title: c.title, summary: c.summary })) },
    });
    const lastStep = step === maxSteps;
    const next = [];
    const chosen = [];
    for (const c of v.choices) {
      const n = candidates.find((x) => x.path === c.path);
      const tokens = nodeTokens(lines, n);
      const action = decide(n, { lastStep, remaining, tokens });
      if (action === 'open') next.push(...n.children.map((id) => byId.get(id)));
      else if (action === 'read') {
        remaining -= tokens;
        toRead.push(n);
        trace.read.push({ path: n.path, title: n.title, start: n.start, end: n.end, tokens });
      } else trace.skipped.push({ path: n.path, reason: `needs ${tokens} tokens, ${remaining} left in the read budget` });
      chosen.push({ path: c.path, title: n.title, reason: oneLine(c.reason, 200), action });
    }
    trace.steps.push({ step, shown: candidates.map((c) => c.path), chosen });
    candidates = next;
  }
  return { toRead, trace };
}
