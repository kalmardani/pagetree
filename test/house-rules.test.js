// Fitness functions for the repository itself: house writing rules, zero dependencies, and no
// shell based product code. They run in CI next to the behaviour tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../testdata/helpers.js';

// smoke/ and *.pagetree.json hold model output from local runs; they are not part of the repo.
const SKIP = new Set(['.git', 'node_modules', 'smoke']);
const TEXT = /\.(js|mjs|cjs|json|md|txt|html|yml|yaml)$|^(LICENSE|\.gitignore|\.gitattributes|\.editorconfig)$/;

function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (TEXT.test(e.name) && !e.name.endsWith('.pagetree.json')) out.push(p);
  }
  return out;
}

const all = files(ROOT);
const DASHES = new RegExp('[\\u2013\\u2014]|&' + 'mdash;|&' + 'ndash;');
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
// Built from pieces so this file does not match its own patterns.
const ATTRIBUTION = new RegExp(['co' + '-authored', 'generated' + ' with'].join('|'), 'i');

test('no em dash or en dash anywhere in the repository', () => {
  const bad = all.filter((f) => DASHES.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(bad.map((f) => path.relative(ROOT, f)), []);
});

test('no emoji and no AI attribution lines', () => {
  const bad = all.filter((f) => {
    const s = fs.readFileSync(f, 'utf8');
    return EMOJI.test(s) || ATTRIBUTION.test(s);
  });
  assert.deepEqual(bad.map((f) => path.relative(ROOT, f)), []);
});

test('licence header is exact', () => {
  const lic = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8').split('\n');
  assert.deepEqual(lic.slice(0, 3), ['MIT License', '', 'Copyright (c) 2026 Kalm\u00e1r D\u00e1niel']);
});

test('product code spawns without a shell and ships no shell scripts', () => {
  const src = all.filter((f) => f.startsWith(path.join(ROOT, 'src')) || f.startsWith(path.join(ROOT, 'bin')));
  for (const f of src) {
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/shell:\s*true/.test(s), `${f} uses shell: true`);
    assert.ok(!/\{[^}]*\bexec(Sync)?\b[^}]*\}\s*from\s*'node:child_process'/.test(s), `${f} imports exec`);
  }
  const scripts = fs.readdirSync(ROOT, { recursive: true }).filter((f) => /\.(sh|ps1|bat|cmd)$/.test(String(f)) && !String(f).startsWith('.git'));
  assert.deepEqual(scripts, []);
});
