// Stand-in for the claude CLI in tests. State lives in a file under FAKE_STATE_DIR, so a test
// can see "auth login" flip the CLI from signed out to signed in. No credentials anywhere.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = process.env.FAKE_STATE_DIR;
const marker = path.join(dir, 'claude-signed-in');
const signedIn = fs.existsSync(marker);
fs.appendFileSync(path.join(dir, 'claude-calls.log'), JSON.stringify(args) + '\n');

if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: signedIn, authMethod: signedIn ? 'claude.ai' : 'none', email: 'someone@example.invalid' }));
  process.exit(signedIn ? 0 : 1);
}
if (args[0] === 'auth' && args[1] === 'login') {
  fs.writeFileSync(marker, 'yes');
  process.exit(0);
}
if (args[0] === '-p') {
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    fs.writeFileSync(path.join(dir, 'claude-last-stdin.txt'), input);
    if (!signedIn) {
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in. Please run /login', api_error_status: null }));
      process.exit(1);
    }
    const reply = process.env.FAKE_CLAUDE_REPLY || '{"ok":true}';
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: reply, total_cost_usd: 0.0012,
      usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 5, output_tokens: 7 },
      modelUsage: { 'claude-test-1': {} }, stop_reason: 'end_turn',
    }));
  });
} else {
  process.exit(2);
}
