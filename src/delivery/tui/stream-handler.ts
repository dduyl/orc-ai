import type * as blessed from "blessed";
import type { TreePanel } from "./tree.js";
import type { OutputPanel } from "./output.js";
import type { StatusBar } from "./status-bar.js";
import type { StreamEvent } from "../../adapters/stream/types.js";
import { setStreamEventHandler } from "../../adapters/stream/emitter.js";
import type { TreeNodeData } from "./tree.js";

export function bindStreamEvents(
  tree: TreePanel,
  output: OutputPanel,
  status: StatusBar,
  screen: blessed.Widgets.Screen,
  counters: { stepActiveCount: number; stepTotalCount: number },
): void {
  setStreamEventHandler((event: StreamEvent) => {
    if (event.type === "step_start") {
      counters.stepActiveCount++;
      counters.stepTotalCount = Math.max(counters.stepTotalCount, counters.stepActiveCount);
      tree.addNode("adapter", event.part.id, event.part.snapshot.slice(0, 40));
      tree.updateStatus(event.part.id, "running");
      status.updateSteps(counters.stepActiveCount, counters.stepTotalCount);
      status.updateStatus(`Running: ${event.part.id}`);
      screen.render();
    } else if (event.type === "text") {
      tree.updateOutput(event.part.id, event.part.text);
      if (tree.getSelectedId() === event.part.id && !tree.isRootSelected()) {
        output.showHistory(event.part.text);
        screen.render();
      }
    } else if (event.type === "step_finish") {
      counters.stepActiveCount = Math.max(0, counters.stepActiveCount - 1);
      const stepStatus: TreeNodeData["status"] = event.part.reason === "stop" ? "completed"
        : event.part.reason === "build_failed" ? "failed"
        : event.part.reason === "error" || event.part.reason === "max_retries" ? "failed"
        : event.part.reason === "budget_exceeded" || event.part.reason === "loop_detected" ? "failed"
        : "failed";
      tree.updateStatus(event.part.id, stepStatus);
      status.updateSteps(counters.stepActiveCount, counters.stepTotalCount);
      status.updateStatus(stepStatus === "completed" ? "Step completed" : `Step ${stepStatus}`);
      screen.render();
    }
  });
}
