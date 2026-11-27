# ADR 0004. One provider module with a separate auth dimension

## Status
Accepted, 2026-11-27

## Context
Users connect in different ways. Some have an API key, some sit behind an enterprise gateway
that takes bearer tokens from their own identity provider, some only have a consumer
subscription to a vendor's own client, and tests must run offline.

## Decision
`src/llm/provider.js` is the only module that knows adapters exist. Adapters are `openai`
(any compatible endpoint), `anthropic` (Messages API), `claude-cli` and `codex-cli` (the
official vendor CLIs as subprocesses) and `fake`. Auth is a second, explicit choice with four
values, `api-key`, `oauth` (generic OAuth 2.0 with client credentials, authorization code with PKCE
and a loopback redirect, and the device grant), `subscription` (only through the two
official CLIs) and `none` (only for a loopback base URL). Decision table A in DEVELOPER.md
lists the allowed pairs; anything else is a usage error.

For subscriptions pagetree starts the official CLI and reads what it prints. It never reads,
copies or reuses the credentials those CLIs store, and never calls a vendor API with a
consumer subscription token.

## Consequences
- Adding a provider touches one adapter file and one row of table A.
- OAuth tokens live in a per user cache file with mode 0600; refresh happens before expiry.
- The CLI adapters inherit the vendors' own behaviour and overhead. The codex CLI is an
  agent that can run commands; SECURITY.md says what the read-only sandbox leaves open.
