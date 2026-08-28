import type { ToolCall, ToolCallUpdate, ToolCallContent, ToolCallLocation } from "@agentclientprotocol/sdk";
import { MAX_RENDER_BLOCK_CHARS, sanitizeTerminalText } from "../../application/agents/acp/render.js";
import type { AgentUsage, AcpStopReason, PermissionAnswerKind } from "../../application/agents/acp/types.js";

/**
 * DOM chat panel for the ACP session.
 *
 * Handles all frame types: user prompts, agent text, tool calls (inline),
 * permission prompts (inline), usage, turn dividers, and errors.
 */
export class ChatView {
  /** Pixels above the bottom below which auto-scroll stays engaged. */
  static readonly SCROLL_THRESHOLD = 80;

  private openText: { msg: HTMLElement; body: HTMLElement } | null = null;
  private turnSeq = 0;
  private list: HTMLElement;
  private scrollEl: HTMLElement;
  private tools = new Map<string, ToolRecord>();
  private permissionHandler?: (requestId: string, kind: PermissionAnswerKind) => void;

  constructor(list: HTMLElement, scrollEl?: HTMLElement) {
    this.list = list;
    this.scrollEl = scrollEl ?? list.parentElement as HTMLElement;
    this.clear();
  }

  setPermissionHandler(handler: (requestId: string, kind: PermissionAnswerKind) => void): void {
    this.permissionHandler = handler;
  }

  clear(): void {
    this.list.innerHTML = "";
    this.openText = null;
    this.turnSeq = 0;
    this.tools.clear();
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.innerHTML =
      '<div>Waiting for a message…</div>' +
      '<div class="kbd">Chat runs over ACP · Synced with the ORC daemon</div>';
    this.list.appendChild(empty);
  }

  addUser(text: string): void {
    this.closeText();
    const el = document.createElement("div");
    el.className = "msg msg-user";
    el.textContent = text;
    this.append(el);
  }

  addText(text: string): void {
    this.ensureEmptyRemoved();
    if (!this.openText) {
      const msg = document.createElement("div");
      msg.className = "msg msg-agent streaming";
      const caret = document.createElement("div");
      caret.className = "agent-caret streaming";
      const pip = document.createElement("span");
      pip.className = "pip";
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = `agent · turn ${this.turnSeq + 1}`;
      caret.append(pip, who);
      const body = document.createElement("div");
      body.className = "msg-body";
      msg.append(caret, body);
      this.openText = { msg, body };
      this.list.appendChild(msg);
    }
    this.openText.body.textContent += text;
    this.scrollBottom();
  }

  addTextChunk(chunk: string): void {
    this.ensureEmptyRemoved();
    if (!this.openText) {
      const msg = document.createElement("div");
      msg.className = "msg msg-agent streaming";
      const caret = document.createElement("div");
      caret.className = "agent-caret streaming";
      const pip = document.createElement("span");
      pip.className = "pip";
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = `agent · turn ${this.turnSeq + 1}`;
      caret.append(pip, who);
      const body = document.createElement("div");
      body.className = "msg-body";
      msg.append(caret, body);
      this.openText = { msg, body };
      this.list.appendChild(msg);
    }
    this.openText.body.textContent += chunk;
    this.scrollBottom();
  }

  addToolCall(call: ToolCall): void {
    this.closeText();
    const rec = this.ensureTool(call.toolCallId ?? `tool-${this.tools.size}`);
    if (call.name) rec.data.name = call.name;
    if ((call as { title?: string }).title) rec.data.title = (call as { title?: string }).title;
    if ((call as { kind?: string }).kind) rec.data.kind = (call as { kind?: string }).kind;
    if (call.rawInput !== undefined) {
      rec.data.rawInput = typeof call.rawInput === "string"
        ? call.rawInput
        : JSON.stringify(call.rawInput ?? {});
    }
    this.renderToolHead(rec);
    this.scrollBottom();
  }

  addToolUpdate(update: ToolCallUpdate): void {
    if (!update.toolCallId) return;
    const rec = this.ensureTool(update.toolCallId);
    if (update.status) rec.data.status = update.status;
    if (update.content) rec.data.content = update.content;
    if (update.locations) rec.data.locations = update.locations;
    if (update.rawOutput !== undefined) rec.data.rawOutput = update.rawOutput;
    this.renderToolHead(rec);
    if (rec.expanded) renderToolResult(rec);
    this.scrollBottom();
  }

