# ORC — AI Code Orchestrator

## Quickstart

```bash
npm run build                # tsc + GUI renderer bundle + asset copies
npm run start:gui           # launch the Electron GUI (pure pipe client; spawns-or-attaches the daemon)
.\dist\orc.exe mcp          # start the daemon block hosting MCP (no GUI)
npm run build:binary        # build standalone dist/orc.exe
npm test                    # run the full vitest suite (239 tests)
```

Notes:
- Builtin workflows are YAML files under `src/workflows/` and are copied into `dist/workflows/` at build time. New builtin workflows = drop a YAML here and rebuild.
- Custom workflows live in `~/.orc/workflows/*.yaml` (loaded by the Planner registry).

## Binary Build

`npm run build:binary` flow:
1. `npm run build` — tsc + GUI renderer esbuild bundle + asset/workflow copies
2. `node scripts/build-binary.mjs` — esbuild-bundles `dist/delivery/cli/index.js` → `dist/bundle.js` (resolves SDK exports map), then pkg packages → `dist/orc.exe`

Native addon `node-pty` is esbuild-external and resolved by pkg as a separate asset.
Run `npm run rebuild:host` standalone after `npm install` if you only need to refresh native addons without a full build.

**ABI strategy:** `node-pty` is **host-only, daemon-only**. `npm run rebuild:host` is the sole native rebuild script (targets the host ABI). The GUI (Electron) is a pure pipe client with zero native addons — it spawns-or-attaches the daemon and never loads `node-pty` or `better-sqlite3` itself, so no Electron-ABI rebuild is ever needed. The daemon block runs under host Node (dev: spawned via `node`; packaged: the bundled `orc` binary), so host ABI always matches.

## Project Structure

