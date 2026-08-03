# ADR-008: Bounded Research Tool-Calls per Agent Step

## Context
Requirement Analyst and Architecture Agent sometimes need to search or
query existing decisions before finalizing output. This must not become an
unbounded loop.

## Decision
These two roles may call research tools (web search, prior-decision lookup,
code graph query) in a bounded loop before finalizing their output.
Findings that inform a decision are written into the resulting artifact's
reasoning, not discarded after use. Inconclusive research does not block
finalization — the agent finalizes with an explicit unverified-assumption
flag rather than stalling.

No other role (Codegen, Testgen) has open-ended research access — an
unknown at that stage is a documented assumption, never an escalation (see
ADR-016).

## Consequences
- A dedicated per-step iteration cap (distinct from the global step budget)
  is a real, not-yet-closed gap — currently a runaway single-step research
  loop is only stopped by the global `MAX_STEPS`/`MAX_LOOP` bound, which is
  coarser than intended.
