import * as blessed from "blessed";

export interface TreeNodeData {
  id: string;
  label: string;
  parentId: string | null;
  status: "pending" | "running" | "completed" | "failed";
  output: string;
}

const STATUS_ICON: Record<string, string> = {
  pending: " ",
  running: "…",
  completed: "✓",
  failed: "✗",
};

export class TreePanel {
  private list: blessed.Widgets.ListElement;
  private nodes: Map<string, TreeNodeData> = new Map();
  private rootId: string;
  private itemIds: string[] = [];

  constructor(screen: blessed.Widgets.Screen, label: string, rootId: string) {
    this.rootId = rootId;
    this.nodes.set(rootId, { id: rootId, label, parentId: null, status: "running", output: "" });
    this.rebuildItemIds();

    this.list = blessed.list({
      parent: screen,
      top: 0,
      left: 0,
      width: "30%",
      height: "100%-1",
      label: ` ${label} `,
      border: { type: "line" },
      style: {
        fg: "white",
        border: { fg: "blue" },
        selected: { fg: "white", bg: "blue" },
      },
      items: this.itemIds.map((id) => this.formatNode(this.nodes.get(id)!)),
    });
  }

  private formatNode(n: TreeNodeData): string {
    const icon = STATUS_ICON[n.status] || " ";
    const prefix = n.parentId === null ? "●" : "  ○";
    return ` ${prefix} ${icon} ${n.label}`;
  }

  private rebuildItemIds(): void {
    this.itemIds = [];
    const root = this.nodes.get(this.rootId);
    if (root) {
      this.itemIds.push(this.rootId);
      for (const n of this.nodes.values()) {
        if (n.parentId === this.rootId) {
          this.itemIds.push(n.id);
        }
      }
    }
  }

  getSelectedId(): string | undefined {
    if (this.itemIds.length === 0) return undefined;
    const idx = (this.list as any).selected;
    if (typeof idx !== "number" || idx < 0 || idx >= this.itemIds.length) return undefined;
    return this.itemIds[idx] ?? undefined;
  }

  isRootSelected(): boolean {
    return this.getSelectedId() === this.rootId;
  }

  addNode(parentId: string, id: string, label: string): void {
    this.nodes.set(id, { id, label, parentId, status: "pending", output: "" });
    this.rebuildItemIds();
    const formattedItems = this.itemIds.map((i) => this.formatNode(this.nodes.get(i)!));
    this.list.setItems(formattedItems);
    this.list.screen.render();
  }

  updateStatus(id: string, status: TreeNodeData["status"]): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.status = status;
    const formattedItems = this.itemIds.map((i) => this.formatNode(this.nodes.get(i)!));
    this.list.setItems(formattedItems);
    this.list.screen.render();
  }

  updateOutput(id: string, text: string): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.output = text;
  }

  getOutput(id: string): string {
    return this.nodes.get(id)?.output || "";
  }

  getRootId(): string {
    return this.rootId;
  }

  getElement(): blessed.Widgets.ListElement {
    return this.list;
  }

  selectFirst(): void {
    this.list.select(0);
  }

  destroy(): void {
    this.list.detach();
  }
}
