# pagetree

Ask questions about a long document and get answers you can check line by line.

pagetree turns a long document into a table of contents tree. When you ask a question, a
language model reads the contents the way a person reads the contents page of a book,
chooses a few sections with a short reason, opens them, and answers. Every claim in the
answer carries a citation with a section path, a line range and a verbatim quote, and
pagetree checks each quote against the source file in code before it shows the answer.
Claims whose quotes do not check out are dropped.

There are no embeddings and no vector database. The index is one JSON file next to your
document. pagetree has zero dependencies and runs on Node.js 22.5 or newer on Windows, macOS
and Linux.

## Quick start

Straight from GitHub, without installing:

```
npx github:kalmardani/pagetree index handbook.md
npx github:kalmardani/pagetree ask handbook.pagetree.json "How long can I keep a power tool?"
```

From a local clone:

```
git clone https://github.com/kalmardani/pagetree
cd pagetree
node bin/pagetree.js index examples/tool-library.md
node bin/pagetree.js ask examples/tool-library.pagetree.json "How long can I keep a power tool?"
```

The default connection is the official `claude` CLI with your own subscription. Any of the
other connections below work the same way.

## Use your own subscription

```
pagetree auth login claude      # signs in the official claude CLI, then use --provider claude-cli
pagetree auth login chatgpt     # signs in the official codex CLI, then use --provider codex-cli
pagetree auth status            # shows which connections are ready
```

Each command checks that the official CLI is installed (and prints how to install it if
not), checks whether it is already signed in, and otherwise starts that CLI's own sign in in
your terminal. pagetree only starts the official CLIs and never reads, copies or reuses the
tokens they store, nor calls a vendor API with a subscription token.

## Example output

These are real outputs from `examples/tool-library.md` with `--provider claude-cli --model
claude-haiku-5-5` on 2026-11-27. Indexing the 87 line file took 18 model calls and cost
0.0055 dollars.

```
$ pagetree ask examples/tool-library.pagetree.json "How long can I keep a power tool, and what happens if I bring it back late?"
Answer
  You can keep a power tool for 7 days. [1]
  You can extend the loan once, for the same length, if nobody else has reserved the item. [2]
  There is no money fine for a late return. Instead, you cannot borrow anything for the same number of days the item was late. [3]
  If you are late three times within twelve months, you lose the right to borrow power tools for six months. [4]

Citations
  [1] 3.2 Loan periods, lines 38-38
      "Power tools can be kept for 7 days,"
  [2] 3.2 Loan periods, lines 41-42
      "A loan can be extended once, by the same length, as long as nobody else has reserved the item."
  [3] 4.2 Late returns, lines 58-59
      "There is no money fine for a late return. Instead, a member who returns an item late cannot borrow anything for the same number of days that the item was late."
  [4] 4.2 Late returns, lines 59-60
      "A member who is late three times within twelve months loses the right to borrow power tools for six months."

Navigation
  step 1: 6 sections shown
    open        3 Borrowing: Covers loan periods by item type, so it answers how long a power tool can be kept.
    open        4 Returns and late items: Covers late-return rules and borrowing bans for late items, answering what happens if the tool comes back late.
  step 2: 6 sections shown
    read        4.2 Late returns: Explains what happens with late returns: borrowing bans, no fine.
    read        3.2 Loan periods: Gives the loan period for power tools (7 days) and extension rules.
    read        3.1 How many items: Limits on how many power tools a member can hold at once.
  read: 4.2 (lines 56-61), 3.2 (lines 36-43), 3.1 (lines 31-35)

Usage: 3 model calls (0 repair rounds), 5570 input tokens, 1344 output tokens, cost $0.0018, model claude-haiku-5-5
```

Hungarian works the same way. `examples/kozossegi-kert.txt` has no headings, so the model
proposed the sections:

