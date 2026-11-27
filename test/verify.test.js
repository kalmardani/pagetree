import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyCitation, verifyClaims, findQuote, normalizedRange } from '../src/verify.js';

const lines = [
  '# Loans', // 1
  '', // 2
  'Power tools can be kept for 7 days,', // 3
  'because they are in   higher demand.', // 4
  'Ladders can be kept for 3 days.', // 5
  '', // 6
  'Az ágyás éves díja 8000 forint.', // 7 (composed accents)
];
const node = { path: '3.2', title: 'Loan periods', start: 1, end: 7 };
const read = new Map([[node.path, node]]);

// Trace table for decision table C. Each row is one input and the expected branch.
const rows = [
  ['V0 verified across a line break', { path: '3.2', start: 3, end: 4, quote: 'kept for 7 days, because they are in higher demand' }, true, null],
  ['V1 path not read', { path: '9', start: 3, end: 3, quote: 'Power tools can be kept' }, false, 'not_read'],
  ['V2 range outside the section', { path: '3.2', start: 6, end: 9, quote: 'Power tools can be kept' }, false, 'bad_range'],
  ['V2 start after end', { path: '3.2', start: 4, end: 3, quote: 'Power tools can be kept' }, false, 'bad_range'],
  ['V3 quote too short', { path: '3.2', start: 3, end: 3, quote: '7 days' }, false, 'bad_length'],
  ['V3 quote too long', { path: '3.2', start: 3, end: 5, quote: 'x'.repeat(301) }, false, 'bad_length'],
  ['V4 quote in the section but not in the cited lines', { path: '3.2', start: 3, end: 3, quote: 'Ladders can be kept for 3 days' }, false, 'found_elsewhere'],
  ['V4 quote not anywhere', { path: '3.2', start: 3, end: 5, quote: 'Power tools can be kept for 14 days' }, false, 'not_found'],
  ['V4 decomposed accents still match', { path: '3.2', start: 7, end: 7, quote: 'ágyás éves díja 8000 forint' }, true, null],
];

for (const [name, cite, ok, reason] of rows) {
  test(`verifyCitation ${name}`, () => {
    const r = verifyCitation(cite, read, lines);
    assert.equal(r.ok, ok, JSON.stringify(r));
    if (!ok) assert.equal(r.reason, reason);
  });
}

test('a short quote is fine when it is the whole cited range', () => {
  const r = verifyCitation({ path: '3.2', start: 1, end: 1, quote: '# Loans' }, read, lines);
  assert.equal(r.ok, true);
});

test('findQuote reports the exact matched lines', () => {
  assert.deepEqual(findQuote(lines, 1, 7, 'higher demand. Ladders can'), { start: 4, end: 5 });
  assert.equal(normalizedRange(lines, 2, 2).text, '');
});

test('a claim is supported only when every citation verifies', () => {
  const claims = [
    { text: 'Seven days for power tools.', citations: [{ path: '3.2', start: 3, end: 3, quote: 'Power tools can be kept for 7 days,' }] },
    { text: 'Mixed.', citations: [{ path: '3.2', start: 3, end: 3, quote: 'Power tools can be kept for 7 days,' }, { path: '3.2', start: 5, end: 5, quote: 'Ladders can be kept for 30 days.' }] },
  ];
  const { supported, unsupported } = verifyClaims(claims, [node], lines);
  assert.equal(supported.length, 1);
  assert.equal(supported[0].citations[0].matched_lines.start, 3);
  assert.equal(unsupported.length, 1);
  assert.equal(unsupported[0].citations[1].problem, 'not_found');
});
