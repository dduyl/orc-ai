/**
 * Popover suggestion list for the chat composer (`@` file mentions + `/`
 * slash-command picker, ADR-026 Phase 5). Pure DOM: render rows, cycle the
 * active row, pick on Enter/Tab/click. The token query logic lives in the
 * renderer; file entries come from the preload's local workspace fs walk and
 * commands come from the daemon's `commands` frames (`available_commands_update`).
 */

export interface SuggestionItem {
  /** Value spliced into the composer on pick (`@path` / `@dir/` / `/name`), or
   *  a sentinel (`\u0000group:<id>` / `\u0000back`) the renderer handles as a
   *  picker-navigation action instead of a splice. */
  value: string;
  name: string;
  kind: "file" | "dir" | "command" | "group" | "back";
  /** Optional hint row text (e.g. a command's description). */
  description?: string;
  /** Chip-label override (e.g. the command's `cmd`/`skill`/`other` group). */
  meta?: string;
}

/** A pick returns the value to splice into the input. */
export type MentionPicked = (value: string) => void;

export class MentionBox {
  private activeIndex = 0;
  private items: SuggestionItem[] = [];
  private emptyHint: string | null = null;
  private readonly root: HTMLElement;
  private readonly onPick: MentionPicked;

  constructor(root: HTMLElement, onPick: MentionPicked) {
    this.root = root;
    this.onPick = onPick;
  }

  get visible(): boolean {
    return this.root.classList.contains("visible");
  }

  /** True when rows can be picked (an empty-state hint is visible but inert). */
  get interactive(): boolean {
    return this.items.length > 0;
  }

  get count(): number {
    return this.items.length;
  }

  show(items: SuggestionItem[]): void {
    this.emptyHint = null;
    this.items = items;
    this.activeIndex = 0;
    if (items.length === 0) {
      this.hide();
      return;
    }
    this.render();
    this.root.classList.add("visible");
  }

  /** Show a non-interactive hint row (e.g. "No commands available"). */
  showEmpty(text: string): void {
    this.items = [];
    this.activeIndex = 0;
    this.emptyHint = text;
    this.render();
    this.root.classList.add("visible");
  }

  hide(): void {
    this.items = [];
    this.emptyHint = null;
    this.root.classList.remove("visible");
    this.root.replaceChildren();
  }

  /** Move the active row; wraps around. Returns the new index or -1 when empty. */
  move(delta: 1 | -1): number {
    if (this.items.length === 0) return -1;
    this.activeIndex = (this.activeIndex + delta + this.items.length) % this.items.length;
    this.render();
    return this.activeIndex;
  }

  /** Pick the active row, or -1 when nothing is active. */
  pick(): number {
    const item = this.items[this.activeIndex];
    if (!item) return -1;
    const index = this.activeIndex;
    this.hide();
    this.onPick(item.value);
    return index;
  }

  private render(): void {
    this.root.replaceChildren();
    if (this.items.length === 0 && this.emptyHint) {
      const hint = document.createElement("div");
      hint.className = "sugg empty";
      hint.textContent = this.emptyHint;
      this.root.appendChild(hint);
      return;
    }
    this.items.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "sugg";
      if (index === this.activeIndex) row.classList.add("active");
      if (item.kind === "back") row.classList.add("back");

      const name = document.createElement("span");
      name.className = "sugg-name";
      name.textContent = item.name;
      row.appendChild(name);

      if (item.description) {
        const desc = document.createElement("span");
        desc.className = "sugg-desc";
        desc.textContent = item.description;
        row.appendChild(desc);
      }

      const kind = document.createElement("span");
      kind.className = "sugg-kind";
      kind.textContent = item.meta ?? (item.kind === "command" ? "cmd" : item.kind);
      row.appendChild(kind);

      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.activeIndex = index;
        this.pick();
      });
      this.root.appendChild(row);
    });
  }
}
