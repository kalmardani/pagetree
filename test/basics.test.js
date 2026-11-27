import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitLines, normalizeWs, estimateTokens, sanitizeForTerminal, numberLines } from '../src/text.js';
import { validate, extractJson } from '../src/schema.js';
import { VERSION } from '../src/version.js';
import { ROOT } from '../testdata/helpers.js';

test('splitLines accepts LF, CRLF and lone CR and drops one trailing empty line', () => {
  assert.deepEqual(splitLines('a\r\nb\rc\nd\n'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(splitLines('a\n\n'), ['a', '']);
  assert.deepEqual(splitLines(''), ['']);
});

test('normalizeWs collapses all whitespace and composes accents', () => {
  const decomposed = 'árv  tűrő';
  assert.equal(normalizeWs(`  ${decomposed}\n\t tükörfúrógép `), 'árv tűrő tükörfúrógép');
});

test('estimateTokens counts accented text higher than ASCII of the same length', () => {
  assert.ok(estimateTokens('őűáéíóöü'.repeat(10)) > estimateTokens('abcdefgh'.repeat(10)));
});

test('sanitizeForTerminal removes escape sequences and control characters', () => {
  assert.equal(sanitizeForTerminal('ok\u001b[31mred\u001b[0m\u0007 \u001b]0;title\u0007end\nnext\tx'), 'okred end\nnext\tx');
});

test('numberLines pads line numbers', () => {
  assert.equal(numberLines(['a', 'b'], 9), ' 9| a\n10| b');
});

test('validate reports path, value and rule', () => {
  const s = { type: 'object', required: ['a'], extra: false, props: { a: { type: 'integer', min: 1 }, b: { type: 'string', enum: ['x'] } } };
  assert.deepEqual(validate({ a: 1 }, s), []);
  const errs = validate({ a: 0, b: 'y', c: 1 }, s);
  assert.equal(errs.length, 3);
  assert.match(errs.join('\n'), /\$\.a: 0 is below the minimum 1/);
  assert.match(errs.join('\n'), /\$\.c: unknown field/);
  assert.deepEqual(validate({}, s), ['$.a: required field missing']);
  assert.equal(validate(null, { anyOf: [{ type: 'null' }, { type: 'string' }] }).length, 0);
});

test('extractJson accepts bare, fenced and prefixed JSON and rejects prose', () => {
  assert.deepEqual(extractJson('{"a":1}').value, { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":2}\n```').value, { a: 2 });
  assert.deepEqual(extractJson('Here it is: {"a":3}').value, { a: 3 });
  assert.ok(extractJson('no json here').error);
});

test('version module matches package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.version, VERSION);
  assert.equal(pkg.license, 'MIT');
  assert.deepEqual(pkg.dependencies, undefined);
  assert.deepEqual(pkg.devDependencies, undefined);
});
