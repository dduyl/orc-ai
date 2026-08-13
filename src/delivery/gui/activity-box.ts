import type { ToolCallContent, ToolCallLocation } from "@agentclientprotocol/sdk";
import { MAX_RENDER_BLOCK_CHARS, sanitizeTerminalText } from "../../application/agents/acp/render.js";
import type { PermissionAnswerKind } from "../../application/agents/acp/types.js";
import type { PermissionRequest } from "./ipc.js";

/** Structural subset of the ACP tool-call envelope the activity box consumes. */
export interface ToolCallView {
  toolCallId: string;
  title?: string | null;
  name?: string | null;
}

export interface ToolCallUpdateView extends ToolCallView {
  kind?: string | null;
  status?: string | null;
  content?: Array<ToolCallContent> | null;
  locations?: Array<ToolCallLocation> | null;
  rawOutput?: unknown;
}

export interface ActivityBoxRefs {
  box: HTMLElement;
  permissionSection: HTMLElement;
  permissionText: HTMLElement;
  permissionHint: HTMLElement;
  permissionActions: HTMLElement;
  permissionNav: HTMLElement;
  permissionPrev: HTMLButtonElement;
  permissionNext: HTMLButtonElement;
  permissionCounter: HTMLElement;
  toolsSection: HTMLElement;
  toolList: HTMLElement;
  onAnswer: (requestId: string, kind: PermissionAnswerKind) => void;
}

interface ToolRecord {
  data: ToolCallUpdateView;
  el: HTMLElement;
  expanded: boolean;
}

/**
 * Floating non-blocking activity box for the ACP main session.
 *
 * Two stacked sections, shown only while they hold content:
 *
 * - **Permissions** — queued `request_permission` prompts. One is displayed at a
 *   time; when several are pending (parallel tool calls) a prev/next control
 *   navigates the queue. Answer buttons resolve the *displayed* request via its
 *   `requestId`, so a decision always lands on exactly what the user saw.
 * - **Tools** — tool calls render as clickable rows; clicking a row expands the
 *   call's result (content blocks, diffs, locations, raw output).
 *
 * The box is fixed-position and semi-transparent; it never blocks the chat.
 */
export class ActivityBox {
  private readonly queue: PermissionRequest[] = [];
  private cursor = 0;
  private readonly tools = new Map<string, ToolRecord>();

  constructor(private readonly refs: ActivityBoxRefs) {
    refs.permissionPrev.addEventListener("click", () => this.nav(-1));
    refs.permissionNext.addEventListener("click", () => this.nav(1));
  }

  hasPending(): boolean {
    return this.queue.length > 0;
  }

  clear(): void {
    this.queue.length = 0;
    this.cursor = 0;
    this.tools.clear();
    this.refs.toolList.innerHTML = "";
    this.refs.toolsSection.hidden = true;
    this.renderPermission();
    this.syncVisibility();
  }

  addPermission(request: PermissionRequest): void {
    this.queue.push(request);
    this.renderPermission();
    this.syncVisibility();
  }

  addTool(call: ToolCallView): void {
    const rec = this.ensureTool(call.toolCallId);
    mergeTool(rec.data, call);
    this.renderToolHead(rec);
    this.syncVisibility();
  }

  addToolUpdate(update: ToolCallUpdateView): void {
    const rec = this.ensureTool(update.toolCallId);
    mergeTool(rec.data, update);
    this.renderToolHead(rec);
    if (rec.expanded) renderToolResult(rec);
    this.syncVisibility();
  }

  // ── permissions ────────────────────────────────────────────

  private nav(delta: number): void {
    if (this.queue.length <= 1) return;
    this.cursor = Math.min(this.queue.length - 1, Math.max(0, this.cursor + delta));
    this.renderPermission();
  }

