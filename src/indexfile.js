// The index file: one JSON document with a versioned schema. It references the source file by
// a path relative to the index file and carries two hashes, of the raw bytes and of the text
// view, so a changed source or a changed extractor is detected before any line number is used.

import fs from 'node:fs';
import path from 'node:path';
import { validate } from './schema.js';
import { ingestFile, sourceHashes } from './ingest.js';
import { PagetreeError } from './errors.js';

export const INDEX_SCHEMA_NAME = 'pagetree-index';
export const INDEX_VERSION = 1;
export const MAX_INDEX_BYTES = 64 * 1024 * 1024;

const hex64 = { type: 'string', pattern: /^[0-9a-f]{64}$/ };
const NODE = {
  type: 'object',
  required: ['id', 'path', 'parent', 'children', 'depth', 'kind', 'title', 'summary', 'start', 'end'],
  props: {
    id: { type: 'string', pattern: /^n\d+$/ },
    path: { type: 'string', pattern: /^(\d+(\.\d+)*)?$/ },
    parent: { anyOf: [{ type: 'null' }, { type: 'string', pattern: /^n\d+$/ }] },
    children: { type: 'array', items: { type: 'string', pattern: /^n\d+$/ } },
    depth: { type: 'integer', min: 0, max: 100 },
    kind: { type: 'string', enum: ['root', 'heading', 'preamble', 'section', 'part', 'group'] },
    title: { type: 'string', max: 500 },
    summary: { type: 'string', max: 5000 },
    start: { type: 'integer', min: 1 },
    end: { type: 'integer', min: 1 },
  },
};
export const INDEX_SCHEMA = {
  type: 'object',
  required: ['schema', 'version', 'source', 'settings', 'nodes'],
  props: {
    schema: { type: 'string', enum: [INDEX_SCHEMA_NAME] },
    version: { type: 'integer', min: 1, max: 1 },
    source: {
      type: 'object',
      required: ['path', 'name', 'format', 'lines', 'sha256', 'text_sha256'],
      props: {
        path: { type: 'string', min: 1, max: 4096 },
        name: { type: 'string' },
        format: { type: 'string', enum: ['markdown', 'html', 'text', 'pdf'] },
        lines: { type: 'integer', min: 1 },
        sha256: hex64,
        text_sha256: hex64,
      },
    },
    settings: { type: 'object' },
    nodes: { type: 'array', min: 1, items: NODE },
  },
};

/** Store the source path relative to the index directory with forward slashes. */
export function relativeSourcePath(indexPath, sourcePath) {
  const rel = path.relative(path.dirname(path.resolve(indexPath)), path.resolve(sourcePath));
  return rel.split(path.sep).join('/');
}

export function saveIndex(index, indexPath, sourcePath) {
  const out = { ...index, source: { ...index.source, path: relativeSourcePath(indexPath, sourcePath) } };
  const tmp = `${indexPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 1) + '\n');
  fs.renameSync(tmp, indexPath);
  return out;
}

/** Structural checks the schema cannot express: ids, parent links, ranges, root. */
export function checkTree(nodes) {
  const errs = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.size !== nodes.length) errs.push('duplicate node ids');
  const paths = new Set(nodes.map((n) => n.path));
  if (paths.size !== nodes.length) errs.push('duplicate node paths');
  if (nodes[0].path !== '' || nodes[0].parent !== null) errs.push('first node must be the root with path ""');
  for (const n of nodes) {
    if (n.end < n.start) errs.push(`node ${n.path || '(root)'} ends before it starts`);
    for (const c of n.children) {
      const child = byId.get(c);
      if (!child || child.parent !== n.id) errs.push(`node ${n.path || '(root)'} lists child ${c} that does not point back`);
      else if (child.start < n.start || child.end > n.end) errs.push(`node ${child.path} lies outside its parent range`);
    }
  }
  return errs;
}

export function loadIndex(indexPath) {
  let raw;
  try {
    const st = fs.statSync(indexPath);
    if (st.size > MAX_INDEX_BYTES) throw new PagetreeError('input', `${indexPath} is larger than ${MAX_INDEX_BYTES} bytes`);
    raw = fs.readFileSync(indexPath, 'utf8');
  } catch (e) {
    if (e instanceof PagetreeError) throw e;
    throw new PagetreeError('input', `cannot read index ${indexPath}: ${e.code === 'ENOENT' ? 'file not found' : e.message}`);
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new PagetreeError('input', `${indexPath} is not valid JSON`);
  }
  const errs = validate(j, INDEX_SCHEMA);
  if (errs.length) throw new PagetreeError('input', `${indexPath} is not a pagetree index: ${errs.slice(0, 3).join('; ')}`);
  const terrs = checkTree(j.nodes);
  if (terrs.length) throw new PagetreeError('input', `${indexPath} has an inconsistent tree: ${terrs.slice(0, 3).join('; ')}`);
  return j;
}

export function resolveSourcePath(index, indexPath, override) {
  if (override) return path.resolve(override);
  const native = index.source.path.split('/').join(path.sep);
  // A source on another drive (Windows) cannot be relative; it is stored absolute.
  if (path.isAbsolute(native)) return native;
  return path.resolve(path.dirname(path.resolve(indexPath)), native);
}

/**
 * Load the index and its source, and compare hashes. A stale index is an error unless
 * allowStale is set, because every line range in it may point at the wrong text.
 */
export async function openIndex(indexPath, { source, allowStale = false } = {}) {
  const index = loadIndex(indexPath);
  const sourcePath = resolveSourcePath(index, indexPath, source);
  const ing = await ingestFile(sourcePath, { format: index.source.format });
  const h = sourceHashes(ing);
  const stale = h.sha256 !== index.source.sha256 || h.text_sha256 !== index.source.text_sha256;
  if (stale && !allowStale) {
    throw new PagetreeError('stale',
      `index is stale: ${sourcePath} changed since the index was built (${h.sha256 !== index.source.sha256 ? 'source bytes differ' : 'extracted text differs'}). Run \`pagetree index\` again, or pass --allow-stale to use it anyway.`);
  }
  const byPath = new Map(index.nodes.map((n) => [n.path, n]));
  const byId = new Map(index.nodes.map((n) => [n.id, n]));
  return { index, lines: ing.lines, sourcePath, stale, byPath, byId };
}
