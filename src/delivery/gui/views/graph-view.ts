import { GraphCanvas } from "../graph-canvas.js";
import { buildGraphData } from "../../../core/workflow-graph.js";
import type { WorkflowGraphData, SignalEvent } from "../../../core/workflow-graph.js";
import type { WorkflowDefinition } from "../../../core/schemas.js";
import type { StepStatusRecord } from "../../../application/harness/persistence/Tracker.js";
import { api } from "../api.js";

export class GraphView {
  public canvas: GraphCanvas;
  private container: HTMLElement | null = null;
  private workflow: WorkflowDefinition | null = null;
  private stepStatus: StepStatusRecord[] = [];

  constructor() {
    this.canvas = new GraphCanvas({
      onNodeClick: (stepId) => this.onNodeClick(stepId),
    });
  }

  mount(container: HTMLElement): void {
    this.container = container;
    container.innerHTML = `
      <div class="graph-header">
        <h3 class="section-title">Signal Graph</h3>
        <button id="graph-fit" class="btn" title="Fit to view">⟲ Fit</button>
      </div>
      <div id="graph-canvas" class="graph-canvas"></div>
    `;

    const canvasContainer = container.querySelector("#graph-canvas") as HTMLElement;
    const fitBtn = container.querySelector("#graph-fit") as HTMLButtonElement;
    fitBtn?.addEventListener("click", () => this.canvas.fitToView());

    this.canvas.mount(canvasContainer);
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
  }

  private onNodeClick(stepId: string): void {
    api.switchStep(stepId).catch(() => {});
  }
}