// Per user token cache. One JSON file in the per user config directory, written atomically
// with mode 0600 where the OS supports file modes. Tokens are never printed or logged; callers
// only ever see expiry times and whether a refresh token exists.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function configDir(env = process.env, platform = process.platform) {
  if (env.PAGETREE_CONFIG_DIR) return path.resolve(env.PAGETREE_CONFIG_DIR);
  if (platform === 'win32') return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'pagetree');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'pagetree');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pagetree');
}

export function createTokenStore(dir = configDir()) {
  const file = path.join(dir, 'tokens.json');

  function readAll() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && j.version === 1 && j.profiles && typeof j.profiles === 'object') return j;
    } catch {
      // missing or unreadable cache counts as empty
    }
    return { version: 1, profiles: {} };
  }

  function writeAll(data) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `tokens.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // Windows has no POSIX modes; the per user profile directory is the protection there.
    }
    fs.renameSync(tmp, file);
  }

  return {
    file,
    get(profile) {
      return readAll().profiles[profile] || null;
    },
    set(profile, entry) {
      const all = readAll();
      all.profiles[profile] = entry;
      writeAll(all);
    },
    delete(profile) {
      const all = readAll();
      const had = profile in all.profiles;
      delete all.profiles[profile];
      if (had) writeAll(all);
      return had;
    },
    list() {
      return Object.keys(readAll().profiles);
    },
  };
}
