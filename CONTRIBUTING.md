# Contributing

Thank you for helping. A few rules keep the project small and predictable.

- No runtime or development dependencies. Use the Node.js standard library (22.5 or newer).
- The code must run unchanged on Windows, macOS and Linux. Use `path.join`, spawn processes
  with an argument array and `shell: false`, and accept CRLF input.
- Run `node --test` before sending a change. Tests must not use the network or secrets; use
  the `fake` adapter and local servers.
- A prompt change bumps the version line at the top of the prompt file and is described in
  the pull request with before and after output on the examples.
- A change to the index format bumps the index schema version and keeps old indexes readable
  or rejects them with a clear message.
- Write plain, concrete sentences in docs, comments and messages. Do not use the em dash or
  the en dash character.

Read DEVELOPER.md first. It explains the structure, the decision tables and the threat model.
