// Shared helpers for tests. Kept outside test/ so node --test does not run it as a test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXAMPLES = path.join(ROOT, 'examples');
export const TESTDATA = path.join(ROOT, 'testdata');

export function tmpDir(prefix = 'pagetree-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function capture() {
  let buf = '';
  return { write: (s) => { buf += s; return true; }, get text() { return buf; } };
}

export function copyExample(name, dir) {
  const dst = path.join(dir, name);
  fs.copyFileSync(path.join(EXAMPLES, name), dst);
  return dst;
}
