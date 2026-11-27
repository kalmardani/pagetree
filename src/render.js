// Human readable output. Everything that came from a document or a model passes through
// sanitizeForTerminal before it is printed.

import { sanitizeForTerminal as clean, oneLine, numberLines } from './text.js';

const label = (n) => (n.path === '' ? '(root)' : n.path);

export function renderTree(index, { summaries = false, maxDepth = Infinity } = {}) {
  const byId = new Map(index.nodes.map((n) => [n.id, n]));
  const out = [];
  out.push(`${clean(index.source.name)}  (${index.source.format}, ${index.source.lines} lines, ${index.nodes.length} nodes)`);
  const walk = (n) => {
    if (n.depth > maxDepth) return;
    const pad = '  '.repeat(n.depth);
    out.push(`${pad}${label(n).padEnd(8)} ${clean(oneLine(n.title, 100))}  [${n.start}-${n.end}]`);
    if (summaries && n.summary) out.push(`${pad}         ${clean(oneLine(n.summary, 400))}`);
    n.children.forEach((id) => walk(byId.get(id)));
  };
  walk(index.nodes[0]);
  return out.join('\n');
}

export function renderNode(n, lines, { offset = 0, limit = 200 } = {}) {
  const from = n.start + offset;
  const to = Math.min(n.end, from + limit - 1);
  const head = `${label(n)} ${clean(oneLine(n.title, 120))}  lines ${n.start}-${n.end}`;
  if (from > n.end) return `${head}\n(no lines at offset ${offset})`;
  const more = to < n.end ? `\n[${n.end - to} more lines, use --offset ${offset + limit}]` : '';
  return `${head}\n${clean(numberLines(lines.slice(from - 1, to), from))}${more}`;
}

function money(u) {
  return u.cost_usd === null ? 'cost not reported by this provider' : `cost $${u.cost_usd.toFixed(4)}`;
}

export function renderUsage(u) {
  return `${u.calls} model calls (${u.repairs} repair rounds), ${u.input_tokens} input tokens, ${u.output_tokens} output tokens, ${money(u)}${u.models.length ? `, model ${u.models.join(', ')}` : ''}`;
}

export function renderAnswer(r) {
  const out = [];
  if (r.index.stale) out.push('Warning: the index is stale, line numbers may be wrong.\n');
  if (r.status === 'not_found') out.push('The sections the navigation chose do not answer this question.');
  else if (r.status === 'unsupported') out.push('The model gave an answer, but none of its claims could be verified against the document.');
  const cites = [];
  if (r.claims.length) {
    out.push('Answer');
    for (const c of r.claims) {
      const refs = c.citations.map((ci) => {
        cites.push(ci);
        return `[${cites.length}]`;
      });
      out.push(`  ${c.supported ? '' : '(UNVERIFIED) '}${clean(c.text)} ${refs.join('')}`);
    }
    out.push('', 'Citations');
    cites.forEach((ci, i) => {
      const lines = ci.matched_lines ? `lines ${ci.matched_lines.start}-${ci.matched_lines.end}` : `lines ${ci.start}-${ci.end}`;
      out.push(`  [${i + 1}] ${ci.path} ${clean(oneLine(ci.title || '', 80))}, ${lines}${ci.verified ? '' : `  NOT VERIFIED (${ci.problem})`}`);
      out.push(`      "${clean(oneLine(ci.quote, 300))}"`);
    });
  }
  if (r.dropped.length) out.push('', `${r.dropped.length} claim(s) dropped because a citation did not verify. Use --unsupported flag or --json to see them.`);
  out.push('', 'Navigation');
  for (const s of r.trace.steps) {
    out.push(`  step ${s.step}: ${s.shown.length} sections shown`);
    for (const c of s.chosen) out.push(`    ${c.action.padEnd(11)} ${c.path} ${clean(oneLine(c.title, 60))}: ${clean(c.reason)}`);
    if (!s.chosen.length) out.push('    nothing chosen');
  }
  if (r.trace.read.length) out.push(`  read: ${r.trace.read.map((x) => `${x.path} (lines ${x.start}-${x.end})`).join(', ')}`);
  for (const s of r.trace.skipped) out.push(`  skipped ${s.path}: ${s.reason}`);
  out.push('', `Usage: ${renderUsage(r.usage)}`);
  return out.join('\n');
}

export function renderPlan(plan) {
  return [
    `lines: ${plan.lines}, estimated tokens: ${plan.est_tokens}`,
    `nodes: ${plan.nodes} (${plan.leaves} leaves)`,
    `model calls: about ${plan.est_calls} (${plan.summary_calls} summaries, ${plan.segment_calls} segmentation windows)`,
  ].join('\n');
}