```
$ pagetree show examples/kozossegi-kert.pagetree.json
kozossegi-kert.txt  (text, 39 lines, 10 nodes)
(root)   kozossegi-kert.txt  [1-39]
  1        A kert célja és a házirend hatálya  [1-6]
  2        Ágyásbérlés feltételei és díjai  [7-11]
  3        Öntözés és vízhasználat  [12-16]
  4        Növényvédelem és vegyszerhasználat tilalma  [17-20]
  5        Közös szerszámok és a fészer  [21-24]
  6        Komposztálás szabályai  [25-28]
  7        Közös munkanapok és részvételi kötelezettség  [29-32]
  8        Látogatási idő és általános rend  [33-36]
  9        Vitarendezés és a kertgyűlés döntései  [37-39]
```

## Commands

```
pagetree index <file> [-o out.json] [--plan]      build the index (--plan shows the call estimate, no model call)
pagetree ask <index.json> "question" [--json]     navigate, answer, verify
pagetree show <index.json> [--summaries]          print the tree and whether the source changed
pagetree read <index.json> <path>                 print one section with line numbers
pagetree mcp <index.json> [more.json ...]         MCP server over stdio
pagetree auth login | login claude | login chatgpt | status | logout
```

Useful options. `--beam 3` sets how many sections the model may choose per step, `--read-tokens
6000` caps how much section text the answer call sees, `--unsupported flag` keeps unverified
claims in the answer, marked, instead of dropping them, `--allow-stale` uses an index whose
source changed, `--verbose` writes one JSON log line per model call to stderr (task, model,
prompt version, tokens, cost, latency, never keys or text). `pagetree --help` lists all.

Exit codes are 0 ok, 2 usage, 3 input, 4 stale index, 5 invalid model output, 6 provider
error, 7 call cap reached, 8 auth, 1 internal.

## Interfaces

pagetree has two interfaces. Every feature is a CLI command, and `pagetree mcp` starts a
Model Context Protocol server (JSON-RPC 2.0 over stdio, one message per line) with three
tools, `toc`, `read_node` and `ask`. The server only serves the index files named when it
starts, so a client cannot make it open other files. A client configuration looks like this:

```json
{
  "mcpServers": {
    "handbook": {
      "command": "npx",
      "args": ["-y", "github:kalmardani/pagetree", "mcp", "/path/to/handbook.pagetree.json"]
    }
  }
}
```

There is no HTTP proxy mode, because nothing in pagetree needs one.

## Configuration

Flags win over environment variables.

| Flag | Variable | Meaning |
|---|---|---|
| `--provider` | `PAGETREE_PROVIDER` | `claude-cli` (default), `codex-cli`, `anthropic`, `openai`, `fake` (tests only) |
| `--model` | `PAGETREE_MODEL` | model id; required for `anthropic` and `openai`. Set it for the CLI adapters too, so runs are repeatable |
| `--base-url` | `PAGETREE_BASE_URL` | endpoint for `openai` (any compatible server) or an `anthropic` gateway |
| `--auth` | `PAGETREE_AUTH` | `api-key`, `oauth`, `subscription`, `none` |
| `--api-key-env` | `PAGETREE_API_KEY_ENV` | name of the variable that holds the key (default `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`) |
| `--timeout` | `PAGETREE_TIMEOUT_MS` | per call timeout, default 180000 |
| `--max-calls` | `PAGETREE_MAX_CALLS` | call cap per run, default 500 for `index` and 12 for `ask` |
| | `PAGETREE_TEMPERATURE` | sent only when set |
| | `PAGETREE_CLAUDE_BIN`, `PAGETREE_CODEX_BIN` | path to the CLI if it is not on PATH (on Windows point at the `.exe` or the `.js` entry, not a `.cmd` shim) |
| | `PAGETREE_CLAUDE_SAFE_MODE=0` | omit `--safe-mode` for older claude CLI versions |
| | `PAGETREE_CODEX_USER_CONFIG=1` | let the codex CLI load your own `config.toml` and rules (off by default, because that config can add tools) |
| | `PAGETREE_CONFIG_DIR` | override the per user config directory |

Which auth works with which provider:

