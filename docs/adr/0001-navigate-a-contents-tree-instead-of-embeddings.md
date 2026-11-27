# ADR 0001. Navigate a table of contents tree instead of embedding search

## Status
Accepted, 2026-11-27

## Context
Long documents such as handbooks, contracts, regulations and manuals have a structure that
their authors put there on purpose. Chunk and embed retrieval throws that structure away,
needs an embedding model and a vector store, and returns passages whose relevance is a
similarity score nobody can inspect. The target users want answers they can check line by
line, and they often run on a laptop with nothing but Node.js and a model subscription.

## Decision
Build a tree of sections once (from headings, or from model proposed boundaries where there
are none), give every node a short model written summary, and at question time let the
model choose sections level by level from titles and summaries, with a small beam. Only the
chosen leaves are read in full. The navigation trace is part of the output.

## Consequences
- No embedding model, no vector database, no extra dependency. The index is one JSON file.
- Every retrieval decision has a written reason a person can read.
- Indexing costs one model call per node. Querying costs one call per tree level plus the
  answer call. The envelope in DEVELOPER.md puts numbers on both.
- Recall depends on summary quality. A fact that the summary of its parent hides can be
  missed. The beam, the read budget and the `read` command are the mitigations; recall is
  not measured with a golden set in 0.1.0.
- Exact keyword lookups (an article number, a product code) are not this tool's strength.
