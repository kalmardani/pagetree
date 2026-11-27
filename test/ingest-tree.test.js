import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownHeadings, htmlToTextView, detectFormat, decodeEntities, ingestBytes, pdfToText } from '../src/ingest.js';
import { headingTree, windows, boundFanout, finalize, node } from '../src/tree.js';
import { splitLines } from '../src/text.js';

test('detectFormat by extension', () => {
  assert.equal(detectFormat('a/b.MD'), 'markdown');
  assert.equal(detectFormat('x.htm'), 'html');
  assert.equal(detectFormat('x.pdf'), 'pdf');
  assert.equal(detectFormat('x.log'), 'text');
});

test('markdown headings skip code fences and front matter, handle setext and closing hashes', () => {
  const lines = splitLines([
    '---', 'title: x', '# not a heading', '---', '', '# Title #', '', 'text', '```', '# in code', '```',
    '', 'Second', '------', '', '## **Bold** [link](http://x)', '~~~', '## fenced', '~~~',
  ].join('\n'));
  const h = markdownHeadings(lines);
  assert.deepEqual(h, [
    { line: 6, level: 1, title: 'Title' },
    { line: 13, level: 2, title: 'Second' },
    { line: 16, level: 2, title: 'Bold link' },
  ]);
});

test('html text view keeps the line count and finds headings on their source line', () => {
  const html = '<html><head>\n<style>\nx{}\n</style></head>\n<body><h1>T&amp;C</h1>\n<p>One <b>two</b>\nthree &#337;</p><!-- a\nb -->\n<h2 id="x">Sub</h2></body>';
  const { lines, headings } = htmlToTextView(html);
  assert.equal(lines.length, html.split('\n').length);
  assert.deepEqual(headings, [{ line: 5, level: 1, title: 'T&C' }, { line: 9, level: 2, title: 'Sub' }]);
  assert.equal(lines[5], 'One two');
  assert.equal(lines[6], 'three ő');
  assert.equal(decodeEntities('&euro;&#x41;&bogus;'), '€A&bogus;');
});

test('CRLF markdown gives the same lines and headings as LF', async () => {
  const lf = '# A\n\ntext\n\n## B\nmore\n';
  const a = await ingestBytes(Buffer.from(lf), 'markdown');
  const b = await ingestBytes(Buffer.from(lf.replace(/\n/g, '\r\n')), 'markdown');
  assert.deepEqual(a.lines, b.lines);
  assert.deepEqual(a.headings, b.headings);
});

test('pdf input without pdftotext fails with an install hint', async () => {
  await assert.rejects(async () => pdfToText('does-not-exist.pdf', { timeoutMs: 5000 }), /pdftotext/);
});

test('heading tree hoists a single title heading and adds preambles', () => {
  const lines = splitLines('intro line\n# Book\nabout\n## One\na\n### One.A\nb\n## Two\nc\n');
  const root = headingTree(lines, markdownHeadings(lines), 'book.md');
  assert.equal(root.title, 'Book');
  const flat = finalize(root);
  const view = flat.map((n) => `${n.path}|${n.kind}|${n.title}|${n.start}-${n.end}`);
  assert.deepEqual(view, [
    '|root|Book|1-9',
    '1|preamble|Book|1-3',
    '2|heading|One|4-7',
    '2.1|preamble|One|4-5',
    '2.2|heading|One.A|6-7',
    '3|heading|Two|8-9',
  ]);
});

test('heading without own text gets no preamble', () => {
  const lines = splitLines('# A\n\n## B\nx\n## C\ny\n');
  const root = headingTree(lines, markdownHeadings(lines), 'f');
  assert.deepEqual(root.children.map((c) => c.kind), ['heading', 'heading']);
});

test('windows: budget, blank line preference, oversize single line (trace table rows W1 to W3)', () => {
  const lines = ['aaaa aaaa', 'bbbb bbbb', '', 'cccc cccc', 'dddd dddd'];
  // W1: each text line costs 4 estimated tokens, a blank line 1; budget 7
  assert.deepEqual(windows(lines, 1, 5, 7), [{ start: 1, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 4 }, { start: 5, end: 5 }]);
  // W2: budget 13 fits three lines; the blank line 3 is in the second half, so cut there
  assert.deepEqual(windows(lines, 1, 5, 13), [{ start: 1, end: 3 }, { start: 4, end: 5 }]);
  // W3: one line longer than the budget is its own window, never empty, always progresses
  assert.deepEqual(windows(['x'.repeat(400), 'y'], 1, 2, 10), [{ start: 1, end: 1 }, { start: 2, end: 2 }]);
});

test('boundFanout groups children and keeps ranges', () => {
  const root = node('root', 'r', 1, 30);
  for (let i = 0; i < 30; i++) root.children.push(node('section', `s${i}`, i + 1, i + 1));
  boundFanout(root, 12);
  assert.ok(root.children.length <= 12);
  assert.ok(root.children.every((c) => c.kind === 'group'));
  assert.equal(root.children[0].start, 1);
  assert.equal(root.children.at(-1).end, 30);
  const flat = finalize(root);
  assert.equal(flat.filter((n) => n.kind === 'section').length, 30);
  assert.equal(flat[1].path, '1');
  assert.equal(flat[2].path, '1.1');
});
