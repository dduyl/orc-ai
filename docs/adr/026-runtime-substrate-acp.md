# ADR-026: Runtime Substrate — ACP-Driven Coding Agent

## Context
ADR-007 chose a pseudo-terminal (PTY) as the transport to the underlying
coding-agent CLI (opencode, claude). It detected step completion by racing two
signals — the PTY process's own exit and the agent's MCP callback tagged by a
per-step completion key — with a filesystem hook-log as the completion-failing
fallback. ADR-007's own consequences warned that the PTY/MCP race is "inherently
a source of timing bugs ... treat this path as fragile until proven stable
across CLI versions."

The coding agents now expose the Agent Client Protocol (ACP): a JSON-RPC session
protocol that delivers the agent's full working state as structured events —
text deltas (`agent_message_chunk`), tool-call updates with diffs, file locations
and content, permission requests, per-session config options (`model`/`effort`/
`mode`), and usage/cost telemetry (`usage_update`). opencode ships a built-in ACP
server (`opencode acp`); claude is served via `zed-industries/claude-agent-acp`.

## Decision
Replace the PTY substrate with ACP as the coding-agent transport, for **both**
places the coding agent is used:
- **Step subagents** (harness-invoked, per-step): each step spawns the CLI in ACP
  server mode (per-step spawn retained); ORC is the ACP **client**, drives the
  session, and derives completion from ACP session state alone. The PTY/MCP race
  and the hook-log fallback are retired as completion mechanisms.
- **Main interactive session** (the `__main__` terminal): the user-facing session
  is also ACP-backed and rendered by ORC itself — an input loop, structured
  responses, and per-call permission prompts. There is **no** passthrough of the
  agent's own terminal UI.

ACP is a **rendering data channel, not a TUI** — ORC continues to render agent
progress itself (through the existing `RunTerminal` / `TerminalStore` / framed
terminal path), now from structured agent events instead of raw PTY bytes.

The graph topology, retry/escalation policy, and safety gates remain owned by this
system, not by the underlying CLI. opencode and claude are both ACP-backed.

This is a single decision (one ADR) implemented in **two PRs**, sequenced not
split: `feat/acp-substrate` (step subagents: client + strategies + step render
bridge) then `feat/acp-main-client` (main interactive session rendered as an ORC
chat client). Completion semantics, permissions, and rendering are identical
between the two surfaces.

## Consequences
- **Kills the ADR-007 completion race.** Step completion is derived from ACP
  session state alone; the fragile PTY-exit vs MCP-callback race disappears.
- **Structured agent output.** Text, tool-call diffs/locations/content, and
  usage reach ORC as structured events — replacing the compressed per-tool text
  line (e.g. `<-write <path>` / `wrote successfully`) with the real data it
  summarized.
- **Usage telemetry for ADR-022.** `usage_update` (`used` = input + cache.read +
  cache.write, `size` = model context limit, `cost` = USD) feeds the quota-handling
  strategy.
- **Model selection for ADR-021.** The per-session `model` config option
  (`provider/model[/variant]`) is the routing surface for complexity-based model
  routing per step.
- **Permissions are opt-in.** ACP servers auto-reject all tool calls unless the
  client handles `requestPermission`; ORC must reply `allow_always`/`allow_once`.
- **Per-step process spawn retained** (~0.5 s boot cost per step), preserving step
  isolation and 1:1 kill/cancel semantics. Pooling is deferred until profiling
  shows it is needed.
- **Supersedes ADR-007.** The PTY adapter path (`adapter-pty.ts`, PTY strategies,
  `HOOK_FILE_ENV` completion) is retired; ADR-007 remains the historical record.
- **Main interactive PTY passthrough replaced (ADR-025 D-3).** The
  `__main__` terminal's passthrough of the agent's TUI gives way to an
  ORC-rendered ACP chat (PR 2); the detached-daemon lifecycle and attach-anytime
  GUI in ADR-025 are unaffected — only the passthrough surface changes.