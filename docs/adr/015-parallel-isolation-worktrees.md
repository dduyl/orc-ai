# ADR-015: Parallel Isolation via Worktrees and Ownership

## Context
Two agents (e.g. backend and frontend Codegen) working in parallel on a
shared working directory risk two distinct problems: a filesystem/git race
(both writing at once), and a scope violation (one agent editing files
outside its intended area). A prior design proposed a real-time gateway
intercepting every file write to enforce per-agent ownership; this was
rejected as impractical once execution moved to driving an external coding
agent CLI (ADR-007), which does its own file I/O outside this system's
direct control.

## Decision
Each parallel branch runs in its own git worktree, checked out from the same
base commit. This eliminates the filesystem/git race entirely — it does
not, by itself, prevent an agent from editing files outside its intended
area if the project is a monorepo with all areas physically present in
every worktree; that requires git sparse-checkout in addition, applied per
agent role if physical isolation is required.

Ownership is otherwise enforced by a post-hoc check, not a real-time
gateway: after a step completes, its recorded set of affected files is
compared against that role's allowed path patterns. A violation fails the
step with a distinct reason and triggers rollback of that step's own
worktree only — the other parallel branch is unaffected.

Merging back: the orchestrator attempts a plain `git merge` first (no LLM
involved) — since parallel branches work on largely disjoint files by
design, most merges succeed with no conflict. Only a real merge conflict is
handed to a narrowly-scoped review step, given just the conflicting hunk,
not the full diff. A conflict touching a sensitive path (migrations,
production config) routes to human escalation (ADR-016) rather than being
auto-resolved.

## Consequences
- Worktrees are used whenever branches run in parallel, independent of
  whether ownership enforcement is also needed.
- Sparse-checkout is an additional, optional layer for projects that need
  physical scope isolation; without it, ownership relies entirely on the
  post-hoc check.
- Rollback on ownership violation is scoped to the offending worktree only —
  never a full-run reset — to avoid discarding correct work done elsewhere.
