// Tree construction. A build node is { kind, title, start, end, children, level }. Line
// numbers are 1 based and inclusive. After `finalize` every node has an id and a path, and the
// leaves cover every line that carries content.
//
// Kinds: root, heading (from a heading), preamble (text of a heading before its first child),
// section (proposed by the model or by a deterministic window), part (a deterministic split of
// an oversize section), group (synthetic parent that keeps fanout bounded).

import { estimateTokens } from './text.js';

export function node(kind, title, start, end, extra = {}) {
  return { kind, title, start, end, children: [], level: 0, summary: null, ...extra };
}

export function hasContent(lines, start, end, skipLine = null) {
  for (let ln = start; ln <= end; ln++) {
    if (ln === skipLine) continue;
    if ((lines[ln - 1] || '').trim() !== '') return true;
  }
  return false;
}

/** Build the heading tree. Returns null when there are no headings. */
export function headingTree(lines, headings, docTitle) {
  if (!headings.length) return null;
  const N = lines.length;
  const root = node('root', docTitle, 1, N);
  const stack = [root];
  for (const h of headings) {
    while (stack.length > 1 && stack[stack.length - 1].level >= h.level) {
      stack.pop().end = h.line - 1;
    }
    const n = node('heading', h.title, h.line, N, { level: h.level, headingLine: h.line });
    stack[stack.length - 1].children.push(n);
    stack.push(n);
  }
  // Hoist a single top heading (the usual document title) into the root.
  while (root.children.length === 1 && root.children[0].children.length > 0) {
    const only = root.children[0];
    root.title = only.title;
    root.headingLine = only.headingLine;
    root.children = only.children;
  }
  addPreambles(root, lines);
  return root;
}

function addPreambles(n, lines) {
  if (!n.children.length) return;
  const first = n.children[0].start;
  if (first > n.start && hasContent(lines, n.start, first - 1, n.headingLine ?? null)) {
    n.children.unshift(node('preamble', n.title, n.start, first - 1));
  }
  for (const c of n.children) addPreambles(c, lines);
}

/**
 * Deterministic windows over lines start..end, each at most maxTokens where possible. A window
 * prefers to end on a blank line in its second half. A single line longer than the budget
 * becomes its own window, because citations work on whole lines.
 */
export function windows(lines, start, end, maxTokens) {
  const out = [];
  let ws = start;
  while (ws <= end) {
    let tokens = 0;
    let lastBlank = -1;
    let we = ws;
    for (let ln = ws; ln <= end; ln++) {
      const t = estimateTokens(lines[ln - 1] || '') + 1;
      if (tokens + t > maxTokens && ln > ws) break;
      tokens += t;
      we = ln;
      if ((lines[ln - 1] || '').trim() === '') lastBlank = ln;
    }
    if (we < end && lastBlank > ws + (we - ws) / 2) we = lastBlank;
    out.push({ start: ws, end: we });
    ws = we + 1;
  }
  return out;
}

/** Split an oversize range into parts at window boundaries. Titles carry "[k/n]". */
export function splitIntoParts(lines, n, maxTokens) {
  const ws = windows(lines, n.start, n.end, maxTokens);
  if (ws.length < 2) return null;
  return ws.map((w, i) => node('part', `${n.title} [${i + 1}/${ws.length}]`, w.start, w.end));
}

export function rangeTokens(lines, start, end) {
  return estimateTokens(lines.slice(start - 1, end).join('\n'));
}

/** Insert group nodes wherever a node has more than `fanout` children. */
export function boundFanout(n, fanout) {
  for (const c of n.children) boundFanout(c, fanout);
  while (n.children.length > fanout) {
    const groups = Math.ceil(n.children.length / fanout);
    const size = Math.ceil(n.children.length / groups);
    const next = [];
    for (let i = 0; i < n.children.length; i += size) {
      const chunk = n.children.slice(i, i + size);
      if (chunk.length === 1) next.push(chunk[0]);
      else {
        const g = node('group', null, chunk[0].start, chunk[chunk.length - 1].end);
        g.children = chunk;
        next.push(g);
      }
    }
    n.children = next;
  }
}

/** Assign ids (preorder) and paths ("" for root, "1", "1.2", ...). Returns the flat list. */
export function finalize(root) {
  const flat = [];
  let counter = 0;
  const walk = (n, p, parentId, depth) => {
    n.id = `n${counter++}`;
    n.path = p;
    n.depth = depth;
    n.parent = parentId;
    flat.push(n);
    n.children.forEach((c, i) => walk(c, p ? `${p}.${i + 1}` : String(i + 1), n.id, depth + 1));
  };
  walk(root, '', null, 0);
  return flat;
}

/** Post order list (children before parents), used for bottom up summaries. */
export function postOrder(root) {
  const out = [];
  const walk = (n) => {
    n.children.forEach(walk);
    out.push(n);
  };
  walk(root);
  return out;
}
