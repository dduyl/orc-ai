import { spawn, type IPty } from "node-pty";
import type { AdapterDef, AgentCallResult } from "./adapter.js";
import { classifyAgentError } from "./errors.js";
import { HOOK_FILE_ENV } from "../../core/hooks.js";
import { getStrategy } from "./strategy.js";
import { acpEnabledFor, callAcpAgentStream } from "./adapter-acp.js";
import { getAgentCwd } from "./agent-cwd.js";
import { createHookFile, readHookEvents, removeHookFile } from "../../adapters/hooks/endpoint.js";
import { log } from "../../core/log.js";

const POLL_INTERVAL_MS = 500;

export interface AgentPTYStreamHandle {
  pty: IPty;
  promise: Promise<AgentCallResult>;
}

function cleanPTYData(data: string): string {
  return data
    .replace(/\r/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\].*?(\x07|\x1b\\)/g, "")
    .replace(/\x1b[\\PX^_]/g, "")
    .replace(/\\(["\\/])/g, "$1");
}

export function callAgentStream(
  adapter: AdapterDef,
  prompt: string,
  hookFilePath?: string,
): AgentPTYStreamHandle {
  if (acpEnabledFor(adapter.id)) {
    return callAcpAgentStream(adapter, prompt, hookFilePath);
  }

  const start = Date.now();
  const strat = getStrategy(adapter.id);
  const hookFile = hookFilePath || createHookFile("unknown");

  let env: Record<string, string>;
  let pty: IPty;

  try {
    const cols = 120;
    const rows = 40;
    env = { ...process.env } as Record<string, string>;
    env[HOOK_FILE_ENV] = hookFile;
    const args = strat.buildArgs(prompt);

    if (process.platform === "win32" && strat.id === "opencode") {
      log.info("Spawning opencode via bash.exe");
      pty = spawn("bash.exe", [], {
        cols, rows, name: "xterm-256color", cwd: getAgentCwd(), env,
      });
      pty.write(`PROMPT=$(cat << 'EOF'\r`);
      for (const line of prompt.split(/\r?\n/)) {
        pty.write(`${line}\r`);
      }
      pty.write(`EOF\r)\r`);
      pty.write(`${adapter.command} --pure --prompt "$PROMPT"\r`);
    } else {
      pty = spawn(adapter.command, args, {
        cols, rows, name: "xterm-256color", cwd: getAgentCwd(), env,
      });
    }
  } catch (err: any) {
    if (!hookFilePath) removeHookFile(hookFile);
    const pErr = err;
    const dummyPty = { onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {}, pid: 0, cols: 0, rows: 0 } as unknown as IPty;
    return {
      pty: dummyPty,
      // Classified as kind:"spawn" (ADR-022) — never message-matched on PTY stdout.
      promise: Promise.reject(classifyAgentError(new Error(`Failed to spawn PTY for ${adapter.command}: ${(pErr as Error).message}`))),
    };
  }

  let stdout = "";

  pty.onData((data: string) => {
    stdout += cleanPTYData(data);
  });

  let pollHandle: ReturnType<typeof setInterval>;

  const promise = new Promise<AgentCallResult>((resolve) => {
    pollHandle = setInterval(() => {
      const events = readHookEvents(hookFile);
      if (strat.isComplete(events)) {
        clearInterval(pollHandle);
        const duration = Date.now() - start;
        if (!strat.keepAlive) pty.kill();
        resolve({
          content: strat.extractOutput(stdout),
          model: adapter.id,
          tokensUsed: 0,
          duration,
        });
      }
    }, POLL_INTERVAL_MS);

    pty.onExit(() => {
      clearInterval(pollHandle);
      const duration = Date.now() - start;
      resolve({
        content: strat.extractOutput(stdout),
        model: adapter.id,
        tokensUsed: 0,
        duration,
      });
    });
  });

  return { pty, promise };
}

export async function callAgent(
  adapter: AdapterDef,
  prompt: string,
  hookFilePath?: string,
): Promise<AgentCallResult> {
  const handle = callAgentStream(adapter, prompt, hookFilePath);
  return handle.promise;
}
