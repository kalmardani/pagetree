# Security

## Reporting a problem

Please report security problems privately to the maintainer, Kalmár Dániel, through the
contact address on the GitHub profile of the repository owner, or through GitHub's private
vulnerability reporting once the repository is public. Do not open a public issue for a
vulnerability. You will get an answer within a week.

## What pagetree handles

- Your document, which pagetree sends to the model provider you configure. Choose a provider
  whose data terms fit the document.
- API keys, read from environment variables at call time. They are never written to disk,
  logged or printed.
- OAuth tokens, cached in your per user config directory with file mode 0600 where the OS
  supports it. `pagetree auth status` shows only whether a token exists and when it expires.
- For subscriptions, pagetree starts the official claude or codex CLI. It never reads, copies
  or reuses the credentials those CLIs store.
- Both CLIs run from an empty temporary folder, so the project instruction files of the folder you work in (CLAUDE.md, AGENTS.md and similar) are not sent to the model, while the user level settings of each CLI still load as far as `--safe-mode` for claude and `--ignore-user-config` for codex leave them in place.

## Threat model summary

The full STRIDE table is in DEVELOPER.md. The main risk is a document that contains
instructions aimed at the model (prompt injection).

What pagetree does against it.

- Document text, and the titles and summaries derived from it, reach the model only inside
  data blocks marked with a random nonce. They are never part of the system instructions,
  and every prompt says that text in the block is data.
- No model call has tools. The claude CLI runs with `--tools ""`, no MCP servers, no session
  file and safe mode. Model output never runs a command, opens a file or fetches a URL.
- Navigation can only choose paths from the list the code showed. Anything else is rejected,
  sent back once with the error, and then the run stops.
- Every claim in an answer is checked in code. A quote must be an exact substring of the
  cited lines in a section that was actually read. Unsupported claims are dropped by default.
- Text from documents and models is stripped of terminal control sequences before printing.
- The MCP server serves only the index files named when it starts and validates every
  argument against a closed schema.

What this does not stop.

- A document can still influence which of the listed sections the model chooses, and what
  the model writes in its claims. A claim can be misleading while its quote is real.
- A document can bias the summaries written at index time, and through them later
  navigation. Index only documents whose content you are willing to have summarised.
- The codex CLI adapter starts an agent. pagetree gives it the read-only sandbox, an empty
  working directory, no user config (so no MCP servers from it) and tells it not to run commands, but an agent in that sandbox can still
  read files the user can read. If the documents are untrusted and the machine holds secrets,
  prefer the claude CLI adapter or an API adapter, which have no tools at all.
- pagetree does not protect the document from the model provider.
- An MCP client that can call `ask` can spend model calls up to the call cap per request.
