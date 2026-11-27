# Changelog

All notable changes to this project are documented here. The format follows Keep a
Changelog and the project uses semantic versioning.

## [0.1.0] 2026-11-27

### Added
- `pagetree index` for Markdown, HTML, plain text and, with pdftotext on PATH, PDF. Builds
  a table of contents tree from headings or from model proposed sections, with bounded leaf
  size, bounded fanout and a model written summary per node. `--plan` shows the call estimate
  without calling a model.
- Index file format version 1 with node ids, paths, titles, summaries, line ranges and
  SHA-256 hashes of the source bytes and the extracted text. Stale indexes are refused.
- `pagetree ask` with beam navigation, a navigation trace, answers as cited claims, and a
  deterministic quote verifier that drops or flags unsupported claims. Text or JSON output.
- `pagetree show` and `pagetree read`.
- `pagetree mcp`, an MCP server over stdio with the tools `toc`, `read_node` and `ask`.
- Provider layer with the `openai`, `anthropic`, `claude-cli`, `codex-cli` and `fake`
  adapters, timeouts, bounded retries, a call cap, one repair round for invalid output and
  per call logging with `--verbose`.
- Auth modes `api-key`, `oauth` (client credentials, authorization code with PKCE on a
  loopback redirect, device grant, token cache, refresh), `subscription` and `none`.
- `pagetree auth login`, `auth login claude`, `auth login chatgpt`, `auth status` and
  `auth logout`.
