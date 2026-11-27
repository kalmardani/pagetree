// Open a URL in the default browser on Windows, macOS and Linux without a shell. The caller
// always prints the URL too, so a failure here only costs a copy and paste.

import { spawn } from 'node:child_process';

export function isSafeAuthUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]');
}

export function openBrowser(url) {
  if (!isSafeAuthUrl(url)) return false;
  let cmd;
  let args;
  if (process.platform === 'darwin') [cmd, args] = ['open', [url]];
  else if (process.platform === 'win32') [cmd, args] = ['rundll32', ['url.dll,FileProtocolHandler', url]];
  else [cmd, args] = ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { shell: false, detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