  addPermission(request: { requestId: string; toolCall: { title?: string | null; name?: string | null; kind?: string | null }; options: Array<{ optionId: string; kind: string; name: string }> }): void {
    this.closeText();
    this.ensureEmptyRemoved();
    const card = document.createElement("div");
    card.className = "permission-card";
    card.dataset.requestId = request.requestId;

    const title = request.toolCall.title ?? request.toolCall.name ?? "tool";
    const header = document.createElement("div");
    header.className = "permission-header";
    const icon = document.createElement("span");
    icon.className = "permission-icon";
    icon.textContent = "🔒";
    const text = document.createElement("span");
    text.className = "permission-text";
    text.textContent = `Allow "${title}" to run?`;
    header.append(icon, text);
    card.appendChild(header);

    const actions = document.createElement("div");
    actions.className = "permission-actions";
    const seen = new Set<string>();
    for (const opt of request.options) {
      if (seen.has(opt.kind)) continue;
      seen.add(opt.kind);
      const btn = document.createElement("button");
      btn.className = "btn " + (opt.kind.startsWith("allow") ? "btn-allow" : "btn-reject");
      btn.textContent = opt.name;
      btn.addEventListener("click", () => {
        this.permissionHandler?.(request.requestId, opt.kind as PermissionAnswerKind);
        card.remove();
      });
      actions.appendChild(btn);
    }
    if (!seen.has("reject_once") && !seen.has("reject_always")) {
      const btn = document.createElement("button");
      btn.className = "btn btn-reject";
      btn.textContent = "Reject";
      btn.addEventListener("click", () => {
        this.permissionHandler?.(request.requestId, "reject_once");
        card.remove();
      });
      actions.appendChild(btn);
    }
    card.appendChild(actions);
    this.append(card);
  }

  addUsage(usage: AgentUsage): void {
    this.closeText();
    const el = document.createElement("div");
    el.className = "msg-usage";
    el.textContent = `tokens ${usage.totalTokens} · in ${usage.inputTokens} · out ${usage.outputTokens}`;
    this.append(el);
  }

  addTurn(stopReason: AcpStopReason | string): void {
    this.closeText();
    this.turnSeq += 1;
    const el = document.createElement("div");
    el.className = "turn-end";
    const left = document.createElement("span");
    left.textContent = "end turn";
    const label = document.createElement("b");
    label.textContent = turnLabel(stopReason);
    const right = document.createElement("span");
    el.append(left, label, right);
    this.append(el);
  }

  addError(message: string): void {
    this.closeText();
    const el = document.createElement("div");
    el.className = "msg msg-error";
    el.textContent = `error · ${message}`;
    this.append(el);
  }

  addErrorFrame(frame: { error?: string; errorKind?: string; resetAtMs?: number; retryAfterMs?: number; providerCode?: string }): void {
    this.closeText();
    const el = document.createElement("div");
    el.className = "msg msg-error";
    const kind = frame.errorKind ?? "unknown";
    const msg = frame.error ?? "Unknown error";
    const header = document.createElement("div");
    header.className = "error-header";
    const badge = document.createElement("span");
    badge.className = "error-kind";
    badge.textContent = kind.toUpperCase();
    header.appendChild(badge);
    const text = document.createElement("span");
    text.textContent = msg;
    header.appendChild(text);
    el.appendChild(header);
    if (kind === "quota" && frame.resetAtMs) {
      const resetSec = Math.max(0, Math.round((frame.resetAtMs - Date.now()) / 1000));
      const detail = document.createElement("div");
      detail.className = "error-detail";
      detail.textContent = `Resets in ${resetSec}s`;
      el.appendChild(detail);
    } else if (kind === "rate_limit" && frame.retryAfterMs) {
      const detail = document.createElement("div");
      detail.className = "error-detail";
      detail.textContent = `Retry after ${Math.round(frame.retryAfterMs / 1000)}s`;
      el.appendChild(detail);
    }
    if (frame.providerCode) {
      const detail = document.createElement("div");
      detail.className = "error-detail";
      detail.textContent = `Provider code: ${frame.providerCode}`;
      el.appendChild(detail);
    }
    this.append(el);
  }

  scrollBottom(): void {
    const scroll = this.scrollEl;
    if (!scroll) return;
    const nearBottom =
      scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < ChatView.SCROLL_THRESHOLD;
    if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private closeText(): void {
    if (!this.openText) return;
    this.openText.msg.classList.remove("streaming");
    const caret = this.openText.msg.querySelector(".agent-caret");
    caret?.classList.remove("streaming");
    this.openText = null;
  }

  private ensureEmptyRemoved(): void {
    const empty = this.list.querySelector(".chat-empty");
    if (empty) empty.remove();
  }

  private append(el: HTMLElement): void {
    this.ensureEmptyRemoved();
    this.list.appendChild(el);
    this.scrollBottom();
  }

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
    this.list.appendChild(el);
    const rec: ToolRecord = { data: { toolCallId }, el, expanded: false };
    this.tools.set(toolCallId, rec);
    this.scrollBottom();
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
}

// ── Tool record + rendering helpers ──────────────────────────────────────

interface ToolRecord {
  data: {
    toolCallId: string;
    title?: string;
    name?: string;
    kind?: string;
    status?: string;
    content?: Array<ToolCallContent>;
    locations?: Array<ToolCallLocation>;
    rawOutput?: unknown;
    rawInput?: string;
  };
  el: HTMLElement;
  expanded: boolean;
}

function renderToolResult(rec: ToolRecord): void {
  const resultEl = rec.el.querySelector(".tool-result") as HTMLElement | null;
  if (!resultEl) return;
  resultEl.textContent = formatToolResult(rec.data);
}

function formatToolResult(tool: ToolRecord["data"]): string {
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

function turnLabel(reason: AcpStopReason | string): string {
  switch (reason) {
    case "end_turn": return "complete";
    case "cancelled": return "cancelled";
    case "refusal": return "refused";
    case "max_tokens": return "max tokens";
    case "max_turn_requests": return "request limit";
    case "error": return "error";
    default: return reason;
  }
}
