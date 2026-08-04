# ADR-025: Detached Daemon Run Host with Attachable GUI

## Context

Today the orchestrator, its embedded MCP server, and the terminal UI all live
in one Electron process (`src/delivery/gui/main.ts:35`). Closing the GUI kills
any in-flight job, the Electron process must load native addons
(`better-sqlite3`, `node-pty`) at ABI 148, and only one client can observe a
run. The run-history read side also opens SQLite directly from the renderer
process (`src/delivery/gui/run-db.ts`).

Separately, `dist/orc.exe mcp` already runs the identical MCP server as a
headless process with no GUI at all — so the codebase already contains two
topologies (embedded and headless) that are not unified.

A detached run host is wanted so jobs survive GUI closure and the GUI can be a
thin, attach-anytime client. This is distinct from ADR-010 (per-step
checkpointing for crash recovery) and ADR-015 (git-worktree filesystem
isolation for parallel branches); it addresses process lifecycle and client
attachment, not persistence granularity or filesystem ownership. ADR-015 is
unaffected by this decision.

## Decision

Run orchestration in a detached **run host daemon** process that owns the PTYs
and the SQLite store. The Electron GUI is downgraded to a client that attaches
to the daemon's terminals and reads run status over a local IPC channel; it no
longer opens SQLite or the native addons directly.

- **Daemon surface.** The headless `orc mcp` path becomes the canonical run
  host. It keeps the MCP HTTP surface for external hosts (opencode/claude) and
  adds a local **control + terminal socket** for the GUI.
- **Internal transport.** Two logical flows over one local **named pipe**
  (Windows `\\.\pipe\orc-agent`, AF_UNIX elsewhere): a JSON-RPC **control
  channel** (start/list/status/cancel/attach) and a raw **terminal byte
  channel** for PTY output/input. gRPC is explicitly deferred — JSON-RPC over
  the pipe is sufficient for user-invoked control calls and avoids a service
  contract dependency; the pipe is not routed through MCP HTTP framing.
- **GUI as client.** The renderer becomes a pure terminal renderer +
  IPC client. It holds **no native dependencies** — `better-sqlite3` and
  `node-pty` live only in the daemon (host Node ABI). This collapses the
  ABI mismatch: the daemon targets host ABI; the Electron GUI needs no native
  build at all.
- **Lifecycle.** Closing the GUI detaches but does not kill the daemon; the job
  continues. A GUI can re-attach to a running or finished job. Daemon shutdown
  is explicit (`stop`) or idle-timeout, not implied by window close.
- **Run history.** The GUI reads run status by asking the daemon over the
  control channel, never by opening `runs.sqlite` itself. History still
  persists in the daemon's SQLite so it survives daemon restart.

## Latency strategy

The PTY/OS scheduling (~1–5 ms) and terminal-render (~1–10 ms) floors dominate;
the goal is to add as little as possible on top of that floor.

- **Named-pipe terminal channel**, not MCP HTTP: transit is tens of µs vs
  ~100–500 µs per HTTP round-trip, and avoids JSON-RPC/framing overhead on
  every byte burst.
- **Coalescing:** batch PTY output into chunks (time- and size-bounded, e.g.
  8–16 ms / 4 KiB), cutting syscalls and IPC wakeups by ~10–50× versus one
  write per character.
- **Back-pressure:** let pipe flow-control stall the PTY read when the client
  cannot keep up, so no side buffers unboundedly.
- **Delta render:** the client renders only cell diffs, never a full screen
  redraw.
- **Embedded fast path retained where needed:** a local, non-attached mode can
  keep zero-copy PTY handling; the detached stream is opt-in for when
  background + attach are required.
- **Benchmarks before/after** (µs round-trip, ms-to-first-paint) gate the
  optimization claims above.

## Consequences

- Jobs survive GUI close; multiple clients/hosts can attach to one daemon.
- Electron GUI loses its native-dependency requirement, simplifying packaging
  and eliminating the DB ABI clash for the renderer process.
- The daemon becomes a long-lived process that must manage its own lifecycle,
  idle shutdown, and crash-restart of in-flight jobs (in cooperation with the
  ADR-010 checkpoint store).
- A byte-streaming terminal protocol (coalescing/back-pressure/delta-render)
  is mandatory once detached; it is a real, if bounded, new subsystem.
- The embedded topology remains supported during migration (opt-in); embed and
  detach share the same orchestrator/core beneath the transport.
- Does not change ADR-010 or ADR-015; the run host is orthogonal to per-step
  checkpointing and to git-worktree isolation.