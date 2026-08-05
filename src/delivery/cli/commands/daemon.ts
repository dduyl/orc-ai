import { Command } from "commander";
import { DaemonServer } from "../../../application/harness/daemon/daemon-server.js";
import { PipeClient } from "../../../application/harness/daemon/pipe-client.js";
import { setupInfrastructure } from "../../../application/harness/persistence/bootstrap.js";

/** Resolve the pipe override from the CLI option or ORC_PIPE env. */
export function resolvePipeOverride(optPipe?: string): string | undefined {
  return optPipe || process.env["ORC_PIPE"];
}

/** `orc daemon start` — bind the control pipe and serve runs until stopped. */
export async function daemonStart(pipe?: string): Promise<void> {
  setupInfrastructure();
  const daemon = new DaemonServer({ pipeOverride: pipe });
  let started = false;
  try {
    await daemon.start();
    started = true;
  } catch (err: any) {
    const code = (err as { code?: string })?.code;
    if (code === "EADDRINUSE" || code === "EEXIST") {
      console.error(`orc: another daemon already owns ${daemon.controlPipe} — nothing to do.`);
    } else {
      console.error(`orc: failed to start daemon: ${err?.message ?? err}`);
    }
    process.exit(1);
  }
  if (!started) process.exit(1);

  process.on("SIGINT", () => void daemon.stop());
  process.on("SIGTERM", () => void daemon.stop());
  console.log(`orc: daemon listening on ${daemon.controlPipe}`);
  // The bound control pipe keeps the process alive; the daemon's idle
  // auto-exit (or stop) closes it and the process terminates naturally.
}

/** `orc daemon stop` — ask the daemon to shut down. Exits 0 on success, 1 if none. */
export async function daemonStop(pipe?: string): Promise<void> {
  const client = await PipeClient.connect({ pipeOverride: pipe }).catch((err: any) => {
    console.error(`orc: no daemon running: ${err?.message ?? err}`);
    process.exit(1);
  });
  await client.stop();
  client.dispose();
  console.log("orc: daemon stopped.");
  process.exit(0);
}

/** `orc daemon attach` — connect, list runs, stream progress until interrupted. */
export async function daemonAttach(pipe?: string): Promise<void> {
  const client = await PipeClient.connect({
    pipeOverride: pipe,
    onProgress: (event) => {
      console.log(
        `[run ${event.runId ?? "-"}] ${event.type}${event.stepId ? ` (${event.stepId})` : ""}${event.status ? ` -> ${event.status}` : ""}`,
      );
    },
    onWorkflowComplete: (info) => {
      const report = info.report;
      console.log(
        `[run ${info.runId ?? "-"}] workflow complete (${info.status ?? "?"}) — ${report?.completed ?? 0}/${report?.totalSteps ?? 0} completed`,
      );
    },
  }).catch((err: any) => {
    console.error(`orc: no daemon running: ${err?.message ?? err}`);
    process.exit(1);
  });
  try {
    const runs = await client.list();
    console.log(`orc: attached to ${client.controlPipe} (${runs.length} run(s) on record).`);
  } catch {
    /* list is best-effort; keep streaming */
  }
  // The connected socket keeps the CLI alive until the user interrupts.
  process.on("SIGINT", () => {
    client.dispose();
    process.exit(0);
  });
}

/** Register `orc daemon start|attach|stop`. */
export function registerDaemonCommands(parent: Command): void {
  const daemon = parent.command("daemon").description("Named-pipe run daemon (control + terminal pipes)");
  daemon
    .command("start")
    .option("--pipe <path>", "override the control pipe path")
    .description("Start the daemon in the foreground")
    .action((opts: { pipe?: string }) => daemonStart(resolvePipeOverride(opts.pipe)));
  daemon
    .command("attach")
    .option("--pipe <path>", "override the control pipe path")
    .description("Attach to the daemon control pipe and stream progress")
    .action((opts: { pipe?: string }) => daemonAttach(resolvePipeOverride(opts.pipe)));
  daemon
    .command("stop")
    .option("--pipe <path>", "override the control pipe path")
    .description("Ask the daemon to shut down")
    .action((opts: { pipe?: string }) => daemonStop(resolvePipeOverride(opts.pipe)));
}