// Ingest turns a file into a "text view": an array of lines whose numbering matches the source
// file line for line (Markdown, plain text, HTML) or the pdftotext output (PDF). It also returns
// the headings it found, with their line numbers. Nothing here calls a model.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { splitLines, sha256 } from './text.js';
import { fail } from './errors.js';

export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

export function detectFormat(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.md' || ext === '.markdown' || ext === '.mdx') return 'markdown';
  if (ext === '.html' || ext === '.htm' || ext === '.xhtml') return 'html';
  if (ext === '.pdf') return 'pdf';
  return 'text';
}

/**
 * @returns {Promise<{format:string, bytes:Buffer, lines:string[], headings:{line:number,level:number,title:string}[]}>}
 */
export async function ingestFile(file, opts = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    fail('input', `cannot read ${file}: file not found`);
  }
  if (!stat.isFile()) fail('input', `${file} is not a regular file`);
  if (stat.size > MAX_SOURCE_BYTES) fail('input', `${file} is ${stat.size} bytes, the limit is ${MAX_SOURCE_BYTES}`);
  const bytes = fs.readFileSync(file);
  const format = opts.format || detectFormat(file);
  return ingestBytes(bytes, format, { ...opts, file });
}

export async function ingestBytes(bytes, format, opts = {}) {
  switch (format) {
    case 'markdown': {
      const lines = splitLines(decodeUtf8(bytes));
      return { format, bytes, lines, headings: markdownHeadings(lines) };
    }
    case 'text': {
      const lines = splitLines(decodeUtf8(bytes));
      return { format, bytes, lines, headings: [] };
    }
    case 'html': {
      const { lines, headings } = htmlToTextView(decodeUtf8(bytes));
      return { format, bytes, lines, headings };
    }
    case 'pdf': {
      const text = await pdfToText(opts.file, opts);
      // pdftotext separates pages with form feed. Keep it as a line break so pages start on a
      // new line; page numbers are not tracked in 0.1.0.
      const lines = splitLines(text.replace(/\f/g, '\n'));
      return { format, bytes, lines, headings: [] };
    }
    default:
      fail('usage', `unknown format ${format} (expected markdown, html, text or pdf)`);
  }
}

function decodeUtf8(bytes) {
  let s = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

// ---------------------------------------------------------------- Markdown

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_H1 = /^ {0,3}=+[ \t]*$/;
const SETEXT_H2 = /^ {0,3}-+[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function markdownHeadings(lines) {
  const out = [];
  let fence = null;
  let frontMatter = lines[0] !== undefined && /^---\s*$/.test(lines[0]);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (frontMatter) {
      if (i > 0 && /^(---|\.\.\.)\s*$/.test(line)) frontMatter = false;
      continue;
    }
    const f = line.match(FENCE);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = line.match(ATX);
    if (m) {
      const title = cleanInline(m[2] || '');
      if (title) out.push({ line: i + 1, level: m[1].length, title });
      continue;
    }
    // Setext: a single paragraph line directly above an underline of = or -.
    if (i > 0 && (SETEXT_H1.test(line) || SETEXT_H2.test(line))) {
      const prev = lines[i - 1];
      const prevPrev = i > 1 ? lines[i - 2] : '';
      const prevIsText = prev.trim() !== '' && !ATX.test(prev) && !/^\s{0,3}([-*+>]|\d+[.)])\s/.test(prev);
      if (prevIsText && prevPrev.trim() === '' && !(out.length && out[out.length - 1].line === i)) {
        out.push({ line: i, level: SETEXT_H1.test(line) ? 1 : 2, title: cleanInline(prev) });
      }
    }
  }
  return out;
}

function cleanInline(s) {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- HTML

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae',
  hellip: '\u2026', laquo: '\u00ab', raquo: '\u00bb', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', bdquo: '\u201e', shy: '', times: '\u00d7', deg: '\u00b0',
  euro: '\u20ac', middot: '\u00b7', bull: '\u2022',
};

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff) {
        try {
          return String.fromCodePoint(cp);
        } catch {
          return m;
        }
      }
      return m;
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul', 'caption', 'summary', 'details',
]);

/** Keep only the newlines of a removed span, so line numbers do not move. */
function keepNewlines(s) {
  return s.replace(/[^\n]/g, '');
}

/**
 * Convert HTML into a text view with the same number of lines as the source. Tags, comments,
 * script and style contents are removed but their newlines stay. Block tags become a space so
 * words on both sides do not merge.
 */
export function htmlToTextView(html) {
  const src = html.replace(/\r\n?/g, '\n');
  const headings = [];
  // Find headings on the raw source so the line number is the line of the opening tag.
  const hRe = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let m;
  while ((m = hRe.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    const inner = decodeEntities(m[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (inner) headings.push({ line, level: Number(m[1]), title: inner });
  }
  let t = src
    .replace(/<!--[\s\S]*?-->/g, keepNewlines)
    .replace(/<(script|style|template|noscript|svg|head)\b[\s\S]*?<\/\1\s*>/gi, keepNewlines)
    .replace(/<!doctype[^>]*>/gi, keepNewlines)
    .replace(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi, (tag, name) => {
      const nl = keepNewlines(tag);
      return BLOCK_TAGS.has(name.toLowerCase()) ? ' ' + nl : nl;
    });
  t = decodeEntities(t);
  const lines = t.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return { lines: lines.map((l) => l.trim()), headings };
}

// ---------------------------------------------------------------- PDF

/** Find an executable on PATH, honouring PATHEXT on Windows. Returns the full path or null. */
export function findExecutable(name, env = process.env) {
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const full = path.join(d, name + e);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        // not here
      }
    }
  }
  return null;
}

export function pdfToText(file, opts = {}) {
  const bin = opts.pdftotext || findExecutable('pdftotext');
  if (!bin) {
    fail('input', 'PDF input needs the pdftotext executable on PATH (it ships with poppler-utils or Xpdf tools). Convert the PDF to text yourself or install it.');
  }
  const timeoutMs = opts.timeoutMs || 120000;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-layout', '-enc', 'UTF-8', file, '-'], { shell: false, windowsHide: true });
    const chunks = [];
    let err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`pdftotext failed to start: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`pdftotext exited with code ${code}: ${err.trim().slice(0, 300)}`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

export function sourceHashes(ingested) {
  return { sha256: sha256(ingested.bytes), text_sha256: sha256(ingested.lines.join('\n')) };
}
