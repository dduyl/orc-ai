import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import { log } from "../../../core/log.js";
import type { AcpSpawnSpec } from "./types.js";

const WINDOWS_EXTS = ["", ".exe", ".cmd", ".bat"];

/**
 * Resolve a command name to an absolute path by scanning PATH.
 *
 * Windows resolves `.exe`/`.cmd`/`.bat` so npm-global shims (`opencode.cmd`)
 * and native binaries both work. Returns `undefined` when not found.
 */
export function findInPath(name: string): string | undefined {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of process.platform === "win32" ? WINDOWS_EXTS : ["", ".exe"]) {
      const candidate = join(dir, `${name}${ext}`);
      try {
        if (existsSync(candidate)) {
          return candidate;
        }
      } catch {
        // Unreadable/over-long path segment — skip it.
      }
    }
  }
  return undefined;
}

/** True if the resolved path is a shell shim that needs `cmd.exe /d /s /c`. */
export function needsShellWrapper(resolved: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved);
}

/**
 * Wrap a spawn spec in `cmd.exe /d /s /c` when the resolved entrypoint is a
 * `.cmd`/`.bat` shim (npm-global installs). Passthrough otherwise.
 */
export function shellWrapIfNeeded(command: string, args: string[]): AcpSpawnSpec {
  if (!needsShellWrapper(command)) return { command, args };
  const parts = [command, ...args].map(a => {
    // cmd quoting: double quotes escape; wrap any argument containing spaces.
    return /\s/.test(a) && !a.startsWith("\"") ? `"${a}"` : a;
  });
  return { command: "cmd.exe", args: ["/d", "/s", "/c", parts.join(" ")] };
}

/**
 * Probe the entrypoint without ever launching a live agent. Used to decide
 * whether an adapter id should route through ACP or stay on the PTY path.
 */
export function probeBinary(name: string, logHint: string): boolean {
  const resolved = findInPath(name);
  if (resolved) {
    log.debug(`acp: ${logHint} resolved '${name}' -> ${resolved}`);
    return true;
  }
  return false;
}