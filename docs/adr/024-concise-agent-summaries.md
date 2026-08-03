# ADR-024: Concise Agent-to-Orchestrator Summaries

## Context
Each agent step's result accumulates in the orchestrator's own context
across a multi-step campaign. A verbose, fully-narrated report from every
step compounds token cost across a long run, independent of any tool or
plugin.

## Decision
Every agent role's result, as reported back to the orchestrator, must be a
concise summary sufficient for routing and review — not a full narrative of
the work performed. This is a constraint on each role's prompt (ADR's for
each role), applied uniformly, requiring no new tool, plugin, or schema
change.

## Consequences
- This does not reduce the token cost of the artifact itself (code, tests,
  documents) — only the summary that flows back into the orchestrating
  session's own accumulating context.
- Overly aggressive summarization risks losing information the next step
  or a human reviewer actually needs; a summary must remain sufficient to
  act on, not merely short.
