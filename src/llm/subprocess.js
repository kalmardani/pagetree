// Spawning the official vendor CLIs. Always an argument array with shell: false. On Windows a
// .cmd or .bat shim cannot be started without a shell, so we refuse it with a clear message
// instead of falling back to a shell. A .js or .mjs entry point is started with this Node.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findExecutable } from '../ingest.js';
import { PagetreeError } from '../errors.js';

export function resolveBin(name, override) {
  const bin = override ? (fs.existsSync(override) ? override : null) : findExecutable(name);
  if (!bin) return null;
  if (/\.(cmd|bat)$/i.test(bin)) {
    throw new PagetreeError('usage',
      `${bin} is a Windows batch shim, which cannot be started without a shell. Point the ` +
      `${name === 'claude' ? 'PAGETREE_CLAUDE_BIN' : 'PAGETREE_CODEX_BIN'} variable at the .exe or at the CLI's .js entry file.`);
  }
  if (/\.(c|m)?js$/i.test(bin)) return { command: process.execPath, prefix: [bin] };
  return { command: bin, prefix: [] };
}

/**
 * Run a command, feed stdin, collect stdout and stderr, kill on timeout.
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean}>}
 */
export function run(bin, args, { input = '', timeoutMs = 120000, cwd, env, inheritStdio = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin.command, [...bin.prefix, ...args], {
      shell: false,
      windowsHide: !inheritStdio,
      cwd,
      env: env || process.env,
      stdio: inheritStdio ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs) : null;
    if (!inheritStdio) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(new PagetreeError('provider', `could not start ${path.basename(bin.command)}: ${e.message}`));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** A fresh empty working directory, so the CLI does not pick up project files or instructions. */
export function freshWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pagetree-'));
}

export function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/** Flatten a message list into one prompt for CLIs that take a single prompt on stdin. */
export function flattenMessages(messages) {
  if (messages.length === 1) return messages[0].content;
  return messages
    .map((m) => (m.role === 'assistant' ? `<previous_reply>\n${m.content}\n</previous_reply>` : m.content))
    .join('\n\n');
}