```
src/
  core/                     — shared primitives (no adapters/delivery deps)
    types.ts                — enums/types: AgentRole, StepType, ArtifactType, StepStatus, FailureReason
    schemas.ts              — zod schemas: artifact types + WorkflowDefinition + ChangeLogEntry
    hooks.ts, log.ts, index.ts
  application/              — pure domain logic (framework-agnostic)
    agents/
      adapter.ts            — AgentAdapter interface + config loader (~/.orc/config.json)
      adapter-pty.ts        — PTY-backed agent adapter (opencode, claude)
      strategy.ts           — session strategy abstraction
      strategies/           — per-tool strategies: claude.ts, opencode.ts
      index.ts
    harness/
      execution/
        CommandExecutor.ts    — run command groups (validate → test.unit → test.integration)
        step-runner.ts        — workflow runner (topological step resolution)
        bounding.ts           — per-step budget + loop detection (signalling graph)
        index.ts
      orchestrator/
        orchestrator.ts       — top-level session orchestration
        step-handler.ts       — per-step agent invocation + completion
        context-builder.ts    — assemble agent context from prior artifacts
        resume.ts, types.ts
        index.ts
      persistence/
        Checkpointer.ts       — node:sqlite save/load/prune per thread
        Tracker.ts             — session/step tracking feed
        bootstrap.ts
      signalling/
        StepCompletionRegistry.ts — MCP bridge: completionKey → deferred resolution
        pty-notifier.ts
        index.ts
      daemon/
        daemon-server.ts       — named-pipe run daemon (control pipe + MCP + main PTY)
        frame-transport.ts     — length-prefixed terminal frame codec (step-id demux)
        terminal-store.ts      — headless run terminals + replay/live fan-out
        pipe-client.ts, pipe-name.ts
      run-host.ts, start-run.ts, index.ts
    planner/
      registry.ts           — WorkflowRegistry: loads ~/.orc/workflows/*.yaml + builtins
      workflow-parser.ts    — YAML → WorkflowDefinition
      prompt-loader.ts      — prompt file loading
      index.ts
  adapters/                 — framework/MCP/stream integration
    mcp/
      server.ts             — HTTP Streamable HTTP MCP server
      sdk-server-factory.ts, http-transport.ts
      handlers/
        rpc.ts                — JSON-RPC request dispatch
        tool-exec.ts          — tool execution + workflow runner
        capabilities.ts       — list tools/resources/prompts
        workflow-handlers.ts  — workflow lifecycle (validation + create_workflow)
        workflow-validation.ts — pure workflow-definition validation
        constants.ts, content.ts, formatting.ts, result-handlers.ts, state.ts
    hooks/                  — lifecycle hooks (endpoint.ts, types.ts, index.ts)
    stream/                 — typed event stream (emitter.ts, types.ts, index.ts)
  delivery/                 — user-facing entry points
    cli/index.ts            — commander CLI (`orc daemon start|attach|stop`, `orc mcp`)
    cli/commands/daemon.ts  — daemon start/attach/stop
    cli/commands/mcp.ts     — `orc mcp` alias → the daemon block hosting MCP
    cli/main-pty.ts         — spawnMainPty (node-pty, daemon-owned main terminal)
    gui/                    — pure pipe client: main.ts + daemon-bridge.ts + preload/renderer
    tui/                    — terminal UI (tree view, status bar, stream handler)
  workflows/                — builtin YAML workflow definitions:
    feat-impl-builtin.yaml  — full: spec → arch → code → test → review → validate
    bug-fix-builtin.yaml    — scoped: spec → code → review
    review-cycle.yaml       — review loop wiring
    noop-builtin.yaml       — minimal noop (graph smoke test)
  __tests__/                — vitest suites (organized by layer mirroring src/)
    core/schemas.test.ts                          — 19 schema tests
    application/agents/*.test.ts                  — adapter, adapter-pty, agents, coding-agent
    application/harness/execution/*.test.ts      — CommandExecutor (16), step-runner (13), bounding (2)
    application/harness/orchestrator/*.test.ts   — step-handler (23), builtin-workflow-gates (2), orchestrator
    application/harness/daemon/pipe-transport.test.ts — control/terminal pipes + MCP + idle-exit
    application/harness/persistence/Checkpointer.test.ts
    application/planner/*.test.ts                — registry, prompt-loader
    adapters/mcp/                                — mcp-server (protocol smoke), handlers/workflow-validation (6)
    adapters/hooks/hooks.test.ts
    integration/integration.test.ts             — end-to-end workflow
```

## Test

```bash
npm test              # run all tests (vitest) — 239 tests
npm run test:watch    # watch mode
npm run build         # TypeScript compile + assets
npm run lint          # type-check only (tsc --noEmit)
```

**Native addons:** `node_modules/` targets the host ABI only (see ABI strategy above). A fresh `npm install` ships prebuilt host binaries; `npm run rebuild:host` recompiles them from source if a prebuilt one is missing or mismatched.

## Architecture

3 layers: **Planner** (decides what) → **Harness** (decides how safely) → **Agents** (do the work)

- Workflows are directed signal graphs: each step emits typed signals (e.g. `sig_fail`) and downstream gates select on `[sig_passed, sig_failed, …]` edges. Redo loops are expressed with `any` edges + repair feedback to the producing agent on gate failure.
- The signal engine guards against deadlocks: loop detection (bounding), duplicate-fire guards, and repair-feedback routing on gate failures.
- `commands.toml` is validation-gate only — no agent can invoke commands.
- Command groups run sequentially (validate → test.unit → test.integration), short-circuit on failure.
- Checkpointer uses SQLite, keyed by thread/session id.
- MCP server uses HTTP Streamable transport, JSON-RPC 2.0.
- LLM adapters use fetch(child PTY/process adapters) directly — no heavyweight SDK runtime in the hot path.
- `create_workflow` validates the full workflow definition before execution.

## Config

`~/.orc/config.json`:
```json
{ "provider": "openai", "apiKey": "sk-...", "model": "gpt-4o-mini" }
```

Custom workflows go in `~/.orc/workflows/*.yaml`.