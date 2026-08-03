# ADR-002: Code Graph via CodeGraphContext

## Context
The Architecture Agent needs an exact, structural view of the codebase
(dependencies, call graphs, blast radius of a change) — not fuzzy semantic
search, and not one tool per language.

## Decision
Use CodeGraphContext, consumed via its MCP interface or CLI, as the
Architecture Agent's `code_graph_query` tool. It covers both backend and
frontend languages with one tool, so no per-stack graph builder is needed.

## Consequences
- Pin the exact CodeGraphContext version in use; it is an actively evolving
  project and its CLI/behavior has changed across releases.
- The graph is always regenerated on demand — never hand-maintained or
  treated as a second source of truth over the real source.
- Until wired in, the Architecture Agent's blast-radius reasoning is based
  on whatever context it's given, not on a verified structural query — this
  is the actual current state and should not be assumed resolved.
