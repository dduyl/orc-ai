// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Launcher lifecycle + param collection. The launcher imports `api` from
 * gui/api.js (window.electronAPI), so the stub must be installed before load.
 */
vi.mock("../../../delivery/gui/terminal.js", () => ({
  createTerminal: () => ({ term: { write: vi.fn(), reset: vi.fn(), focus: vi.fn(), onData: vi.fn(), cols: 80, rows: 24 }, fit: vi.fn() }),
}));

const DOM = `
<div id="app">
  <button id="btn-new-run">+ New Run</button>
</div>
`;

function makeApiStub() {
  return {
    listWorkflows: vi.fn(async () => [
      { id: "wf_inputs", name: "With Inputs", definition: { workflow: {
        id: "wf_inputs", name: "With Inputs",
        inputs: {
          target: { type: "string", default: "./src", description: "target dir" },
          count: { type: "integer", default: 3 },
          verbose: { type: "boolean", default: false },
          mode: { type: "string", enum: ["fast", "slow"], default: "fast" },
        },
        steps: [], completion: "",
      } } },
      { id: "wf_plain", name: "Plain", definition: { workflow: { id: "wf_plain", name: "Plain", steps: [], completion: "" } } },
    ]),
    startWorkflow: vi.fn(async () => ({ runId: "r-1" })),
    switchStep: vi.fn(async () => {}),
    listSteps: vi.fn(async () => []),
    getStepOutput: vi.fn(async () => ""),
    getRunStatus: vi.fn(async () => null),
  };
}

async function loadLauncher() {
  vi.resetModules();
  document.body.innerHTML = DOM;
  (window as unknown as { electronAPI: unknown }).electronAPI = makeApiStub();
  const mod = await import("../../../delivery/gui/workflow-launcher.js");
  return new mod.WorkflowLauncher();
}

function q(sel: string): HTMLElement {
  const el = document.querySelector(sel);
  if (!(el instanceof HTMLElement)) throw new Error(`missing ${sel}`);
  return el;
}

describe("workflow launcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("double open leaves exactly one overlay in the DOM", async () => {
    const launcher = await loadLauncher();
    await Promise.all([launcher.open(), launcher.open()]);
    expect(document.querySelectorAll(".workflow-launcher-overlay")).toHaveLength(1);
  });

  it("close removes the Escape handler; later Escape does nothing", async () => {
    const launcher = await loadLauncher();
    await launcher.open();
    expect(document.querySelectorAll(".workflow-launcher-overlay")).toHaveLength(1);
    launcher.close();
    vi.advanceTimersByTime(250);
    // No handler should remain: dispatching Escape must not re-add or throw.
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelectorAll(".workflow-launcher-overlay")).toHaveLength(0);
  });

  it("collects typed params without FormData and forwards them to startWorkflow", async () => {
    const launcher = await loadLauncher();
    await launcher.open();
    // wf_inputs is first in the list → params form renders on select change.
    (q("#launcher-workflow") as HTMLSelectElement).dispatchEvent(new Event("change"));
    (q('[data-param="count"]') as HTMLInputElement).value = "7";
    (q('[data-param="verbose"]') as HTMLInputElement).checked = true;
    (q('[data-param="mode"]') as HTMLSelectElement).value = "slow";
    (q("#launcher-task") as HTMLTextAreaElement).value = "do the thing";
    (q(".launcher-submit") as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    const api = (window as unknown as { electronAPI: ReturnType<typeof makeApiStub> }).electronAPI;
    expect(api.startWorkflow).toHaveBeenCalledWith(
      expect.any(String),
      "wf_inputs",
      expect.objectContaining({ count: 7, verbose: true, mode: "slow" }),
    );
  });

  it("escapes hostile workflow names in the picker markup", async () => {
    const launcher = await loadLauncher();
    const overlay = document.createElement("div");
    overlay.className = "workflow-launcher-overlay";
    document.body.appendChild(overlay);
    launcher["modal"] = overlay;
    launcher["workflows"] = [
      { id: 'x"><img src=x onerror=alert(1)>', name: "<script>bad</script>", definition: null },
    ];
    launcher["renderModal"](overlay);
    // Correctly escaped markup parses back to the original literal as an
    // attribute value — the injection proof is that the structure survives:
    const options = document.querySelectorAll<HTMLOptionElement>("#launcher-workflow option");
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toBe("<script>bad</script> (x\"><img src=x onerror=alert(1)>)");
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(document.querySelectorAll("script")).toHaveLength(0);
  });
});
