---
title: What is OpenCodeHub?
description: Graph-first code intelligence for AI coding agents, exposed over the Model Context Protocol.
sidebar:
  order: 10
---

AI coding agents have a structural blind spot. They can read a file, but
they can't see the graph the file lives in. That blind spot produces
three failure modes every agent-driven workflow eventually hits:

- **Missed dependencies.** The agent renames a function and leaves 14
  callers untouched, because `grep` found 3.
- **Broken call chains.** The agent changes a return shape, a handler
  two hops downstream crashes at runtime, and neither the agent nor its
  tests flag it. The relationship was never in context.
- **Blind edits.** The agent rewrites a critical-path function without
  knowing it sits on the hot path of 8 production flows, because nothing
  computed that ahead of time.

Grep is textual. Language servers are per-file. Embeddings are lossy.
None of them answer the questions an agent needs answered *before* it
writes a diff: what breaks if I change this, what depends on this, and
where does this data flow.

## The graph-first approach

OpenCodeHub parses your repository with tree-sitter (and SCIP indexers
for TypeScript, Python, Go, Rust, and Java), resolves imports and
inheritance, and materialises a **typed symbol graph**. That graph is
stored in an embedded DuckDB database with BM25 lexical search and
filter-aware HNSW vector search side by side. A local MCP server
exposes the graph to any agent that speaks Model Context Protocol.

```mermaid
flowchart LR
  A[Source tree] -->|tree-sitter parse| B[Symbol graph]
  B -->|resolve imports and MRO| C[Typed relations]
  C -->|BM25 plus HNSW index| D[Hybrid graph store]
  C -->|detect communities and flows| E[Processes and clusters]
  D --> F[MCP server]
  E --> F
  F -->|28 tools| G[AI coding agent]
```

Clustering, execution-flow tracing, and blast-radius analysis all happen
once at index time. Agents get complete relational context in one tool
call, not ten round-trips.

## When to reach for OpenCodeHub

- **Non-trivial refactors.** Rename a function, change a return shape,
  or move a module and let the agent see every caller before it edits.
- **Cross-file changes.** Any diff that touches more than one file and
  crosses a module boundary.
- **Blast-radius questions.** "What processes depend on `validateUser`?
  What is the risk tier of this change?"
- **Onboarding to a new repo.** Ask the graph for the top clusters,
  HTTP routes, or authentication flow before the first edit.

Next, [install the CLI](/opencodehub/start-here/install/) and run your
[first query](/opencodehub/start-here/first-query/).
