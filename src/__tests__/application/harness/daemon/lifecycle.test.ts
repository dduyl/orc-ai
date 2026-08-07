import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { DaemonServer } from "../../../../application/harness/daemon/daemon-server.js";
import { PipeClient } from "../../../../application/harness/daemon/pipe-client.js";
import { WorkflowRegistry } from "../../../../application/planner/registry.js";
import { Tracker, type RunRecord } from "../../../../application/harness/persistence/Tracker.js";
import { fakePty, sleep } from "./helpers.js";

/**
 * Phase F lifecycle verification (ADR-025). The manual "close the GUI → job
 * keeps running → reopen and attach" confirmation, automated and deterministic
 * at the DaemonServer + PipeClient boundary. The product code is unchanged;
 * this suite asserts the shipped lifecycle behaviour.
 *
 *   F1  a finished run survives a daemon restart and is re-attached from its
 *       on-disk run log (cold restore), reaching the client as a replay stream.
 *   F2  an in-flight run survives its only control client disconnecting (the
 *       "GUI closed" case) and completes independently; a second client that
 *       reconnects mid-run sees the same final status and can attach the live
 *       terminal to completion.
 *   F3  a run whose only client disconnects AFTER the workflow completed is
 *       still re-readable/attachable on a fresh client (no loss on detach).
 */

/** Unique-ish pipe override so parallel/leftover pipes never collide. */
function uniqueOverride(label: string): string {
  const key = `${label}-${Math.random().toString(36).slice(2)}`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\orc-test-${key}`
    : path.join(os.tmpdir(), `orc-test-${key}`);
}

/** Single script gate workflow; `runExpr` is the script step's `run` value. */
function smokeWorkflow(runExpr: string): object {
  return {
    version: 1,
    workflow: {
      id: "daemon_smoke",
      name: "Daemon Smoke",
      description: "lifecycle test workflow",
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

/**
 * Command-line that blocks long enough to detach mid-run, then exits 0.
 * Call sites slot it in as exec "${BLOCK_CMD}" (parsed by parseRun).
 * The \\" are escaped quotes that unescapeQuoted turns back into real double
 * quotes around the node -e argument. Blocking with node itself (always
 * present) is deterministic on every platform, unlike ping/timeout/sleep,
 * which are unreliable on locked-down Windows hosts.
 */
const BLOCK_CMD = `node -e \\"setTimeout(() => process.exit(0), 2500)\\"`;

async function pollStatus(client: PipeClient, runId: string, want: string, timeoutMs = 12_000): Promise<RunRecord> {
  const start = Date.now();
  for (;;) {
    const run = await client.status(runId);
    if (run.status === want) return run;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for '${want}', got '${run.status}'`);
    await sleep(25);
  }
}

let tmpBase: string;
let projectDir: string;
let registry: WorkflowRegistry;
const booted: DaemonServer[] = [];

beforeAll(() => {
  tmpBase = mkdtempSync(path.join(os.tmpdir(), "orc-life-"));
  projectDir = tmpBase;
  const workflowsDir = path.join(projectDir, "workflows");
  fs.mkdirSync(workflowsDir, { recursive: true });
  registry = new WorkflowRegistry({
    userDir: workflowsDir,
    builtinDir: path.join(projectDir, "no-builtins"),
  });
  registry.loadAll();
});

