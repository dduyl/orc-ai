import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { DaemonServer } from "../../../../application/harness/daemon/daemon-server.js";
import { PipeClient } from "../../../../application/harness/daemon/pipe-client.js";
import { WorkflowRegistry } from "../../../../application/planner/registry.js";
import { controlPipePath } from "../../../../application/harness/daemon/pipe-name.js";
import { Tracker, type RunRecord } from "../../../../application/harness/persistence/Tracker.js";
import { log } from "../../../../core/log.js";
import { fakePty, flushUntil, sleep } from "./helpers.js";

log.setTeeToStderr(false);

/** Unique-ish override so parallel/leftover pipes never collide. */
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
      description: "pipe transport test workflow",
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

/** Cross-platform command that blocks long enough to cancel mid-run. */
const BLOCK_CMD = process.platform === "win32" ? "ping -n 4 127.0.0.1 >nul" : "sleep 3";

async function pollStatus(client: PipeClient, runId: string, want: string, timeoutMs = 10_000): Promise<RunRecord> {
  const start = Date.now();
  for (;;) {
    const run = await client.status(runId);
    if (run.status === want) return run;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for '${want}', got '${run.status}'`);
    await sleep(25);
  }
}

/** Poll tracker status until the run reaches `want` (used after daemon teardown). */
async function pollTracker(daemon: DaemonServer, runId: string, want: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const run = daemon.host.tracker.getRun(runId);
    if (run?.status === want) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for tracker '${want}', got '${run?.status}'`);
    await sleep(25);
  }
}

let tmpBase: string;
let daemons: DaemonServer[] = [];

beforeEach(() => {
  tmpBase = mkdtempSync(path.join(os.tmpdir(), "orc-pipe-"));
  daemons = [];
});

afterEach(async () => {
  for (const d of daemons) await d.stop();
  daemons = [];
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

function makeDaemon(
  override: string,
  opts: { idleMs?: number; workflowsDir?: string; onShutdown?: () => void; tracker?: Tracker } = {},
) {
  const workflowsDir = opts.workflowsDir ?? path.join(tmpBase, "workflows");
  const registry = new WorkflowRegistry({
    userDir: workflowsDir,
    builtinDir: path.join(tmpBase, "no-builtins"),
  });
  registry.loadAll();
  const daemon = new DaemonServer({
    projectDir: tmpBase,
    pipeOverride: override,
    registry,
    tracker: opts.tracker,
    idleMs: opts.idleMs,
    onShutdown: opts.onShutdown,
  });
  daemons.push(daemon);
  return daemon;
}

function writeWorkflow(dir: string, def: object): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "daemon_smoke.json"), JSON.stringify(def));
}

describe("pipe naming", () => {
  it("derives a deterministic per-project control pipe name", () => {
    expect(controlPipePath("C:\\proj\\a")).toBe(controlPipePath("C:\\proj\\a"));
    expect(controlPipePath("C:\\proj\\a")).not.toBe(controlPipePath("C:\\proj\\b"));
    expect(controlPipePath("C:\\proj\\a")).toContain("orc-agent-");
  });
});

