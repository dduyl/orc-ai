import dagre from "dagre";
import type { WorkflowGraphData, GraphNode, GraphEdge } from "../../core/workflow-graph.js";

export interface GraphCanvasCallbacks {
  onNodeClick: (stepId: string) => void;
}

export class GraphCanvas {
  private svg: SVGSVGElement | null = null;
  private container: HTMLElement | null = null;
  private graphData: WorkflowGraphData | null = null;
  private callbacks: GraphCanvasCallbacks;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private isPanning = false;
  private lastMouseX = 0;
  private lastMouseY = 0;
  private nodeElements = new Map<string, SVGGElement>();

  constructor(callbacks: GraphCanvasCallbacks) {
    this.callbacks = callbacks;
  }

  mount(container: HTMLElement): void {
    this.container = container;
    container.innerHTML = "";
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.setAttribute("width", "100%");
    this.svg.setAttribute("height", "100%");
    this.svg.style.cursor = "grab";
    this.svg.addEventListener("wheel", this.onWheel.bind(this), { passive: false });
    this.svg.addEventListener("mousedown", this.onMouseDown.bind(this));
    window.addEventListener("mousemove", this.onMouseMove.bind(this));
    window.addEventListener("mouseup", this.onMouseUp.bind(this));
    this.svg.addEventListener("dblclick", this.onDoubleClick.bind(this));
    container.appendChild(this.svg);
  }

  unmount(): void {
    if (this.container) {
      this.container.innerHTML = "";
    }
    this.svg = null;
    this.container = null;
    this.graphData = null;
    this.nodeElements.clear();
  }