afterAll(async () => {
  for (const d of booted) await d.stop();
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

function makeDaemon(override: string): DaemonServer {
  const daemon = new DaemonServer({
    projectDir,
    pipeOverride: override,
    registry,
  });
  booted.push(daemon);
  return daemon;
}

async function boot(daemon: DaemonServer): Promise<DaemonServer> {
  await daemon.start();
  return daemon;
}

/** Write the daemon_smoke workflow definition for the suite's project dir. */
function writeSmoke(runExpr: string): void {
  const workflowsDir = path.join(projectDir, "workflows");
  fs.writeFileSync(path.join(workflowsDir, "daemon_smoke.json"), JSON.stringify(smokeWorkflow(runExpr)));
}

describe("Phase F lifecycle verification", () => {
  it("F1: a finished run survives daemon restart and re-attaches from the on-disk log", { timeout: 30_000 }, async () => {
    // First daemon: seed a controlled finished run whose terminal bytes are
    // appended to the durable run log under <projectDir>/.orc/runs/<runId>.log.
    const daemonA = await boot(makeDaemon(uniqueOverride("f1a")));
    const runId = "cold-restore-run";
    daemonA.host.tracker.createRun(
      runId,
      "daemon_smoke",
      "Daemon Smoke",
      "cold-restore seed",
      daemonA.host.adapter.id,
      [{ stepId: "codegen", agent: null, task: null, signals: ["__start__"] }],
    );
    const pty = fakePty();
    daemonA.terminalStore.feedPty(runId, "codegen", pty.pty);
    pty.emitData("COLD_REPLAY_BYTES");
    await daemonA.terminalStore.get(runId)!.waitParsed();
    daemonA.terminalStore.complete(runId);
    await sleep(20); // allow the terminal's coalescing flush to write the EOF

    const logPath = path.join(projectDir, ".orc", "runs", `${runId}.log`);
    expect(fs.existsSync(logPath)).toBe(true);
    await daemonA.stop();

    // Simulate a daemon restart: a fresh instance over the same projectDir
    // (new TerminalStore — no in-memory state; only the disk log + sqlite).
    const daemonB = await boot(makeDaemon(uniqueOverride("f1b")));
    const client = await PipeClient.connect({ pipeOverride: daemonB.controlPipe });

    const attach = await client.attach(runId);
    expect(attach.runId).toBe(runId);
    expect(attach.terminalPipe).toBeTruthy();

    // Fresh terminal must replay the whole screen from disk → EOF.
    const frames: string[] = [];
    let done: () => void = () => {};
    const eofP = new Promise<void>((r) => { done = r; });
    await client.attachTerminal(runId, (_s, p) => frames.push(p.toString("utf8")), () => done());
    await eofP;
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames.join("")).toContain("COLD_REPLAY_BYTES");
    client.dispose();
    await daemonB.stop();
  });

  it("F2: an in-flight run survives its only client disconnecting and a second client sees it complete", { timeout: 30_000 }, async () => {
    writeSmoke(`exec "${BLOCK_CMD}"`);
    const daemon = await boot(makeDaemon(uniqueOverride("f2")));

    const clientA = await PipeClient.connect({ pipeOverride: daemon.controlPipe });
    const res = await clientA.start({ task: "detach-mid-run", workflowId: "daemon_smoke" });
    await pollStatus(clientA, res.runId, "running");

    // "GUI closed": the ONLY control client disconnects mid-run. The run must
    // keep executing on the daemon's own host.
    clientA.dispose();

    // Reconnect with a fresh client while the run is still in flight.
    await sleep(150);
    const clientB = await PipeClient.connect({ pipeOverride: daemon.controlPipe });
    const mid = await clientB.status(res.runId);
    expect(mid.status).toBe("running");

    // Attach the run's terminal before completion; must receive live + EOF.
    const attach = await clientB.attach(res.runId);
    expect(attach.terminalPipe).toBeTruthy();
    const seen: string[] = [];
    let done: () => void = () => {};
    const eofP = new Promise<void>((r) => { done = r; });
    await clientB.attachTerminal(res.runId, (_s, p) => seen.push(p.toString("utf8")), () => done());

    // Run completes on its own; B observes the completed status + terminal EOF.
    await pollStatus(clientB, res.runId, "completed");
    await eofP;
    expect(seen.length).toBeGreaterThanOrEqual(1);
    clientB.dispose();
    await daemon.stop();
  });

  it("F3: a run that completed while the only client was detached is re-readable on a fresh client", { timeout: 30_000 }, async () => {
    writeSmoke(`exec "echo detached-complete"`);
    const daemon = await boot(makeDaemon(uniqueOverride("f3")));

    const clientA = await PipeClient.connect({ pipeOverride: daemon.controlPipe });
    const res = await clientA.start({ task: "finish-then-detach", workflowId: "daemon_smoke" });
    // Let the run finish while A is still connected, then disconnect A after.
    await pollStatus(clientA, res.runId, "completed");
    clientA.dispose();

    // A brand-new client sees the finished run and can still attach it.
    const clientB = await PipeClient.connect({ pipeOverride: daemon.controlPipe });
    const run = await clientB.status(res.runId);
    expect(run.status).toBe("completed");
    const attach = await clientB.attach(res.runId);
    expect(attach.terminalPipe).toBeTruthy();
    clientB.dispose();
    await daemon.stop();
  });
});