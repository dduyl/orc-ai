import { GraphCanvas } from "../graph-canvas.js";
import { buildGraphData } from "../../../core/workflow-graph.js";
import type { WorkflowGraphData, SignalEvent } from "../../../core/workflow-graph.js";
import type { WorkflowDefinition } from "../../../core/schemas.js";
import type { StepStatusRecord } from "../../../application/harness/persistence/Tracker.js";
import { api } from "../api.js";

export interface GraphViewCallbacks {
  onStepClick?: (stepId: string) => void;
}

export class GraphView {
  public canvas: GraphCanvas;
  private container: HTMLElement | null = null;
  private workflow: WorkflowDefinition | null = null;
  private stepStatus: StepStatusRecord[] = [];
  private callbacks: GraphViewCallbacks;
  private zoomLabel: HTMLElement | null = null;
  private hint: HTMLElement | null = null;

  constructor(callbacks: GraphViewCallbacks = {}) {
    this.callbacks = callbacks;
    this.canvas = new GraphCanvas({
      onNodeClick: (stepId) => this.onNodeClick(stepId),
    });
  }

  mount(container: HTMLElement): void {
    this.container = container;
    container.innerHTML = `
      <div class="graph-header">
        <h3 class="section-title">Signal Graph</h3>
        <div class="graph-zoom-controls">
          <button id="graph-zoom-out" class="btn btn-icon" title="Zoom out (−)">−</button>
          <span id="graph-zoom-level" class="graph-zoom-level">100%</span>
          <button id="graph-zoom-in" class="btn btn-icon" title="Zoom in (+)">+</button>
          <button id="graph-fit" class="btn" title="Fit to view (Esc)">⟲ Fit</button>
        </div>
      </div>
      <div id="graph-canvas" class="graph-canvas">
        <div class="graph-hint" id="graph-hint">Scroll to zoom · Drag to pan · Double-click to fit</div>
      </div>
    `;

    const canvasContainer = container.querySelector("#graph-canvas") as HTMLElement;
    const zoomInBtn = container.querySelector("#graph-zoom-in") as HTMLButtonElement;
    const zoomOutBtn = container.querySelector("#graph-zoom-out") as HTMLButtonElement;
    const fitBtn = container.querySelector("#graph-fit") as HTMLButtonElement;
    this.zoomLabel = container.querySelector("#graph-zoom-level") as HTMLElement;
    this.hint = container.querySelector("#graph-hint") as HTMLElement;

    zoomInBtn?.addEventListener("click", () => { this.canvas.zoomIn(); this.updateZoomLabel(); });
    zoomOutBtn?.addEventListener("click", () => { this.canvas.zoomOut(); this.updateZoomLabel(); });
    fitBtn?.addEventListener("click", () => { this.canvas.fitToView(); this.updateZoomLabel(); });

    this.canvas.mount(canvasContainer);

    // Fade hint on first interaction
    const fadeHint = () => {
      this.hint?.classList.add("fading");
      canvasContainer.removeEventListener("wheel", fadeHint);
      canvasContainer.removeEventListener("mousedown", fadeHint);
    };
    canvasContainer.addEventListener("wheel", fadeHint, { once: true });
    canvasContainer.addEventListener("mousedown", fadeHint, { once: true });
    // Auto-fade after 4s
    setTimeout(() => this.hint?.classList.add("fading"), 4000);
  }

  private updateZoomLabel(): void {
    if (this.zoomLabel) {
      this.zoomLabel.textContent = `${Math.round(this.canvas.getZoom() * 100)}%`;
    }
  }

  unmount(): void {
    this.canvas.unmount();
    this.container = null;
    this.workflow = null;
    this.stepStatus = [];
  }

  init(workflow: WorkflowDefinition): void {
    this.workflow = workflow;
    this.stepStatus = [];
    this.renderGraph();
  }

  setStepStatus(status: StepStatusRecord[]): void {
    this.stepStatus = status;
    for (const step of status) {
      this.canvas.updateNodeStatus(step.stepId, step.status);
    }
    this.updateActiveNode();
  }

  onSignalEmitted(event: SignalEvent): void {
    if (event.type === "emission" && event.signal && event.toStep) {
      this.canvas.highlightEdge(event.stepId, event.toStep, event.signal, true);
    }
  }

  onEdgeMatched(event: SignalEvent): void {
    if (event.type === "edge_match" && event.signal && (event as any).fromStep && (event as any).toStep) {
      this.canvas.highlightEdge((event as any).fromStep, (event as any).toStep, event.signal, true);
    }
  }

  onStepActivated(stepId: string): void {
    this.canvas.setActiveNode(stepId);
  }

  setLoopCount(stepId: string, count: number): void {
    this.canvas.setLoopCount(stepId, count);
  }

  private renderGraph(): void {
    if (!this.workflow) return;
    const graphData = buildGraphData(this.workflow, this.stepStatus);
    this.canvas.render(graphData);
  }

  private updateActiveNode(): void {
    if (this.stepStatus.length > 0) {
      const running = this.stepStatus.find(s => s.status === "running");
      if (running) {
        this.canvas.setActiveNode(running.stepId);
      }
    }
  }

  fitToView(): void {
    this.canvas.fitToView();
    this.updateZoomLabel();
  }

  private onNodeClick(stepId: string): void {
    api.switchStep(stepId).catch(() => {});
    this.callbacks.onStepClick?.(stepId);
  }
}