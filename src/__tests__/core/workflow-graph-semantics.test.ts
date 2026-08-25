// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildGraphData } from "../../core/workflow-graph.js";
import { escapeHtml } from "../../delivery/gui/html.js";

function makeWorkflow(steps: any[]): any {
  return { version: 1, workflow: { id: "wf", name: "WF", steps, completion: "done" } };
}

const statusOf = (stepId: string, status: "pending" | "running" | "completed" | "failed", error?: string) => ({
  stepId,
  agent: null,
  task: null,
  signals: [],
  status,
  startedAt: null,
  completedAt: null,
  duration: null,
  error: error ?? null,
  quota: null,
});

describe("buildGraphData semantics", () => {
  it("populates gate fields for script steps from tracker records", () => {
    const wf = makeWorkflow([
      {
        id: "validate",
        type: "script",
        run: 'cmd "validate"',
        emits: [
          { name: "sig_pass", description: "pass" },
          { name: "sig_fail", description: "fail" },
        ],
        on: ["code.sig_done"],
      },
    ]);
    const graph = buildGraphData(wf, [statusOf("validate", "failed", "3 tests failed")]);
    const node = graph.nodes[0];
    expect(node.isGate).toBe(true);
    expect(node.exitCode).toBe(1);
    expect(node.output).toBe("3 tests failed");
    expect(node.gate).toBe('cmd "validate"');
  });

  it("never sets loopCount statically (loop badges come from live events)", () => {
    const wf = makeWorkflow([
      {
        id: "a",
        type: "agent",
        emits: [{ name: "sig_done", description: "" }],
        on: ["__start__"],
      },
    ]);
    const graph = buildGraphData(wf, [{ ...statusOf("a", "completed"), quota: { kind: "quota" as const, message: "quota", resetAtMs: 1 } }]);
    expect(graph.nodes[0].loopCount).toBeUndefined();
  });

  it("labels edge kinds per reference when both on and any are present", () => {
    const wf = makeWorkflow([
      {
        id: "b",
        type: "agent",
        emits: [{ name: "sig_done", description: "" }],
        on: ["x.sig_a"],
        any: ["y.sig_b"],
      },
    ]);
    const graph = buildGraphData(wf, []);
    const kinds = Object.fromEntries(graph.edges.map(e => [e.from, e.kind]));
    expect(kinds["x"]).toBe("on");
    expect(kinds["y"]).toBe("any");
  });
});

describe("escapeHtml", () => {
  it("neutralizes markup injection payloads", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
  });

  it("escapes ampersands, angle brackets, quotes and apostrophes", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("leaves plain text untouched", () => {
    expect(escapeHtml("spec.sig_done (2s)")).toBe("spec.sig_done (2s)");
  });
});
