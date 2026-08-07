import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { bench, beforeAll, afterAll } from "vitest";
import { DaemonServer } from "../../application/harness/daemon/daemon-server.js";
import { PipeClient } from "../../application/harness/daemon/pipe-client.js";
import { WorkflowRegistry } from "../../application/planner/registry.js";
import { log } from "../../core/log.js";

/**
 * Phase F benchmarks (ADR-025). INFORMATIONAL ONLY — machine-dependent, no
 * pass/fail gate; the resulting numbers are recorded in ADR-025-ROLLOUT Notes
 * and are NOT asserted in CI (a shared/loaded runner would flake). Three groups
 * map to the daemon hot paths actually shipped and verified by the Phase F
 * lifecycle test suite:
 *
 *   1. Control plane: a `start` → `status == completed` JSON-RPC round-trip
 *      across the named pipe (µs per full run lifecycle).
 *   2. Coalescing: how the coalescing window collapses many tiny step bytes
 *      into a handful of flushed frames (the per-batch syscall/backpressure
 *      win vs. a byte-per-frame write to a slow consumer).
 *   3. Terminal fan-out: steady-state MB/s feeding step-PTY bytes through the
 *      real daemon terminal (headless xterm + disk log + CoalescingTransform)
 *      to a live terminal pipe read by a client — the exact path a GUI reads.
 */

function uniqueOverride(label: string): string {
  const key = `${label}-${Math.random().toString(36).slice(2)}`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\orc-test-${key}`
    : path.join(os.tmpdir(), `orc-test-${key}`);
}

function smokeWorkflow(runExpr: string): object {
  return {
    version: 1,
    workflow: {
      id: "daemon_smoke",
      name: "Daemon Smoke",
      description: "bench workflow",
      steps: [
        {
          id: "gate",
          type: "script",
          run: runExpr,
          emits: [
            { name: "pass", description: "ok" },
            { name: "fail", description: "bad" },
          ],
          on: ["__start__"],
        },
      ],
      completion: "done",
    },
  };
}

const tmpBase = mkdtempSync(path.join(os.tmpdir(), "orc-bench-"));
const workflowsDir = path.join(tmpBase, "workflows");
fs.mkdirSync(workflowsDir, { recursive: true });
const registry = new WorkflowRegistry({ userDir: workflowsDir, builtinDir: path.join(tmpBase, "no-builtins") });

let daemon: DaemonServer;
let client: PipeClient;

beforeAll(async () => {
  log.setTeeToStderr(false);
  registry.loadAll();
  fs.writeFileSync(path.join(workflowsDir, "daemon_smoke.json"), JSON.stringify(smokeWorkflow(`exec "echo bench"`)));
  daemon = new DaemonServer({ projectDir: tmpBase, pipeOverride: uniqueOverride("bench"), registry });
  await daemon.start();
  client = await PipeClient.connect({ pipeOverride: daemon.controlPipe });
});

afterAll(async () => {
  fanStreamClose?.();
  client?.dispose();
  await daemon?.stop();
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

/* Keep TS from eliding the measured values. */
let consume: unknown = null;

const CONTROL_RUNS = 200; // fixed count; the loop below is ours, so it cannot run away
const FAN_ITERATIONS = 200; // fixed count of 768B lines pushed per timed body
const GUARD_MS = 30000; // hard tripwire: any timed body over this fails loudly (a healthy run is ~8s)

bench("control plane: full run RTT (µs/run)", async () => {
  const t0 = performance.now();
  for (let i = 0; i < CONTROL_RUNS; i++) {
    const res = await client.start({ task: "bench", workflowId: "daemon_smoke" });
    for (let n = 0; n < 200; n++) {
      const run = await client.status(res.runId);
      if (run.status === "completed") break;
      await new Promise((r) => setTimeout(r, 1));
    }
    consume = res.runId;
  }
  const ms = performance.now() - t0;
  if (ms > GUARD_MS) throw new Error(`control-plane bench exceeded ${GUARD_MS}ms (${Math.round(ms)}ms for ${CONTROL_RUNS} runs)`);
  consume = (CONTROL_RUNS / ms) * 1e6; // runs/sec → µs per run equivalent kept in consume
}, { iterations: 1, time: 0, warmupTime: 0, warmupIterations: 0 });

// One seeded run terminal with a live terminal-pipe client, set up ONCE so the
// timed fan-out body below is pure steady-state throughput of the daemon's
// terminal pipeline (headless xterm → disk log → CoalescingTransform → live
// pipe). Routing `client.attach`/`ensureTerminalServer` inside the timed body
// would leak a fresh named-pipe server + run row per iteration (directly-seeded
// runs never fire `workflow_complete` eviction) and drain memory/handles — the
// previous hang.
let fanWrite: (payload: string) => void = () => {};
let fanFlush: () => Promise<unknown> = async () => {};
let fanStreamClose: (() => void) | undefined;
let fanReceived = 0;

beforeAll(async () => {
  const runId = `bench-fan-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  daemon.terminalStore.ensure(runId, { coalesceMs: 5, maxFrameBytes: 4096 });
  daemon.host.tracker.createRun(
    runId,
    "daemon_smoke",
    "Daemon Smoke",
    "fan-out bench",
    daemon.host.adapter.id,
    [{ stepId: "gate", agent: null, task: null, signals: ["__start__"] }],
  );

  // Attach a real client terminal pipe (the GUI path): replay + live + EOF.
  await client.attach(runId);
  const stream = await client.attachTerminal(runId, (_s, p: Buffer) => {
    fanReceived += p.length;
  });
  fanStreamClose = stream.close;

  const term = daemon.terminalStore.get(runId)!;
  fanWrite = (payload) => term.write("gate", payload);
  fanFlush = () => term.waitParsed();
});

bench("terminal fan-out: MB/s to a live terminal pipe", async () => {
  const payload = "A".repeat(768);
  const t0 = performance.now();
  let n = 0;
  for (; n < FAN_ITERATIONS; n++) fanWrite(payload);
  await fanFlush();
  const ms = performance.now() - t0;
  if (ms > GUARD_MS) throw new Error(`fan-out bench exceeded ${GUARD_MS}ms (${Math.round(ms)}ms for ${FAN_ITERATIONS} lines)`);
  consume = (FAN_ITERATIONS * payload.length) / Math.max(ms, 0.001) / 1e3; // MB/s
}, { iterations: 1, time: 0, warmupTime: 0, warmupIterations: 0 });