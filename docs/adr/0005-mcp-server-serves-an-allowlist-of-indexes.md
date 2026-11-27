# ADR 0005. The MCP server serves only the index files named at start

## Status
Accepted, 2026-11-27

## Context
Other agents should be able to use an index through MCP. A tool that accepts a file path
would let any connected client read any file the user can read.

## Decision
`pagetree mcp a.json b.json` validates each index at start and serves them by name. Tool
arguments name an index from that list, never a path. Three tools, `toc`, `read_node` and
`ask`, with closed argument schemas, paging, an output cap of 100 000 characters and a note
that document text is untrusted. Transport is JSON-RPC 2.0 over stdio, one message per line,
zero dependencies. `initialize` is answered with the client's protocol version when it is
one of 2025-11-25, 2025-06-18, 2025-03-26 or 2024-11-05, otherwise with 2025-11-25; tools
also work without a prior `initialize`.

## Consequences
- No path traversal through tool arguments.
- `ask` spends model calls on behalf of the connected client. The call cap applies per call
  (default 12, `--max-calls`).
