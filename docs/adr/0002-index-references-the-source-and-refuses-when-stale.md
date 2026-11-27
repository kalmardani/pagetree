# ADR 0002. The index references the source file and refuses to run when stale

## Status
Accepted, 2026-11-27

## Context
Citations are line ranges. If the source changes after indexing, every line range may point
at different text and the verifier would check quotes against the wrong lines. Embedding
the text in the index would double its size and still not tell the user that their file
changed.

## Decision
The index stores the source path relative to the index file (forward slashes, so it moves
between operating systems), the SHA-256 of the raw bytes and the SHA-256 of the extracted
text view. `ask`, `read` and the MCP tools re-ingest the source and compare both hashes. A
mismatch is an error (exit code 4) unless `--allow-stale` is given. The text hash also
catches a changed extractor, for example a different pdftotext version.

## Consequences
- The source must be present at query time. `--source` points at a moved copy.
- Re-ingesting costs a file read and a hash per query, which is small next to a model call.
- Converting line endings (LF to CRLF) changes the byte hash, so it counts as stale even
  though line numbers would survive. That is conservative on purpose.
