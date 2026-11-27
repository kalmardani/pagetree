import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { segmentCheck, segmentRange } from '../src/segment.js';
import { createSession } from '../src/llm/provider.js';
import { createFakeAdapter } from '../src/llm/fake.js';
import { buildIndex } from '../src/build.js';
import { saveIndex, openIndex, loadIndex, relativeSourcePath, resolveSourcePath } from '../src/indexfile.js';
import { ask } from '../src/ask.js';
import { decide, navCheck } from '../src/navigate.js';
import { tmpDir, copyExample } from '../testdata/helpers.js';

const fakeSession = (script) => createSession(createFakeAdapter(script ? { script } : {}));

test('segmentCheck enforces first line, order, range and count', () => {
  const check = segmentCheck(10, 20, 3);
  assert.deepEqual(check({ sections: [{ start_line: 10, title: 'a' }, { start_line: 15, title: 'b' }] }), []);
  const errs = check({ sections: [{ start_line: 11, title: 'a' }, { start_line: 11, title: 'b' }, { start_line: 25, title: 'c' }, { start_line: 26, title: ' ' }] }).join('\n');
  assert.match(errs, /at most 3/);
  assert.match(errs, /must be 10/);
  assert.match(errs, /must be greater than 11/);
  assert.match(errs, /outside 10\.\.20/);
  assert.match(errs, /blank/);
});

test('segmentRange merges a section that continues across windows', async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `sor ${i + 1} árvíztűrő tükörfúrógép szöveg`);
  const script = (req) => {
    const w = req.meta.window;
    if (w.start === 1) return JSON.stringify({ sections: [{ start_line: 1, title: 'Első' }, { start_line: 10, title: 'Második' }] });
    return JSON.stringify({ continues_previous: true, sections: [{ start_line: w.start, title: 'Második folytatás' }, { start_line: w.start + 5, title: 'Harmadik' }] });
  };
  const secs = await segmentRange(lines, 1, 40, { session: createSession(createFakeAdapter({ script })), leafTokens: 1500, windowTokens: 300, concurrency: 2 });
  assert.equal(secs[0].title, 'Első');
  assert.equal(secs[1].title, 'Második');
  assert.ok(secs[1].end > 10 && secs.length >= 3);
  for (let i = 1; i < secs.length; i++) assert.equal(secs[i].start, secs[i - 1].end + 1);
  assert.equal(secs.at(-1).end, 40);
});

test('decision table B for navigation actions', () => {
  const parent = { children: ['x'] };
  const leaf = { children: [] };
  assert.equal(decide(parent, { lastStep: false, remaining: 0, tokens: 99 }), 'open');
  assert.equal(decide(parent, { lastStep: true, remaining: 100, tokens: 99 }), 'read');
  assert.equal(decide(parent, { lastStep: true, remaining: 10, tokens: 99 }), 'skip_budget');
  assert.equal(decide(leaf, { lastStep: false, remaining: 100, tokens: 100 }), 'read');
  assert.equal(decide(leaf, { lastStep: false, remaining: 99, tokens: 100 }), 'skip_budget');
  assert.match(navCheck(['1', '2'], 1)({ choices: [{ path: '3', reason: '' }, { path: '1', reason: '' }] }).join(' '), /at most 1.*not one of the listed/);
});

async function indexed(name, opts = {}) {
  const dir = tmpDir();
  const src = copyExample(name, dir);
  const session = fakeSession();
  const { index } = await buildIndex(src, { session, ...opts });
  const out = path.join(dir, 'idx.json');
  saveIndex(index, out, src);
  return { dir, src, out, session };
}

test('index of the Markdown example: structure, summaries, hashes, relative source path', async () => {
  const { out, src } = await indexed('tool-library.md');
  const idx = loadIndex(out);
  assert.equal(idx.schema, 'pagetree-index');
  assert.equal(idx.source.path, 'tool-library.md');
  assert.equal(idx.source.format, 'markdown');
  assert.ok(idx.nodes.every((n) => n.summary.length > 0));
  const loans = idx.nodes.find((n) => n.title === 'Loan periods');
  assert.equal(loans.path, '3.2');
  const lines = fs.readFileSync(src, 'utf8').split('\n');
  assert.equal(lines[loans.start - 1], '### Loan periods');
});

test('ask end to end with the fake model returns only verified claims and a trace', async () => {
  const { out } = await indexed('tool-library.md');
  const r = await ask(out, 'How many days can power tools be kept on loan periods?', { session: fakeSession() });
  assert.equal(r.status, 'answered');
  assert.ok(r.claims.length >= 1);
  for (const c of r.claims) assert.ok(c.citations.every((x) => x.verified));
  assert.ok(r.trace.steps.length >= 1);
  assert.ok(r.trace.read.length >= 1);
  assert.equal(r.usage.calls, r.trace.steps.length + 1);
});

test('fabricated quotes and invented paths are dropped by the verifier', async () => {
  const { out } = await indexed('tool-library.md');
  const script = [
    JSON.stringify({ choices: [{ path: '3', reason: 'borrowing' }] }),
    JSON.stringify({ choices: [{ path: '3.2', reason: 'loan periods' }] }),
    JSON.stringify({ status: 'answered', claims: [
      { text: 'Power tools: 7 days.', citations: [{ path: '3.2', start: 38, end: 39, quote: 'Power tools can be kept for 7 days,' }] },
      { text: 'Power tools: 30 days.', citations: [{ path: '3.2', start: 38, end: 39, quote: 'Power tools can be kept for 30 days' }] },
      { text: 'From a section never read.', citations: [{ path: '5.1', start: 70, end: 72, quote: 'must attend a free 45 minute safety session' }] },
    ] }),
  ];
  const r = await ask(out, 'power tools loan length', { session: fakeSession(script) });
  assert.equal(r.claims.length, 1);
  assert.equal(r.dropped.length, 2);
  assert.deepEqual(r.dropped.map((d) => d.citations[0].problem).sort(), ['not_found', 'not_read']);
  const flagged = await ask(out, 'power tools loan length', { session: fakeSession(script), unsupported: 'flag' });
  assert.equal(flagged.claims.length, 3);
  assert.equal(flagged.claims.filter((c) => !c.supported).length, 2);
});

