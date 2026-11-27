// Test adapter. No network, no model. Two modes:
//  - scripted: a list of reply strings (or a function) returned in order, for exact tests;
//  - heuristic: deterministic replies built from the structured `meta` every caller passes,
//    so the CLI can be exercised end to end offline. The heuristic is not retrieval quality,
//    it only produces valid shapes.

import fs from 'node:fs';
import { normalizeWs, estimateTokens } from '../text.js';

export function createFakeAdapter(cfg = {}) {
  let script = cfg.script || null;
  if (!script && cfg.scriptFile) script = JSON.parse(fs.readFileSync(cfg.scriptFile, 'utf8'));
  let i = 0;
  const calls = [];
  return {
    name: 'fake',
    model: 'fake-1',
    calls,
    async complete(req) {
      calls.push(req);
      let text;
      if (typeof script === 'function') text = await script(req, i++);
      else if (Array.isArray(script)) {
        if (i >= script.length) throw new Error(`fake script exhausted after ${script.length} replies`);
        text = script[i++];
      } else text = heuristic(req.meta || {});
      if (typeof text !== 'string') text = JSON.stringify(text);
      const input = estimateTokens(req.system + req.messages.map((m) => m.content).join(''));
      return { text, model: 'fake-1', stop: 'end', latencyMs: 0, usage: { input_tokens: input, output_tokens: estimateTokens(text), cost_usd: 0 } };
    },
  };
}

function words(s) {
  return new Set(normalizeWs(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
}

function overlap(a, b) {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

function firstWords(s, max) {
  const t = normalizeWs(s.replace(/[#*_`>]/g, ''));
  return (t.length > max ? t.slice(0, max - 3) + '...' : t) || 'Untitled';
}

function heuristic(meta) {
  switch (meta.task) {
    case 'segment': {
      const { start, end } = meta.window;
      const sections = [];
      for (let ln = start; ln <= end; ln += 12) {
        const text = meta.lines.slice(ln - start, ln - start + 12).find((l) => l.trim()) || 'Section';
        sections.push({ start_line: ln, title: firstWords(text, 50) });
      }
      return JSON.stringify({ sections, continues_previous: false });
    }
    case 'summarize': {
      const max = meta.maxChars || 200;
      const src = meta.kind === 'leaf' ? meta.text : meta.children.map((c) => c.title).join('; ');
      const out = { summary: firstWords(src || meta.title || 'Empty section', max) };
      if (meta.needsTitle) out.title = firstWords(meta.children[0].title, 60);
      return JSON.stringify(out);
    }
    case 'navigate': {
      const q = words(meta.question);
      const ranked = meta.candidates
        .map((c, idx) => ({ c, idx, score: overlap(q, words(`${c.title} ${c.summary}`)) }))
        .sort((a, b) => b.score - a.score || a.idx - b.idx);
      const picked = ranked.filter((r) => r.score > 0).slice(0, meta.beam);
      const use = picked.length ? picked : ranked.slice(0, 1);
      return JSON.stringify({ choices: use.map((r) => ({ path: r.c.path, reason: `shares ${r.score} words with the question` })) });
    }
    case 'answer': {
      const q = words(meta.question);
      let best = null;
      for (const n of meta.nodes) {
        n.lines.forEach((line, k) => {
          const s = overlap(q, words(line));
          if (line.trim().length >= 12 && (!best || s > best.s)) best = { s, n, ln: n.start + k, line };
        });
      }
      if (!best || best.s === 0) return JSON.stringify({ status: 'not_found', claims: [] });
      const quote = normalizeWs(best.line).slice(0, 200);
      return JSON.stringify({
        status: 'answered',
        claims: [{ text: quote, citations: [{ path: best.n.path, start: best.ln, end: best.ln, quote }] }],
      });
    }
    default:
      return '{}';
  }
}
