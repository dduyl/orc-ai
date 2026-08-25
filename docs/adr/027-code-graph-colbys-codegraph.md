# ADR-027: Code Graph via @colbymchenry/codegraph (library)

## Context
The Architecture Agent needs an exact, structural view of the codebase
(dependencies, call graphs, blast radius of a change) — not fuzzy semantic
search, and not one tool per language. ADR-002 chose CodeGraphContext, a
Python CLI consumed via `npx --no-install codegraphcontext query`. This
integration is broken: `codegraphcontext` is a Python package (`pip install`),
not npm, so `npx --no-install` always fails and only the static regex
fallback runs. The Architecture Agent's blast-radius reasoning is therefore
based on naive import-string matching, not on a verified structural query.

## Decision
Replace the broken CodeGraphContext CLI integration with
`@colbymchenry/codegraph`, a Node.js/TypeScript library consumed via direct
import (no `execSync`, no subprocess). The library stores its graph in SQLite
via `node:sqlite`, covers backend and frontend languages with one tool, and
exposes a programmatic API (`CodeGraph.open()`, `searchNodes`, `getCallers`,
`getCallees`, `getImpactRadius`). The static regex fallback is preserved as a
second attempt when no `.codegraph/` index exists.

## Indexing & freshness model
The daemon lazily opens the library on the first `code_graph_query` call per
project root (singleton cached per root). After the initial `sync()` (which
reconciles any stale files via `(size, mtime)` comparison), a file watcher is
started via `cg.watch()`. The watcher uses native OS filesystem events
(FSEvents / inotify / ReadDirectoryChangesW) with a 2-second debounce to
incrementally sync edits — whether triggered by an agent PTY, user edits, or
git operations. No per-query sync is needed; the SQLite index is always fresh.
On daemon shutdown, `cg.close()` releases the watcher, database handle, and
all resources.

When no `.codegraph/` index exists in the project root, `CodeGraph.open()`
throws and the static regex fallback (Attempt 2) runs — the same quality as
today's always-failing Attempt 1 path.

## Consequences
- `@colbymchenry/codegraph` is added as a runtime dependency in `package.json`.
- The `CodeGraphService.queryCodeGraph` public interface is unchanged — MCP tool
  schema (`code_graph_query` in `capabilities.ts`) and the context hint in
  `context-builder.ts` are not touched.
- ADR-002 is deprecated; this ADR replaces it. ADR-002's body is never edited.
- The graph is always regenerated on demand from the library — never
  hand-maintained or treated as a second source of truth over the real source.
- Until a `.codegraph/` index is built for a project, the static fallback
  provides basic import-level graph data — the same quality as today's
  always-failing Attempt 1 path.
- The file watcher runs for the daemon's lifetime; `cg.close()` must be called
  during daemon shutdown to release OS-level file descriptors and timers.