  private renderPermission(): void {
    const request = this.queue[this.cursor];
    if (!request) {
      this.refs.permissionSection.hidden = true;
      this.syncVisibility();
      return;
    }
    this.refs.permissionSection.hidden = false;
    const title = request.toolCall.title ?? request.toolCall.name ?? "tool";
    this.refs.permissionText.textContent = `Allow “${title}” to run?`;
    this.refs.permissionActions.innerHTML = "";
    const seen = new Set<string>();
    for (const opt of request.options) {
      if (seen.has(opt.kind)) continue;
      seen.add(opt.kind);
      const btn = document.createElement("button");
      btn.className = "btn " + (opt.kind.startsWith("allow") ? "btn-allow" : "btn-reject");
      btn.textContent = opt.name;
      btn.addEventListener("click", () => this.answer(request.requestId, opt.kind));
      this.refs.permissionActions.appendChild(btn);
    }
    if (!seen.has("reject_once") && !seen.has("reject_always")) {
      const btn = document.createElement("button");
      btn.className = "btn btn-reject";
      btn.textContent = "Reject";
      btn.addEventListener("click", () => this.answer(request.requestId, "reject_once"));
      this.refs.permissionActions.appendChild(btn);
    }
    const multi = this.queue.length > 1;
    this.refs.permissionNav.hidden = !multi;
    this.refs.permissionCounter.textContent = `${this.cursor + 1}/${this.queue.length}`;
    this.syncVisibility();
  }

  private answer(requestId: string, kind: PermissionAnswerKind): void {
    const idx = this.queue.findIndex(r => r.requestId === requestId);
    if (idx >= 0) this.queue.splice(idx, 1);
    this.cursor = Math.min(this.cursor, Math.max(0, this.queue.length - 1));
    this.refs.onAnswer(requestId, kind);
    this.renderPermission();
    this.syncVisibility();
  }

  // ── tools ──────────────────────────────────────────────────

  private ensureTool(toolCallId: string): ToolRecord {
    const existing = this.tools.get(toolCallId);
    if (existing) return existing;
    const el = document.createElement("div");
    el.className = "tool-entry";
    el.innerHTML =
      `<div class="tool-head">` +
      `<span class="tool-kind">tool</span>` +
      `<span class="tool-title">…</span>` +
      `<span class="tool-status" data-status="pending">···</span>` +
      `<span class="tool-caret">▾</span>` +
      `</div>` +
      `<div class="tool-result"></div>`;
    const head = el.querySelector(".tool-head") as HTMLElement;
    head.addEventListener("click", () => this.toggleTool(toolCallId));
    this.refs.toolList.appendChild(el);
    const rec: ToolRecord = { data: { toolCallId }, el, expanded: false };
    this.tools.set(toolCallId, rec);
    this.refs.toolsSection.hidden = false;
    return rec;
  }

  private toggleTool(toolCallId: string): void {
    const rec = this.tools.get(toolCallId);
    if (!rec) return;
    rec.expanded = !rec.expanded;
    rec.el.classList.toggle("expanded", rec.expanded);
    const caret = rec.el.querySelector(".tool-caret");
    if (caret) caret.textContent = rec.expanded ? "▴" : "▾";
    if (rec.expanded) renderToolResult(rec);
    this.syncVisibility();
  }

  private renderToolHead(rec: ToolRecord): void {
    const { el, data } = rec;
    const titleEl = el.querySelector(".tool-title") as HTMLElement | null;
    const kindEl = el.querySelector(".tool-kind") as HTMLElement | null;
    const statusEl = el.querySelector(".tool-status") as HTMLElement | null;
    if (titleEl) titleEl.textContent = data.title ?? data.name ?? "tool";
    if (kindEl) kindEl.textContent = data.kind ?? "tool";
    if (statusEl) {
      statusEl.textContent = statusLabel(data.status ?? null);
      statusEl.dataset.status = data.status ?? "pending";
    }
    el.classList.toggle("done", data.status === "completed");
    el.classList.toggle("failed", data.status === "failed");
  }

