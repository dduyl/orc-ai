import { describe, it, expect } from "vitest";
import { ConformanceChecker } from "../../../../application/harness/execution/conformance.js";

describe("harness/execution/conformance (ADR-013)", () => {
  it("extracts symbols from contract definitions", () => {
    const contract = `
    export interface UserService {
      getUser(id: string): User;
      deleteUser(id: string): void;
    }
    export function authenticate(token: string): boolean;
    `;
    const symbols = ConformanceChecker.extractContractSymbols(contract);
    expect(symbols).toContain("UserService");
    expect(symbols).toContain("authenticate");
  });

  it("extracts code exports properly", () => {
    const code = `
    export const DEFAULT_TIMEOUT = 5000;
    export function runServer() {}
    export class AppController {}
    `;
    const exports = ConformanceChecker.extractCodeExports(code);
    expect(exports).toContain("DEFAULT_TIMEOUT");
    expect(exports).toContain("runServer");
    expect(exports).toContain("AppController");
  });

  it("extracts test references from imports", () => {
    const testCode = `
    import { describe, it, expect } from "vitest";
    import { UserService, authenticate } from "./auth.js";
    `;
    const refs = ConformanceChecker.extractTestReferences(testCode);
    expect(refs).toContain("UserService");
    expect(refs).toContain("authenticate");
    expect(refs).not.toContain("describe");
  });

  it("detects mismatch when code fails to export contract-required symbol", () => {
    const result = ConformanceChecker.checkArtifactConformance({
      contractSymbols: ["calculateTotal", "applyDiscount"],
      codeFiles: [],
      testFiles: [],
    });

    expect(result.matched).toBe(false);
    expect(result.deviatingProducer).toBe("code");
    expect(result.mismatches.length).toBe(2);
    expect(result.repairFeedback).toContain("CONFORMANCE CHECK FAILURE");
  });
});