describe("DaemonServer control pipe", () => {
  it("binds two daemons with distinct pipe names and serves list independently", async () => {
    const a = makeDaemon(uniqueOverride("a"));
    const b = makeDaemon(uniqueOverride("b"));
    await a.start();
    await b.start();

    const clientA = await PipeClient.connect({ pipeOverride: a.controlPipe });
    const clientB = await PipeClient.connect({ pipeOverride: b.controlPipe });
    expect(clientA.controlPipe).not.toBe(clientB.controlPipe);
    expect(await clientA.list()).toEqual([]);
    expect(await clientB.list()).toEqual([]);

    clientA.dispose();
    clientB.dispose();
  });

  it("rejects bind when another daemon already owns the same pipe", async () => {
    const shared = uniqueOverride("shared");
    const a = makeDaemon(shared);
    await a.start();
    const b = makeDaemon(shared);
    await expect(b.start()).rejects.toThrow();
  });

  it("fails to connect when no daemon owns the pipe", async () => {
    await expect(PipeClient.connect({ pipeOverride: uniqueOverride("none") })).rejects.toThrow();
  });

  it("starts a script run and reports completed status round-trip", async () => {
    writeWorkflow(path.join(tmpBase, "workflows"), smokeWorkflow('exec "echo daemon-smoke"'));
    const daemon = makeDaemon(uniqueOverride("run"));
    await daemon.start();

    const progress: string[] = [];
    let complete: { status?: string; completed?: number; total?: number } = {};
    const client = await PipeClient.connect({
      pipeOverride: daemon.controlPipe,
      onProgress: (e) => progress.push(`${e.type}:${e.stepId ?? ""}`),
      onWorkflowComplete: (info) => {
        complete = { status: info.status, completed: info.report?.completed, total: info.report?.totalSteps };
      },
    });

    const result = await client.start({ task: "echo smoke", workflowId: "daemon_smoke" });
    expect(result.status).toBe("running");
    const run = await pollStatus(client, result.runId, "completed");
    expect(run.workflowName).toBe("Daemon Smoke");
    expect(progress).toContain("step_start:gate");
    expect(complete.status).toBe("completed");
    expect(complete.completed).toBe(1);
    expect(complete.total).toBe(1);
    client.dispose();
  });

  it("cancels an in-flight run and marks it cancelled", async () => {
    writeWorkflow(path.join(tmpBase, "workflows"), smokeWorkflow(`exec "${BLOCK_CMD}"`));
    const daemon = makeDaemon(uniqueOverride("cancel"));
    await daemon.start();

    const client = await PipeClient.connect({ pipeOverride: daemon.controlPipe });
    const result = await client.start({ task: "block", workflowId: "daemon_smoke" });

    await pollStatus(client, result.runId, "running");
    const cancel = await client.cancel(result.runId);
    expect(cancel.cancelled).toBe(true);

    await pollStatus(client, result.runId, "cancelled");
    client.dispose();
  });
});

describe("terminal pipes", () => {
  function seedRun(daemon: DaemonServer, runId: string): void {
    daemon.host.tracker.createRun(
      runId,
      "daemon_smoke",
      "Daemon Smoke",
      "term test",
      daemon.host.adapter.id,
      [{ stepId: "s1", agent: null, task: null, signals: ["__start__"] }],
    );
  }

  it("streams replay + live PTY frames over the run's terminal pipe", async () => {
    const daemon = makeDaemon(uniqueOverride("term"));
    await daemon.start();
    const client = await PipeClient.connect({ pipeOverride: daemon.controlPipe });

    const runId = "manual-run-1";
    seedRun(daemon, runId);

    const { pty, emitData } = fakePty();
    daemon.terminalStore.feedPty(runId, "s1", pty);
    emitData("hello pty world");
    await daemon.terminalStore.get(runId)!.waitParsed();

    const attach = await client.attach(runId);
    expect(attach.runId).toBe(runId);
    expect(attach.terminalPipe).toBeTruthy();

    const frames: string[] = [];
    let eof: () => void = () => {};
    const eofP = new Promise<void>((r) => { eof = r; });
    await client.attachTerminal(runId, (p) => frames.push(p.toString("utf8")), () => eof());

    // Replay frame arrives once the server finished registering the client;
    // only then is a subsequent emitData guaranteed to hit the live fan-out.
    await flushUntil(() => frames.length >= 1);
    await sleep(40);
    emitData("LIVE-1");
    await daemon.terminalStore.get(runId)!.waitParsed();
    daemon.terminalStore.complete(runId);
    await eofP;

    const text = frames.join("");
    expect(text).toContain("[step: s1]");
    expect(text).toContain("hello pty world");
    expect(text).toContain("LIVE-1");
    client.dispose();
  });

  it("replays accumulated content then EOF on a late attach after completion", async () => {
    const daemon = makeDaemon(uniqueOverride("replay"));
    await daemon.start();
    const client = await PipeClient.connect({ pipeOverride: daemon.controlPipe });

    const runId = "manual-run-2";
    seedRun(daemon, runId);

    const { pty, emitData } = fakePty();
    daemon.terminalStore.feedPty(runId, "s1", pty);
    emitData("before complete");
    await daemon.terminalStore.get(runId)!.waitParsed();
    daemon.terminalStore.complete(runId);

    await client.attach(runId);
    const frames: string[] = [];
    let eof: () => void = () => {};
    const eofP = new Promise<void>((r) => { eof = r; });
    await client.attachTerminal(runId, (p) => frames.push(p.toString("utf8")), () => eof());
    await eofP;

    expect(frames.join("")).toContain("before complete");
    client.dispose();
  });
});