  private syncVisibility(): void {
    this.refs.toolsSection.hidden = this.tools.size === 0;
    this.refs.box.hidden = this.refs.permissionSection.hidden && this.refs.toolsSection.hidden;
  }
}

/** Merge a partial update into the running record (null = "unchanged"). */
function mergeTool(target: ToolCallUpdateView, update: ToolCallUpdateView): void {
  if (update.title != null) target.title = update.title;
  if (update.name != null) target.name = update.name;
  if (update.kind != null) target.kind = update.kind;
  if (update.status != null) target.status = update.status;
  if (update.content != null) target.content = update.content;
  if (update.locations != null) target.locations = update.locations;
  if (update.rawOutput !== undefined) target.rawOutput = update.rawOutput;
}

function renderToolResult(rec: ToolRecord): void {
  const resultEl = rec.el.querySelector(".tool-result") as HTMLElement | null;
  if (!resultEl) return;
  resultEl.textContent = formatToolResult(rec.data);
}

/** Compact mono result body for an expanded tool row. */
function formatToolResult(tool: ToolCallUpdateView): string {
  const lines: string[] = [];
  if (tool.locations != null) {
    const seen = new Set<string>();
    for (const loc of tool.locations) {
      if (!loc || typeof loc !== "object") continue;
      const path = sanitizeTerminalText(loc.path ?? "");
      if (!path) continue;
      const key = loc.line != null ? `${path}:${loc.line}` : path;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`at ${key}`);
    }
  }
  for (const block of tool.content ?? []) {
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "content": {
        const c = block.content;
        if (!c || typeof c !== "object") break;
        switch (c.type) {
          case "text":
            pushText(lines, c.text ?? "");
            break;
          case "image":
            lines.push(`[image: ${sanitizeTerminalText(c.mimeType ?? "image")}]`);
            break;
          case "audio":
            lines.push(`[audio: ${sanitizeTerminalText(c.mimeType ?? "audio")}]`);
            break;
          case "resource_link":
            lines.push(
              `[resource: ${sanitizeTerminalText(c.name ?? "")}: ${sanitizeTerminalText(c.uri ?? "")}]`,
            );
            break;
          case "resource": {
            const r = c.resource as { text?: unknown; uri?: unknown; mimeType?: unknown } | null;
            if (r && typeof r.text === "string") pushText(lines, r.text);
            else if (r) lines.push(`[resource: ${sanitizeTerminalText(typeof r.uri === "string" ? r.uri : "")}]`);
            break;
          }
        }
        break;
      }
      case "diff": {
        const path = sanitizeTerminalText(block.path ?? "?");
        const oldText = block.oldText != null ? sanitizeTerminalText(block.oldText) : undefined;
        const newText = sanitizeTerminalText(block.newText ?? "");
        const summary =
          oldText !== undefined ? ` (${oldText.split("\n").length} → ${newText.split("\n").length} lines)` : "";
        lines.push(`diff: ${path}${summary}`);
        pushText(lines, newText);
        break;
      }
      case "terminal":
        lines.push(`[terminal: ${sanitizeTerminalText(block.terminalId ?? "?")}]`);
        break;
    }
  }
  if (tool.rawOutput !== undefined) {
    let out: string;
    try {
      out = typeof tool.rawOutput === "string" ? tool.rawOutput : JSON.stringify(tool.rawOutput, null, 2);
    } catch {
      out = String(tool.rawOutput);
    }
    pushText(lines, out);
  }
  if (lines.length === 0) return "· no result content";
  return lines.join("\n");
}

function pushText(lines: string[], text: string): void {
  const t = sanitizeTerminalText(text);
  if (t.length > MAX_RENDER_BLOCK_CHARS) {
    lines.push(t.slice(0, MAX_RENDER_BLOCK_CHARS) + "\n… (truncated)");
  } else {
    lines.push(t);
  }
}

function statusLabel(status: string | null | undefined): string {
  switch (status) {
    case "in_progress": return "running…";
    case "completed": return "done";
    case "failed": return "failed";
    default: return "···";
  }
}
