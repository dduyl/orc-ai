import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmSync, existsSync, appendFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { HookEvent } from "../../core/hooks.js";
import { log } from "../../core/log.js";

export function createHookFile(stepId: string): string {
  const dir = mkdtempSync(join(tmpdir(), `orc-hook-${stepId}-`));
  const filePath = join(dir, "events.jsonl");
  writeFileSync(filePath, "", "utf-8");
  log.debug(`[Hooks] Created hook file: ${filePath}`);
  return filePath;
}

/** Append a single hook event (JSONL) to an existing hook file. */
export function appendHookEvent(filePath: string, event: HookEvent): void {
  try {
    appendFileSync(filePath, JSON.stringify(event) + "\n", "utf-8");
  } catch (err: any) {
    log.warn(`[Hooks] Failed to append hook event: ${err.message}`);
  }
}

/**
 * Recover the stepId a hook file was created for, from its path
 * (`<tmp>/orc-hook-<stepId>-<random>/events.jsonl`). Returns "unknown" when
 * the path doesn't match the format `createHookFile` produces.
 */
export function stepIdFromHookFile(filePath: string): string {
  const dir = basename(dirname(filePath));
  const PREFIX = "orc-hook-";
  if (!dir.startsWith(PREFIX)) return "unknown";
  // mkdtempSync replaces the trailing "XXXXXX" (6 chars) with randomness, so
  // stripping the trailing `-<6 chars>` yields exactly the stepId.
  const rest = dir.slice(PREFIX.length);
  return rest.length > 7 ? rest.slice(0, rest.length - 7) : "unknown";
}

export function readHookEvents(filePath: string): HookEvent[] {
  if (!existsSync(filePath)) {
    log.warn(`[Hooks] Hook file not found: ${filePath}`);
    return [];
  }
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").map(l => l.trim()).filter(Boolean);
  const events: HookEvent[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (isValidHookEvent(parsed)) {
        events.push(parsed);
      } else {
        log.warn(`[Hooks] Invalid event skipped: ${line.slice(0, 200)}`);
      }
    } catch {
      log.warn(`[Hooks] Unparseable line skipped: ${line.slice(0, 200)}`);
    }
  }
  return events;
}

export function removeHookFile(filePath: string): void {
  try {
    const dir = filePath.replace(/events\.jsonl$/, "");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
    log.debug(`[Hooks] Removed hook file: ${filePath}`);
  } catch (err: any) {
    log.warn(`[Hooks] Failed to remove hook file: ${err.message}`);
  }
}

function isValidHookEvent(obj: unknown): obj is HookEvent {
  if (!obj || typeof obj !== "object") return false;
  const e = obj as Record<string, unknown>;
  if (typeof e.type !== "string") return false;
  if (typeof e.timestamp !== "number") return false;
  if (typeof e.stepId !== "string") return false;
  if (!["tool_call", "tool_result", "step_finish"].includes(e.type)) return false;
  if (e.type === "tool_call" && typeof e.tool !== "string") return false;
  if (e.type === "tool_result" && typeof e.tool !== "string") return false;
  return true;
}
