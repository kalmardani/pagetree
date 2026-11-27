// `pagetree index`: ingest, structure, segmentation where needed, bottom up summaries, and the
// index object. With `plan: true` it stops before any model call and returns the call plan.

import path from 'node:path';
import { ingestFile, sourceHashes } from './ingest.js';
import { headingTree, node, boundFanout, finalize, rangeTokens, postOrder } from './tree.js';
import { segmentRange, windowCount } from './segment.js';
import { summarizeTree } from './summarize.js';
import { loadPrompt } from './prompts.js';
import { PagetreeError } from './errors.js';
import { INDEX_SCHEMA_NAME, INDEX_VERSION } from './indexfile.js';
import { VERSION } from './version.js';

export const DEFAULTS = { leafTokens: 1500, summaryTokens: 80, fanout: 12, windowTokens: 3000, split: 'model', concurrency: 3 };

export async function buildIndex(file, opts = {}) {
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  if (o.leafTokens < 200 || o.leafTokens > 20000) throw new PagetreeError('usage', '--leaf-tokens must be between 200 and 20000');
  if (o.summaryTokens < 20 || o.summaryTokens > 400) throw new PagetreeError('usage', '--summary-tokens must be between 20 and 400');
  if (o.fanout < 2 || o.fanout > 50) throw new PagetreeError('usage', '--fanout must be between 2 and 50');
  if (!['model', 'deterministic'].includes(o.split)) throw new PagetreeError('usage', '--split must be model or deterministic');
  o.windowTokens = Math.max(o.windowTokens, o.leafTokens);

  const ing = await ingestFile(file, { format: o.format });
  const lines = ing.lines;
  if (!lines.some((l) => l.trim())) throw new PagetreeError('input', `${file} has no text content`);
  const docTitle = path.basename(file);
  const planOnly = Boolean(o.plan);
  const segOpts = { session: planOnly ? null : o.session, leafTokens: o.leafTokens, windowTokens: o.windowTokens, split: planOnly ? 'deterministic' : o.split, concurrency: o.concurrency, onProgress: o.onProgress };
  let segmentCalls = 0;

  let root = headingTree(lines, ing.headings, docTitle);
  if (!root) {
    root = node('root', docTitle, 1, lines.length);
    if (o.split === 'model') segmentCalls += windowCount(lines, 1, lines.length, o.windowTokens);
    root.children = await segmentRange(lines, 1, lines.length, segOpts);
  } else {
    // Leaves above the budget get sections of their own.
    const leaves = postOrder(root).filter((n) => !n.children.length && n.kind !== 'root');
    for (const leaf of leaves) {
      if (rangeTokens(lines, leaf.start, leaf.end) > o.leafTokens) {
        if (o.split === 'model') segmentCalls += windowCount(lines, leaf.start, leaf.end, o.windowTokens);
        const secs = await segmentRange(lines, leaf.start, leaf.end, segOpts);
        if (secs.length > 1) leaf.children = secs;
        else if (secs[0].children.length) leaf.children = secs[0].children;
      }
    }
  }
  if (!root.children.length) root.children = [node('section', docTitle, 1, lines.length)];
  boundFanout(root, o.fanout);
  const flat = finalize(root);
  const plan = {
    lines: lines.length,
    est_tokens: rangeTokens(lines, 1, lines.length),
    nodes: flat.length,
    leaves: flat.filter((n) => !n.children.length).length,
    summary_calls: flat.length,
    segment_calls: segmentCalls,
    est_calls: flat.length + segmentCalls,
  };
  if (planOnly) return { plan, root, flat, ingested: ing };

  if (o.session && o.maxCalls && plan.summary_calls + o.session.usage.calls > o.maxCalls) {
    throw new PagetreeError('budget', `the index needs ${plan.summary_calls} more summary calls, above the cap of ${o.maxCalls}. Raise --max-calls or use a larger --leaf-tokens.`);
  }
  await summarizeTree(root, lines, { session: o.session, summaryTokens: o.summaryTokens, leafTokens: o.leafTokens, concurrency: o.concurrency, onProgress: o.onProgress });

  const prompts = Object.fromEntries(['segment', 'summarize-leaf', 'summarize-parent'].map((n) => [n, loadPrompt(n).version]));
  const hashes = sourceHashes(ing);
  const index = {
    schema: INDEX_SCHEMA_NAME,
    version: INDEX_VERSION,
    generator: `pagetree ${VERSION}`,
    created_at: new Date().toISOString(),
    source: { path: null, name: path.basename(file), format: ing.format, bytes: ing.bytes.length, lines: lines.length, ...hashes },
    settings: { leaf_tokens: o.leafTokens, summary_tokens: o.summaryTokens, fanout: o.fanout, window_tokens: o.windowTokens, split: o.split },
    model: { provider: o.session.adapter.name, models: o.session.summary().models, prompts },
    usage: o.session.summary(),
    nodes: flat.map((n) => ({
      id: n.id,
      path: n.path,
      parent: n.parent,
      children: n.children.map((c) => c.id),
      depth: n.depth,
      kind: n.kind,
      title: n.title || '',
      summary: n.summary || '',
      start: n.start,
      end: n.end,
    })),
  };
  return { index, plan, ingested: ing };
}
