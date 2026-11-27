# ADR 0003. Every claim is checked in code against the cited lines

## Status
Accepted, 2026-11-27

## Context
A model asked to cite will sometimes invent a quote, cite the wrong lines, or cite a section
it never saw. Asking the same model to check itself uses the mechanism that produced the
error.

## Decision
The answer schema forces every claim to carry one to four citations, each with a section
path, a line range and a verbatim quote. A deterministic verifier (decision table C in
DEVELOPER.md) accepts a citation only when the section was read for this answer, the range
lies inside it, the quote is 12 to 300 characters, and the whitespace normalised (NFC)
quote is an exact substring of the normalised range. A claim is kept only when all its
citations verify. By default unsupported claims are dropped from the answer and listed in
the JSON output; `--unsupported flag` keeps them, marked.

## Consequences
- Fabricated quotes and invented sections never reach the answer as supported claims.
- The verifier proves that the quoted words are in the document. It does not prove that
  the claim follows from them. A claim that over-reads a real quote passes. SECURITY.md and
  README say this.
- Quotes that paraphrase, shorten with an ellipsis or drop markdown markup fail. The prompt
  tells the model so, and the smoke test showed no such failures on the example.