| Provider | Auth |
|---|---|
| `openai` | `api-key`, `oauth`, or `none` for a server on 127.0.0.1 or localhost |
| `anthropic` | `api-key` (x-api-key header), `oauth` (bearer token, for a gateway), or `none` for a loopback server |
| `claude-cli`, `codex-cli` | `subscription` |

### OAuth

For endpoints that accept bearer tokens from your own identity provider (an enterprise
gateway, or a hosted model behind an identity platform), pagetree has a small OAuth 2.0
client with three grants. `client_credentials` is for machine identities, `pkce` (the
default) opens your browser and receives the code on a loopback address with a random port,
and `device` prints a code and a URL and waits.

```
export PAGETREE_PROVIDER=openai PAGETREE_AUTH=oauth PAGETREE_MODEL=<model id> PAGETREE_BASE_URL=https://gateway.example.com/v1
export PAGETREE_OAUTH_TOKEN_URL=https://login.example.com/oauth2/token
export PAGETREE_OAUTH_AUTH_URL=https://login.example.com/oauth2/authorize
export PAGETREE_OAUTH_CLIENT_ID=<client id>
export PAGETREE_OAUTH_SCOPE="api://gateway/.default offline_access"
pagetree auth login
```

The same settings can live in a JSON file given with `--oauth-config` or
`PAGETREE_OAUTH_CONFIG` (keys `grant`, `token_url`, `auth_url`, `device_url`, `client_id`,
`scope`, `client_auth` as `post` or `basic`, `profile`, `client_secret_env`). A client secret
is only read from the environment (`PAGETREE_OAUTH_CLIENT_SECRET`, or the variable named by
`client_secret_env`), never from the file. Tokens are cached in `%APPDATA%\pagetree` on
Windows, `~/Library/Application Support/pagetree` on macOS and `$XDG_CONFIG_HOME/pagetree` or
`~/.config/pagetree` on Linux, with file mode 0600 where the OS has file modes, and refreshed
before they expire. `pagetree auth logout` deletes the cached token.

## Input formats

Markdown (`.md`, ATX and setext headings, code fences ignored), HTML (`h1` to `h6`, tags and
scripts removed while every source line keeps its number), plain text (any other extension),
and PDF if a `pdftotext` executable is on PATH (it comes with the poppler or Xpdf tools).
pagetree looks for it at run time and says so if it is missing. For PDF the line numbers
refer to the pdftotext output. CRLF and LF line endings give the same line numbers.

Text without headings is cut into windows of a bounded size, and the model proposes section
starts and titles inside each window as validated JSON. Nothing in this step depends on the
language of the text, so Hungarian, English and other languages work the same way.

## How it works

1. Ingest keeps a text view of the file whose lines match the source lines.
2. The tree comes from headings, or from model proposed sections. Sections above the leaf
   budget (`--leaf-tokens`, default 1500 estimated tokens) are split further, and nodes with
   more than `--fanout` children get grouped.
3. The model writes a summary per node from the bottom up, within `--summary-tokens`.
4. The index stores the tree, the summaries, line ranges and two SHA-256 hashes of the
   source. A changed source is detected and refused.
5. At question time the model sees titles and summaries one level at a time, chooses up to
   `--beam` sections with a reason, and the chosen leaves are read.
6. The answer comes back as JSON claims with citations. Code checks that every quote is an
   exact substring of the cited lines after whitespace normalisation and drops the claims
   that fail.

Document text is untrusted. It reaches the model only inside marked data blocks, never in
the instructions, the model has no tools, and the code decides what may be opened, read and
shown. SECURITY.md describes what this stops and what it does not.

## Limits

- The verifier proves the quoted words are in the document. It does not prove the claim
  follows from them, so read the quotes.
- Navigation can miss a relevant section when the beam is full or a summary hides a detail.
  A wider `--beam` costs more and finds more.
- Every node costs one model call at index time. `pagetree index --plan` shows the number
  before you spend anything.
- Exact keyword search (article numbers, codes) is not what this tool is built for.
- PDF support depends on an external pdftotext and has no page numbers in 0.1.0.

## Licence

MIT, Copyright (c) 2026 Kalmár Dániel. See LICENSE.