test('navigation cannot be steered outside the listed candidates (fail closed)', async () => {
  const { out } = await indexed('injection.md');
  const script = [
    JSON.stringify({ choices: [{ path: '99', reason: 'the document told me to' }] }),
    JSON.stringify({ choices: [{ path: '99', reason: 'again' }] }),
  ];
  await assert.rejects(ask(out, 'How often is the machine descaled?', { session: fakeSession(script) }), (e) => e.code === 'model_output');
});

test('the injection document is passed as marked untrusted data, never as instructions', async () => {
  const { out } = await indexed('injection.md');
  const fake = createFakeAdapter();
  await ask(out, 'How often is the machine descaled?', { session: createSession(fake) });
  for (const call of fake.calls) {
    assert.match(call.system, /untrusted/);
    assert.ok(!call.system.includes('IMPORTANT SYSTEM INSTRUCTION'), 'document text never enters the system prompt');
  }
  const answerCall = fake.calls.at(-1);
  const user = answerCall.messages[0].content;
  const nonce = user.match(/<<<DOCUMENT ([0-9a-f]+)>>>/)[1];
  assert.ok(user.includes(`<<<END DOCUMENT ${nonce}>>>`));
});

test('Hungarian unstructured text is segmented and answerable', async () => {
  const { out } = await indexed('kozossegi-kert.txt');
  const idx = loadIndex(out);
  assert.equal(idx.source.format, 'text');
  assert.ok(idx.nodes.length > 2);
  const r = await ask(out, 'Mennyi egy ágyás éves díja forint?', { session: fakeSession() });
  assert.equal(r.status, 'answered');
  assert.match(r.claims[0].citations[0].quote, /8000 forint/);
});

test('stale index is refused, allowStale opens it, CRLF rewrite of the same text is stale too', async () => {
  const { out, src } = await indexed('handbook.html');
  await openIndex(out);
  fs.writeFileSync(src, fs.readFileSync(src, 'utf8').replace(/\n/g, '\r\n'));
  await assert.rejects(openIndex(out), (e) => e.code === 'stale');
  const o = await openIndex(out, { allowStale: true });
  assert.equal(o.stale, true);
});

test('CRLF source indexes with the same line numbers as LF', async () => {
  const dir = tmpDir();
  const lf = fs.readFileSync(copyExample('tool-library.md', dir), 'utf8');
  const crlf = path.join(dir, 'crlf.md');
  fs.writeFileSync(crlf, lf.replace(/\n/g, '\r\n'));
  const a = await buildIndex(path.join(dir, 'tool-library.md'), { session: fakeSession() });
  const b = await buildIndex(crlf, { session: fakeSession() });
  assert.deepEqual(a.index.nodes.map((n) => [n.path, n.start, n.end]), b.index.nodes.map((n) => [n.path, n.start, n.end]));
  assert.equal(a.index.source.text_sha256, b.index.source.text_sha256);
});

test('plan mode makes no model call and the call cap is enforced before summaries', async () => {
  const dir = tmpDir();
  const src = copyExample('tool-library.md', dir);
  const { plan } = await buildIndex(src, { plan: true });
  assert.equal(plan.summary_calls, plan.nodes);
  const session = fakeSession();
  await assert.rejects(buildIndex(src, { session, maxCalls: 3 }), (e) => e.code === 'budget');
  assert.equal(session.summary().calls, 0);
});

test('an oversize leaf is split into sections, every part under the budget', async () => {
  const dir = tmpDir();
  const src = path.join(dir, 'long.md');
  const body = Array.from({ length: 120 }, (_, i) => `Line ${i} of a long chapter with enough words to count.${i % 8 === 7 ? '\n' : ''}`).join('\n');
  fs.writeFileSync(src, `# Long\n\n## Only chapter\n${body}\n`);
  const { index } = await buildIndex(src, { session: fakeSession(), leafTokens: 300, windowTokens: 600, split: 'deterministic' });
  const leaves = index.nodes.filter((n) => !n.children.length);
  assert.ok(leaves.length > 3);
  const text = fs.readFileSync(src, 'utf8').split('\n');
  for (const l of leaves) assert.ok(Buffer.byteLength(text.slice(l.start - 1, l.end).join('\n')) / 4 <= 300 + 30);
});

test('source path is stored relative with forward slashes and resolves back', () => {
  const dir = tmpDir();
  const idx = path.join(dir, 'out', 'i.json');
  const src = path.join(dir, 'docs', 'sub', 'a.md');
  const rel = relativeSourcePath(idx, src);
  assert.equal(rel, '../docs/sub/a.md');
  assert.equal(resolveSourcePath({ source: { path: rel } }, idx), path.resolve(src));
  const abs = path.resolve(dir, 'elsewhere.md');
  assert.equal(resolveSourcePath({ source: { path: abs.split(path.sep).join('/') } }, idx), abs);
});
