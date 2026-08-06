import { Command } from "commander";
import { DaemonServer } from "../../../application/harness/daemon/daemon-server.js";
import { PipeClient } from "../../../application/harness/daemon/pipe-client.js";
import { spawnMainPty } from "../main-pty.js";

/** Resolve the pipe override from the CLI option or ORC_PIPE env. */
export function resolvePipeOverride(optPipe?: string): string | undefined {
  return optPipe || process.env["ORC_PIPE"];
}

const DEFAULT_MCP_PORT = 3100;

/**
 * Resolve the MCP hosting option: `--no-mcp` → false (pipes-only); otherwise
 * host MCP on the given port (default 3100, overridable via MCP_PORT).
 */
export function resolveMcpOption(noMcp: boolean, optPort?: string): { port: number } | false {
  if (noMcp) return false;
  const portStr = optPort || process.env["MCP_PORT"] || String(DEFAULT_MCP_PORT);
  const port = parseInt(portStr, 10);
  if (Number.isNaN(port)) throw new Error(`Invalid MCP_PORT: ${optPort}`);
  return { port };
}

/** `orc daemon start` — bind the control pipe and serve runs until stopped. */
export async function daemonStart(pipe?: string, mcp: { port: number } | false = { port: DEFAULT_MCP_PORT }): Promise<void> {
  // setupInfrastructure + reconcileStaleRuns run once inside DaemonServer.start().
  const mcpPort = mcp ? mcp.port : undefined;
  const daemon = new DaemonServer({
    pipeOverride: pipe,
    mcp,
    spawnMain: () => spawnMainPty("opencode", { mcpPort }),
  });
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
    .option("--mcp-port <port>", "port for the hosted MCP HTTP server (default 3100)")
    .option("--no-mcp", "run pipes-only, without hosting MCP HTTP")
    .description("Start the daemon in the foreground (control pipe + optional MCP :3100)")
    .action((opts: { pipe?: string; mcpPort?: string; mcp?: boolean }) =>
      daemonStart(resolvePipeOverride(opts.pipe), resolveMcpOption(opts.mcp === false, opts.mcpPort)));
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