describe("DaemonServer lifecycle", () => {
  it("auto-exits when idle with no clients and no runs", async () => {
    let shutdown = 0;
    const daemon = makeDaemon(uniqueOverride("idle"), {
      idleMs: 80,
      onShutdown: () => { shutdown++; },
    });
    await daemon.start();
    await flushUntil(() => shutdown === 1);
    expect(daemon.isStopped).toBe(true);
    await expect(PipeClient.connect({ pipeOverride: daemon.controlPipe })).rejects.toThrow();
  });

  it("stop aborts an active run", async () => {
    writeWorkflow(path.join(tmpBase, "workflows"), smokeWorkflow(`exec "${BLOCK_CMD}"`));
    // Inject an externally-owned tracker so post-stop state is observable
    // (daemon.stop() closes a tracker it created itself).
    const tracker = new Tracker(path.join(tmpBase, ".orc", "runs.sqlite"));
    const daemon = makeDaemon(uniqueOverride("stopabort"), { tracker });
    await daemon.start();
    const client = await PipeClient.connect({ pipeOverride: daemon.controlPipe });

    const result = await client.start({ task: "block", workflowId: "daemon_smoke" });
    await pollStatus(client, result.runId, "running");

    await daemon.stop();
    await pollTracker(daemon, result.runId, "cancelled");
    tracker.close();
    client.dispose();
  });

  it("releases a completed run so idle auto-exit still fires after its client disconnects", async () => {
    writeWorkflow(path.join(tmpBase, "workflows"), smokeWorkflow('exec "echo idle-after"'));
    let shutdown = 0;
    const daemon = makeDaemon(uniqueOverride("idleafter"), {
      idleMs: 80,
      onShutdown: () => { shutdown++; },
    });
    await daemon.start();

    const client = await PipeClient.connect({ pipeOverride: daemon.controlPipe });
    const result = await client.start({ task: "quick", workflowId: "daemon_smoke" });
    await pollStatus(client, result.runId, "completed");
    client.dispose();

    // A completed run must not linger as "active": that would keep the idle
    // timer from ever arming and the daemon would never auto-exit (P1-1).
    await flushUntil(() => shutdown === 1);
    expect(daemon.isStopped).toBe(true);
  });

  it("cancel on a completed run reports not-cancelled", async () => {
    writeWorkflow(path.join(tmpBase, "workflows"), smokeWorkflow('exec "echo done"'));
    const daemon = makeDaemon(uniqueOverride("cancelafter"));
    await daemon.start();

    const client = await PipeClient.connect({ pipeOverride: daemon.controlPipe });
    const result = await client.start({ task: "x", workflowId: "daemon_smoke" });
    await pollStatus(client, result.runId, "completed");

    const cancel = await client.cancel(result.runId);
    expect(cancel.cancelled).toBe(false);
    client.dispose();
  });

  it("stop() completes when a client connects during teardown", async () => {
    const daemon = makeDaemon(uniqueOverride("stoprace"));
    await daemon.start();

    const stopping = daemon.stop();
    // A connection accepted in the stop() window must be dropped, not left open
    // to hang server.close() (P1-3).
    await expect(PipeClient.connect({ pipeOverride: daemon.controlPipe })).rejects.toThrow();
    await stopping;
    expect(daemon.isStopped).toBe(true);
  });

  it("evicts a completed run's terminal from the store", async () => {
    writeWorkflow(path.join(tmpBase, "workflows"), smokeWorkflow('exec "echo evict"'));
    const daemon = makeDaemon(uniqueOverride("evict"));
    await daemon.start();

    const client = await PipeClient.connect({ pipeOverride: daemon.controlPipe });
    const result = await client.start({ task: "evict", workflowId: "daemon_smoke" });

    // Manually ensure a terminal so completion has something to evict.
    const runTerm = daemon.terminalStore.ensure(result.runId);
    await pollStatus(client, result.runId, "completed");
    await sleep(50); // let the completion fan-out run complete() + evict

    expect(runTerm.isDone).toBe(true);
    expect(daemon.terminalStore.get(result.runId)).toBeUndefined();
    client.dispose();
  });
});
