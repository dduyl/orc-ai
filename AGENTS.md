# ORC — AI Code Orchestrator

## Quickstart

```bash
npm run build
.\dist\orc.exe mcp              # start MCP HTTP server
.\dist\orc.exe start opencode   # spawn Electron GUI agent session
npm run build:binary            # build standalone dist/orc.exe
.\dist\orc.exe init             # bootstrap ~/.orc/config.json + workflows/
npm test                        # run all 127 tests
```

## Binary Build

`build:binary` flow:
1. `npm run build` — tsc + GUI renderer + asset copies
2. `node scripts/build-binary.mjs` — esbuild-bundles `dist/cli/index.js` → `dist/bundle.js` (resolves SDK exports map), then pkg packages → `dist/orc.exe`

Native addons (`better-sqlite3`, `node-pty`) are esbuild-external and resolved by pkg as separate assets.
Run `npm run rebuild:native` standalone after `npm install` if you only need to refresh native addons without a full build.

**ABI strategy:** Default target is **Electron** (NODE_MODULE_VERSION 148). Use `npm run rebuild:native` for `start opencode`. Use `npm run rebuild:host` if you need host Node.js ABI for pkg binary (`orc.exe mcp`).

**Important:** Only one ABI can occupy `node_modules/` at a time.

## Project Structure

```
src/
  types.ts           — Enums: AgentRole, StepType, ArtifactType, StepStatus, FailureReason
  schemas.ts         — Zod schemas: 8 artifact types + WorkflowDefinition + ChangeLogEntry
  cli.ts             — CLI entry point: init, plan, list, run
  agents/
    adapter.ts       — AgentAdapter interface + config loader (~/.orc/config.json)
    openai.ts        — OpenAI HTTP adapter
    anthropic.ts     — Anthropic HTTP adapter
    RequirementAnalyst.ts  — spec/requirement generation
    architecture.ts        — ADR + ContractDefinition generation
    codegen.ts             — source code generation
    testgen.ts             — test case generation
    review.ts              — artifact review + scoring
  harness/
    ArtifactStore.ts       — role-gated file write, unrestricted read
    CommandExecutor.ts     — run command groups (validate → test.unit → test.integration)
    Checkpointer.ts        — SQLite save/load/prune per thread
    step-runner.ts         — workflow runner (topological step resolution)
    context-overflow.ts    — pre-call 64KB budget check
    conformance-check.ts   — deterministic signature matching vs contract
    StepCompletionRegistry.ts — MCP bridge: completionKey → deferred resolution
    bounding.ts            — step budget (50 max) + loop detection (5 reps)
  planner/
    registry.ts      — WorkflowRegistry: loads ~/.orc/workflows/*.json + builtins
    planner.ts       — Planner: exact match → LLM classifier → dynamic YAML gen
  mcp/
    server.ts        — HTTP Streamable HTTP MCP server
    handlers/
      tool-exec.ts   — tool execution + SDK workflow runner
      capabilities.ts — list tools, resources, prompts
      constants.ts   — JSON-RPC types + builtins
  gui/
    main.ts          — Electron main process (PTY + MCP server)
    preload.ts       — Electron preload (context bridge)
    renderer.ts      — xterm.js terminal + Electron IPC
    index.html       — GUI shell
  workflows/
    index.ts                        — exports all 3 builtin workflows
    feature_implementation.ts       — full: spec → arch → code → test → review → validate
    issue_to_fix.ts                 — light: spec → code → review
    bugfix.ts                       — scoped: spec → code → review
  __tests__/
    schemas.test.ts       — 16 schema validation tests
    ArtifactStore.test.ts — 4 ownership + read/write tests
    CommandExecutor.test.ts — 6 command group tests
    Checkpointer.test.ts   — 5 SQLite persistence tests
    adapter.test.ts        — 5 config loader + adapter constructor tests
    agents.test.ts         — 1 mock adapter tests
    step-runner.test.ts    — 13 workflow topology tests
    step-handler.test.ts   — 23 gate/repair feedback + prompt tests
    builtin-workflow-gates.test.ts — 2 builtin script gate wiring tests
    context-overflow.test.ts  — 2 size check tests
    conformance-check.test.ts — 4 signature matching tests
    failure-triage.test.ts    — 2 LLM triage tests
    bounding.test.ts          — 5 budget + loop tests
    planner.test.ts           — 6 plan matching tests
    registry.test.ts          — 6 registry load tests
    mcp-server.test.ts        — 20 protocol tests
    integration.test.ts       — 13 end-to-end workflow tests
    orchestrator.test.ts      — 1 orchestration tests
    coding-agent.test.ts      — 2 coding agent tests
    adapter-pty.test.ts       — 3 PTY adapter tests
    hooks.test.ts             — 7 hook tests
    prompt-loader.test.ts     — 6 prompt loader tests
```

## Test

```bash
npm test              # run all tests (vitest)
npm run test:watch    # watch mode
npm run build         # TypeScript compile
npm run lint          # type-check only
```

## Architecture

3 layers: **Planner** (decides what) → **Harness** (decides how safely) → **Agents** (do the work)

- `commands.toml` is validation-gate only — no agent can invoke commands
- Command groups run sequentially (validate → test.unit → test.integration), short-circuit on failure
- ArtifactStore enforces role-based write ownership; reads are unrestricted
- Checkpointer uses SQLite, keyed by threadId
- MCP server uses stdio JSON-RPC 2.0
- LLM adapters use fetch() directly — no SDK dependencies

## Config

`~/.orc/config.json`:
```json
{ "provider": "openai", "apiKey": "sk-...", "model": "gpt-4o-mini" }
```

Custom workflows go in `~/.orc/workflows/*.json`.
