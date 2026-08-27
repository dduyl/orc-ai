import { describe, it, expect } from "vitest";
import { controlPipePath, terminalPipePath, mainPipePath, deriveMcpPort } from "../../../../application/harness/daemon/pipe-name.js";

describe("pipe-name determinism and uniqueness", () => {
  it("determinism: same path produces identical pipe name", () => {
    const path1 = "C:\\projects\\myapp";
    const path2 = "C:\\projects\\myapp";

    const pipe1 = controlPipePath(path1);
    const pipe2 = controlPipePath(path2);

    expect(pipe1).toBe(pipe2);
  });

  it("cross-project uniqueness: different projects produce different pipe names", () => {
    const pipeA = controlPipePath("C:\\projects\\project-a");
    const pipeB = controlPipePath("C:\\projects\\project-b");

    expect(pipeA).not.toBe(pipeB);
  });

  it("path normalization: trailing separator normalizes to same pipe name", () => {
    const base = "C:\\projects\\orc";
    const dotted = "C:\\projects\\orc\\.";

    expect(controlPipePath(base)).toBe(controlPipePath(dotted));
  });

  it("MCP port uniqueness: different projects produce different ports", () => {
    const portA = deriveMcpPort("C:\\projects\\project-a");
    const portB = deriveMcpPort("C:\\projects\\project-b");

    expect(portA).toBeGreaterThanOrEqual(1024);
    expect(portA).toBeLessThanOrEqual(65535);
    expect(portB).toBeGreaterThanOrEqual(1024);
    expect(portB).toBeLessThanOrEqual(65535);
    expect(portA).not.toBe(portB);
  });

  it("terminal pipe includes runId and differs per run", () => {
    const projectDir = "C:\\projects\\myapp";
    const runId1 = "run-001";
    const runId2 = "run-002";

    const term1 = terminalPipePath(projectDir, runId1);
    const term2 = terminalPipePath(projectDir, runId2);

    expect(term1).toContain(runId1);
    expect(term2).toContain(runId2);
    expect(term1).not.toBe(term2);
  });

  it("main pipe path is distinct from control pipe", () => {
    const projectDir = "C:\\projects\\myapp";

    const control = controlPipePath(projectDir);
    const main = mainPipePath(projectDir);

    expect(main).not.toBe(control);
    expect(main).toContain("orc-agent-");
  });
});