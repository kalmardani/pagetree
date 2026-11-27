// Stand-in for the codex CLI in tests. Same idea as fake-claude.js.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = process.env.FAKE_STATE_DIR;
const marker = path.join(dir, 'codex-signed-in');
const signedIn = fs.existsSync(marker);
fs.appendFileSync(path.join(dir, 'codex-calls.log'), JSON.stringify(args) + '\n');

if (args[0] === 'login' && args[1] === 'status') {
  process.stdout.write(signedIn ? 'Logged in using ChatGPT\n' : 'Not logged in\n');
  process.exit(signedIn ? 0 : 1);
}
if (args[0] === 'login') {
  fs.writeFileSync(marker, 'yes');
  process.exit(0);
}
if (args[0] === 'exec') {
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    fs.writeFileSync(path.join(dir, 'codex-last-stdin.txt'), input);
    const reply = process.env.FAKE_CODEX_REPLY || '{"ok":true}';
    const out = args[args.indexOf('-o') + 1];
    fs.writeFileSync(out, reply);
    const ev = [
      { type: 'thread.started', thread_id: 't1' },
      { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: reply } },
      { type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 4 } },
    ];
    process.stdout.write(ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
  });
} else {
  process.exit(2);
}