  render(graphData: WorkflowGraphData): void {
    this.graphData = graphData;
    if (!this.svg) return;

    const { nodes, edges } = graphData;

    const g = new dagre.graphlib.Graph({ multigraph: true, compound: true });
    g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 80, edgesep: 20 });
    g.setDefaultEdgeLabel(() => ({}));

    for (const node of nodes) {
      g.setNode(node.id, { width: 140, height: 56, label: node.id });
    }

    for (const edge of edges) {
      g.setEdge(edge.from, edge.to, { label: edge.signal });
    }

    dagre.layout(g);

    this.svg.innerHTML = "";

    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.innerHTML = `
      <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
        <polygon points="0 0, 10 3.5, 0 7" fill="var(--border-strong)" />
      </marker>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
        <feMerge>
          <feMergeNode in="coloredBlur"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    `;
    this.svg.appendChild(defs);

    const viewport = document.createElementNS("http://www.w3.org/2000/svg", "g");
    viewport.setAttribute("class", "viewport");
    this.svg.appendChild(viewport);

    this.nodeElements.clear();

    for (const node of nodes) {
      const layoutNode = g.node(node.id);
      if (!layoutNode) continue;

      const gEl = document.createElementNS("http://www.w3.org/2000/svg", "g");
      gEl.setAttribute("class", `node ${node.status} ${node.isGate ? "gate" : ""}`);
      gEl.setAttribute("data-step-id", node.id);
      gEl.style.cursor = "pointer";
      gEl.addEventListener("click", () => this.callbacks.onNodeClick(node.id));

      const x = layoutNode.x - layoutNode.width / 2;
      const y = layoutNode.y - layoutNode.height / 2;

      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", String(x));
      rect.setAttribute("y", String(y));
      rect.setAttribute("width", String(layoutNode.width));
      rect.setAttribute("height", String(layoutNode.height));
      rect.setAttribute("rx", "6");
      rect.setAttribute("ry", "6");
      rect.setAttribute("class", "node-rect");
      if (node.status === "running") {
        rect.setAttribute("filter", "url(#glow)");
      }
      gEl.appendChild(rect);

      if (node.isGate) {
        const gateIndicator = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        gateIndicator.setAttribute("x", String(x + layoutNode.width - 16));
        gateIndicator.setAttribute("y", String(y + 4));
        gateIndicator.setAttribute("width", "12");
        gateIndicator.setAttribute("height", "12");
        gateIndicator.setAttribute("rx", "2");
        gateIndicator.setAttribute("class", `gate-indicator ${node.status}`);
        gEl.appendChild(gateIndicator);
      }

      if (node.loopCount && node.loopCount > 1) {
        const loopBadge = document.createElementNS("http://www.w3.org/2000/svg", "g");
        const badgeBg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        badgeBg.setAttribute("x", String(x - 14));
        badgeBg.setAttribute("y", String(y - 14));
        badgeBg.setAttribute("width", "24");
        badgeBg.setAttribute("height", "24");
        badgeBg.setAttribute("rx", "12");
        badgeBg.setAttribute("fill", "var(--accent)");
        const badgeText = document.createElementNS("http://www.w3.org/2000/svg", "text");
        badgeText.setAttribute("x", String(x - 2));
        badgeText.setAttribute("y", String(y + 1));
        badgeText.setAttribute("text-anchor", "middle");
        badgeText.setAttribute("font-size", "11");
        badgeText.setAttribute("font-weight", "700");
        badgeText.setAttribute("fill", "var(--bg-base)");
        badgeText.setAttribute("font-family", "var(--font-mono)");
        badgeText.textContent = `⟳${node.loopCount}`;
        loopBadge.appendChild(badgeBg);
        loopBadge.appendChild(badgeText);
        gEl.appendChild(loopBadge);
      }

      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", String(layoutNode.x));
      label.setAttribute("y", String(layoutNode.y + 5));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("class", "node-label");
      label.setAttribute("font-family", "var(--font-mono)");
      label.setAttribute("font-size", "11");
      label.setAttribute("font-weight", "600");
      label.textContent = node.id;
      gEl.appendChild(label);

      const emitsText = document.createElementNS("http://www.w3.org/2000/svg", "text");
      emitsText.setAttribute("x", String(layoutNode.x));
      emitsText.setAttribute("y", String(layoutNode.y + 22));
      emitsText.setAttribute("text-anchor", "middle");
      emitsText.setAttribute("class", "node-emits");
      emitsText.setAttribute("font-family", "var(--font-mono)");
      emitsText.setAttribute("font-size", "9");
      emitsText.setAttribute("fill", "var(--text-faint)");
      emitsText.textContent = node.emits.join(", ");
      gEl.appendChild(emitsText);

      viewport.appendChild(gEl);
      this.nodeElements.set(node.id, gEl);
    }

    for (const edge of edges) {
      const layoutEdge = g.edge(edge.from, edge.to);
      if (!layoutEdge || !layoutEdge.points) continue;

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const points = layoutEdge.points;
      let d = `M${points[0].x},${points[0].y}`;
      for (let i = 1; i < points.length; i++) {
        d += ` L${points[i].x},${points[i].y}`;
      }
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", edge.matched ? "var(--accent)" : "var(--border-strong)");
      path.setAttribute("stroke-width", edge.matched ? "2.5" : "1.5");
      path.setAttribute("stroke-dasharray", edge.kind === "any" ? "6,4" : "none");
      path.setAttribute("marker-end", "url(#arrowhead)");
      path.setAttribute("class", "edge");
      if (edge.matched) {
        path.setAttribute("filter", "url(#glow)");
      }
      viewport.insertBefore(path, viewport.firstChild);
    }

    for (const edge of edges) {
      const layoutEdge = g.edge(edge.from, edge.to);
      if (!layoutEdge || !layoutEdge.points || layoutEdge.points.length < 2) continue;

      const midIdx = Math.floor(layoutEdge.points.length / 2);
      const mid = layoutEdge.points[midIdx];
      const prev = layoutEdge.points[midIdx - 1];

      const angle = Math.atan2(mid.y - prev.y, mid.x - prev.x);

      const labelG = document.createElementNS("http://www.w3.org/2000/svg", "g");
      const labelBg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      labelBg.setAttribute("rx", "3");
      labelBg.setAttribute("fill", "var(--bg-surface)");
      labelBg.setAttribute("stroke", "var(--border-subtle)");

      const labelText = document.createElementNS("http://www.w3.org/2000/svg", "text");
      labelText.setAttribute("text-anchor", "middle");
      labelText.setAttribute("font-family", "var(--font-mono)");
      labelText.setAttribute("font-size", "9");
      labelText.setAttribute("fill", "var(--text-secondary)");
      labelText.textContent = edge.signal;

      const textWidth = edge.signal.length * 5.5;
      const textHeight = 14;

      labelBg.setAttribute("x", String(mid.x - textWidth / 2 - 4));
      labelBg.setAttribute("y", String(mid.y - textHeight / 2 - 2));
      labelBg.setAttribute("width", String(textWidth + 8));
      labelBg.setAttribute("height", String(textHeight + 4));

      labelText.setAttribute("x", String(mid.x));
      labelText.setAttribute("y", String(mid.y + 3));

      labelG.appendChild(labelBg);
      labelG.appendChild(labelText);
      viewport.appendChild(labelG);
    }

    this.fitToView();
  }

  updateNodeStatus(stepId: string, status: GraphNode["status"]): void {
    const nodeEl = this.nodeElements.get(stepId);
    if (!nodeEl) return;

    nodeEl.setAttribute("class", `node ${status} ${nodeEl.classList.contains("gate") ? "gate" : ""}`);

    const rect = nodeEl.querySelector(".node-rect");
    if (rect) {
      if (status === "running") {
        rect.setAttribute("filter", "url(#glow)");
      } else {
        rect.removeAttribute("filter");
      }
    }

    const gateIndicator = nodeEl.querySelector(".gate-indicator");
    if (gateIndicator) {
      gateIndicator.setAttribute("class", `gate-indicator ${status}`);
    }
  }

  highlightEdge(from: string, to: string, signal: string, matched: boolean): void {
    if (!this.svg) return;
    const edges = this.svg.querySelectorAll(".edge");
    edges.forEach((edgeEl) => {
      const d = edgeEl.getAttribute("d");
      if (d && this.edgeMatches(from, to, d)) {
        edgeEl.setAttribute("stroke", matched ? "var(--accent)" : "var(--border-strong)");
        edgeEl.setAttribute("stroke-width", matched ? "2.5" : "1.5");
        if (matched) {
          edgeEl.setAttribute("filter", "url(#glow)");
          setTimeout(() => {
            edgeEl.removeAttribute("filter");
          }, 500);
        }
      }
    });
  }

  private edgeMatches(from: string, to: string, d: string): boolean {
    return true;
  }

  setActiveNode(stepId: string): void {
    this.nodeElements.forEach((el, id) => {
      el.classList.toggle("active", id === stepId);
    });
  }

  fitToView(): void {
    if (!this.svg || !this.container) return;
    const viewport = this.svg.querySelector(".viewport");
    if (!viewport) return;

    const bbox = (viewport as SVGGElement).getBBox();
    const padding = 40;
    const containerRect = this.container.getBoundingClientRect();
    const scaleX = (containerRect.width - padding * 2) / bbox.width;
    const scaleY = (containerRect.height - padding * 2) / bbox.height;
    const scale = Math.min(scaleX, scaleY, 2);

    this.zoom = scale;
    this.panX = -bbox.x * scale + (containerRect.width - bbox.width * scale) / 2;
    this.panY = -bbox.y * scale + (containerRect.height - bbox.height * scale) / 2;
    this.applyTransform();
  }

  private applyTransform(): void {
    const viewport = this.svg?.querySelector(".viewport");
    if (viewport) {
      (viewport as SVGGElement).setAttribute(
        "transform",
        `translate(${this.panX}, ${this.panY}) scale(${this.zoom})`
      );
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (!this.svg || !this.container) return;

    const rect = this.container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.min(Math.max(this.zoom * zoomFactor, 0.2), 3);

    const svgPoint = this.svg.createSVGPoint();
    svgPoint.x = mouseX;
    svgPoint.y = mouseY;
    const transformed = svgPoint.matrixTransform(
      (this.svg.querySelector(".viewport") as SVGGElement).getScreenCTM()?.inverse()
    );

    this.panX = mouseX - transformed.x * newZoom;
    this.panY = mouseY - transformed.y * newZoom;
    this.zoom = newZoom;
    this.applyTransform();
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    if ((e.target as Element).closest(".node")) return;
    this.isPanning = true;
    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;
    this.svg?.style.setProperty("cursor", "grabbing");
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.isPanning) return;
    const dx = e.clientX - this.lastMouseX;
    const dy = e.clientY - this.lastMouseY;
    this.panX += dx;
    this.panY += dy;
    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;
    this.applyTransform();
  }

  private onMouseUp(): void {
    this.isPanning = false;
    this.svg?.style.setProperty("cursor", "grab");
  }

  private onDoubleClick(): void {
    this.fitToView();
  }
}