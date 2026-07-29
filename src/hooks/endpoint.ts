import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HookEvent } from "./types.js";
import { log } from "../log.js";

export function createHookFile(stepId: string): string {
  const dir = mkdtempSync(join(tmpdir(), `orc-hook-${stepId}-`));
  const filePath = join(dir, "events.jsonl");
  writeFileSync(filePath, "", "utf-8");
  log.debug(`[Hooks] Created hook file: ${filePath}`);
  return filePath;
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
